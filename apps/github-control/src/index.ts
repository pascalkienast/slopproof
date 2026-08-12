import { loadGithubControlConfig } from "@slopproof/config";
import {
  connectDatabase,
  PgBossGithubCheckOutbox,
  registerJobWorker,
  replayDueGithubCheckSyncs,
  startJobQueue,
} from "@slopproof/db";
import {
  OctokitCheckRunAdapter,
  OctokitPullRequestPort,
  RepositoryInstallationTokenCache,
} from "@slopproof/github";
import { createLogger } from "@slopproof/observability";
import type { PgBoss } from "pg-boss";
import {
  handleGithubCheckReconcileJob,
  handleGithubPullRequestJob,
  handleGithubRefreshPullRequestJob,
  sweepDueGithubPullRequestDeliveries,
  sweepDueGithubPullRequestRefreshes,
  type GithubControlDependencies,
} from "./control";
import { validateGithubControlStartup } from "./startup";

const config = loadGithubControlConfig();
const log = createLogger(
  { service: "github-control", version: "0.1.0" },
  config.LOG_LEVEL,
);
const database = connectDatabase(config.DATABASE_URL);
let queue: PgBoss | undefined;
let retrySweepTimer: NodeJS.Timeout | undefined;
let retrySweepRunning = false;
let shuttingDown = false;

const RETRY_SWEEP_INTERVAL_MS = 5_000;

async function start(): Promise<void> {
  // Validate the complete local App-key trust boundary before starting pg-boss
  // or registering a worker. A malformed key therefore cannot leave a live
  // consumer behind, and startup cleanup only needs to close the DB pool.
  const appMaterial = await validateGithubControlStartup(config);
  const activeQueue = await startJobQueue(config.DATABASE_URL, (error) => {
    log.error(
      { errorClass: error instanceof Error ? error.name : "UnknownError" },
      "queue.error",
    );
  });
  queue = activeQueue;
  const dependencies: GithubControlDependencies = {
    database,
    queue: activeQueue,
    appBaseUrl: config.APP_BASE_URL,
    adapter: config.GITHUB_ADAPTER,
  };

  if (config.GITHUB_ADAPTER === "octokit") {
    if (!appMaterial) {
      throw new Error("GitHub App control material is not configured");
    }
    const tokens = new RepositoryInstallationTokenCache({
      appId: appMaterial.appId,
      privateKeyPath: appMaterial.privateKeyPath,
    });
    const pullRequests = new OctokitPullRequestPort(tokens);
    dependencies.pullRequests = pullRequests;
    dependencies.checkRuns = new OctokitCheckRunAdapter(tokens, pullRequests);
  }

  await registerJobWorker(
    activeQueue,
    "github.ingest-pr",
    async (job) => {
      if (job.data.eventName === "pull_request_refresh") {
        await handleGithubRefreshPullRequestJob(job.data, dependencies);
      } else {
        await handleGithubPullRequestJob(job.data, dependencies);
      }
    },
    { heartbeatRefreshSeconds: 10 },
  );
  await registerJobWorker(
    activeQueue,
    "github.reconcile-check",
    async (job) => {
      await handleGithubCheckReconcileJob(job.data, dependencies);
    },
    { heartbeatRefreshSeconds: 10 },
  );

  const retryOutbox = new PgBossGithubCheckOutbox(activeQueue);
  const sweepRetries = async (): Promise<void> => {
    if (retrySweepRunning || shuttingDown) return;
    retrySweepRunning = true;
    try {
      const result = await replayDueGithubCheckSyncs(
        database.pool,
        retryOutbox,
      );
      if (result.published > 0) {
        log.info(result, "github_control.retry_sweep");
      }
      const pullRequestDeliveries =
        await sweepDueGithubPullRequestDeliveries(dependencies);
      if (pullRequestDeliveries.published > 0) {
        log.info(
          pullRequestDeliveries,
          "github_control.pull_request_delivery_sweep",
        );
      }
      const pullRequestRefresh =
        await sweepDueGithubPullRequestRefreshes(dependencies);
      if (pullRequestRefresh.published > 0) {
        log.info(
          pullRequestRefresh,
          "github_control.pull_request_refresh_sweep",
        );
      }
    } finally {
      retrySweepRunning = false;
    }
  };
  await sweepRetries();
  retrySweepTimer = setInterval(() => {
    void sweepRetries().catch((error: unknown) => {
      log.error(
        { errorClass: error instanceof Error ? error.name : "UnknownError" },
        "github_control.retry_sweep_failed",
      );
    });
  }, RETRY_SWEEP_INTERVAL_MS);
  retrySweepTimer.unref();

  log.info({ adapter: config.GITHUB_ADAPTER }, "github_control.ready");
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "github_control.stopping");
  if (retrySweepTimer) clearInterval(retrySweepTimer);
  if (queue) await queue.stop({ graceful: true, timeout: 5_000 });
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log.error(
          { errorClass: error instanceof Error ? error.name : "UnknownError" },
          "github_control.shutdown_failed",
        );
        process.exit(1);
      });
  });
}

start().catch((error: unknown) => {
  log.fatal(
    { errorClass: error instanceof Error ? error.name : "UnknownError" },
    "github_control.start_failed",
  );
  void (async () => {
    if (retrySweepTimer) clearInterval(retrySweepTimer);
    if (queue) {
      await queue
        .stop({ graceful: false, timeout: 1_000 })
        .catch(() => undefined);
    }
    await database.close().catch(() => undefined);
    process.exit(1);
  })();
});
