import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { loadWorkerConfig } from "@slopproof/config";
import {
  connectDatabase,
  enqueueJob,
  enqueueJobInPgTransaction,
  expediteJobInPgTransaction,
  registerJobWorker,
  startJobQueue,
} from "@slopproof/db";
import {
  FakeGithubCheckAdapter,
  PgBossPullRequestQueue,
  processPullRequestJob,
} from "@slopproof/github";
import { createLogger } from "@slopproof/observability";
import {
  LocalFakeMultimodalJudgeProvider,
  LocalFakeTranscriptionProvider,
  PayloadCipher,
} from "@slopproof/providers";
import { S3EvidenceStore } from "@slopproof/storage";
import type { PgBoss } from "pg-boss";
import {
  expireAttempt,
  scheduleOutstandingAttemptExpirations,
} from "./attempt-expiry";
import { EncryptedFfmpegFrameSelectionAdapter } from "./frame-selection";
import { finalizeMediaUpload } from "./media-finalize";
import {
  decodeProviderPayloadKeyBase64,
  registerProviderPipelineWorkers,
} from "./provider-pipeline";
import { PostgresProviderPipelineRepository } from "./provider-pipeline-repository";
import {
  LocalFakeRevisionPatchSource,
  prepareRevision,
} from "./revision-preparation";
import { createPostgresRetentionService } from "./retention";
import { handleReviewContextRequest } from "./review-context";
import { handleReviewEvidenceRequest } from "./review-stream";

const config = loadWorkerConfig();
const log = createLogger(
  { service: "worker", version: "0.1.0" },
  config.LOG_LEVEL,
);
const database = connectDatabase(config.DATABASE_URL);
const githubQueue = new PgBossPullRequestQueue(config.DATABASE_URL);
const storage = new S3EvidenceStore({
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  controlEndpoint: config.S3_CONTROL_ENDPOINT,
  publicEndpoint: config.S3_CONTROL_ENDPOINT,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  forcePathStyle: true,
});
let jobQueue: PgBoss | undefined;
let attemptExpiryTimer: NodeJS.Timeout | undefined;
let retentionAuditTimer: NodeJS.Timeout | undefined;
let privateKeyPath: string | undefined;
let providerPayloadCipher: PayloadCipher | undefined;
let ready = false;
let shuttingDown = false;

const server = createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error: unknown) => {
    log.error(
      { errorClass: error instanceof Error ? error.name : "UnknownError" },
      "worker.http_failed",
    );
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(500, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ error: "internal_error" }));
  });
});

async function handleHttpRequest(
  request: Parameters<typeof handleReviewEvidenceRequest>[0],
  response: Parameters<typeof handleReviewEvidenceRequest>[1],
): Promise<void> {
  if (request.url === "/healthz") {
    response.writeHead(ready ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({ status: ready ? "ok" : "starting", service: "worker" }),
    );
    return;
  }

  if (
    ready &&
    providerPayloadCipher &&
    (await handleReviewContextRequest(request, response, {
      database,
      storage,
      payloadCipher: providerPayloadCipher,
      capabilitySecret: config.WORKER_INTERNAL_SECRET,
    }))
  ) {
    return;
  }

  if (
    ready &&
    privateKeyPath &&
    (await handleReviewEvidenceRequest(request, response, {
      database,
      storage,
      privateKeyPath,
      capabilitySecret: config.WORKER_INTERNAL_SECRET,
      onFailure: (failure) => {
        log.warn(failure, "worker.review_evidence_failed");
      },
    }))
  ) {
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

async function start(): Promise<void> {
  if (config.GITHUB_ADAPTER !== "fake") {
    throw new Error(
      "Only the local fake GitHub adapter is enabled in this MVP build",
    );
  }

  const checks = new FakeGithubCheckAdapter(database.pool, config.APP_BASE_URL);
  if (!config.KEY_WRAPPING_PRIVATE_KEY_PATH) {
    throw new Error("The local worker requires a private wrapping key path");
  }
  const activePrivateKeyPath = config.KEY_WRAPPING_PRIVATE_KEY_PATH;
  privateKeyPath = activePrivateKeyPath;
  if (
    config.TRANSCRIPTION_PROVIDER !== "fake" ||
    config.MULTIMODAL_JUDGE_PROVIDER !== "fake"
  ) {
    throw new Error(
      "Only local fake media providers are enabled in this MVP build",
    );
  }
  const activeJobQueue = await startJobQueue(config.DATABASE_URL);
  jobQueue = activeJobQueue;
  await registerJobWorker(
    activeJobQueue,
    "analysis.prepare-revision",
    async (job) => {
      await prepareRevision(job.data, {
        pool: database.pool,
        queue: activeJobQueue,
        checks,
        patchSource: new LocalFakeRevisionPatchSource(),
      });
    },
  );
  await registerJobWorker(
    activeJobQueue,
    "proof.expire-attempt",
    async (job) => {
      await expireAttempt(job.data, {
        pool: database.pool,
        storage,
        checks,
      });
    },
  );
  const scheduleAttemptExpirations = async (): Promise<void> => {
    await scheduleOutstandingAttemptExpirations(database.pool, activeJobQueue);
  };
  await scheduleAttemptExpirations();
  attemptExpiryTimer = setInterval(() => {
    void scheduleAttemptExpirations().catch((error: unknown) => {
      log.error(
        { errorClass: error instanceof Error ? error.name : "UnknownError" },
        "attempt.expiry_schedule_failed",
      );
    });
  }, 60_000);
  attemptExpiryTimer.unref();
  await registerJobWorker(
    activeJobQueue,
    "media.finalize-upload",
    async (job) => {
      await finalizeMediaUpload(job.data, {
        database,
        queue: activeJobQueue,
        storage,
        privateKeyPath: activePrivateKeyPath,
        ffprobePath: config.FFPROBE_PATH,
      });
    },
  );
  const providerClock = { now: () => new Date() };
  const providerPayloadKey = decodeProviderPayloadKeyBase64(
    config.PROVIDER_PAYLOAD_KEY_BASE64,
  );
  try {
    const activePayloadCipher = new PayloadCipher(providerPayloadKey);
    await registerProviderPipelineWorkers(activeJobQueue, {
      repository: new PostgresProviderPipelineRepository(database),
      payloadCipher: activePayloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider(providerClock),
      frameSelectionAdapter: new EncryptedFfmpegFrameSelectionAdapter({
        database,
        storage,
        privateKeyPath: activePrivateKeyPath,
        ffmpegPath: config.FFMPEG_PATH,
        payloadCipher: activePayloadCipher,
      }),
      judgeProvider: new LocalFakeMultimodalJudgeProvider(providerClock),
      clock: providerClock,
    });
    providerPayloadCipher = activePayloadCipher;
  } finally {
    providerPayloadKey.fill(0);
  }
  const retention = createPostgresRetentionService({
    database,
    queue: activeJobQueue,
    storage,
  });
  await registerJobWorker(activeJobQueue, "evidence.delete", async (job) => {
    await retention.deleteEvidence(job.data);
  });
  await registerJobWorker(
    activeJobQueue,
    "evidence.audit-retention",
    async (job) => {
      await retention.auditRetention(job.data);
    },
  );
  const enqueueRetentionAudit = async (): Promise<void> => {
    const auditRunId = randomUUID();
    await enqueueJob(activeJobQueue, "evidence.audit-retention", {
      schemaVersion: "1",
      idempotencyKey: `retention-audit:${auditRunId}`,
      auditRunId,
    });
  };
  await enqueueRetentionAudit();
  retentionAuditTimer = setInterval(() => {
    void enqueueRetentionAudit().catch((error: unknown) => {
      log.error(
        { errorClass: error instanceof Error ? error.name : "UnknownError" },
        "retention.audit_enqueue_failed",
      );
    });
  }, 60_000);
  retentionAuditTimer.unref();
  await githubQueue.start();
  await githubQueue.work(async (payload) => {
    await processPullRequestJob(database.pool, checks, payload, {
      publish: (client, analysisPayload) =>
        enqueueJobInPgTransaction(
          activeJobQueue,
          client,
          "analysis.prepare-revision",
          analysisPayload,
        ),
      publishAttemptExpiry: (client, expiryPayload) =>
        expediteJobInPgTransaction(
          activeJobQueue,
          client,
          "proof.expire-attempt",
          expiryPayload,
        ),
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(config.WORKER_PORT, config.WORKER_HOST, resolve);
  });
  ready = true;
  log.info(
    { host: config.WORKER_HOST, port: config.WORKER_PORT },
    "worker.ready",
  );
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  if (attemptExpiryTimer) clearInterval(attemptExpiryTimer);
  if (retentionAuditTimer) clearInterval(retentionAuditTimer);
  log.info({ signal }, "worker.stopping");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await githubQueue.stop();
  if (jobQueue) await jobQueue.stop({ graceful: true, timeout: 5_000 });
  storage.destroy();
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log.error(
          { errorClass: error instanceof Error ? error.name : "UnknownError" },
          "worker.shutdown_failed",
        );
        process.exit(1);
      });
  });
}

start().catch((error: unknown) => {
  log.fatal(
    { errorClass: error instanceof Error ? error.name : "UnknownError" },
    "worker.start_failed",
  );
  process.exitCode = 1;
});
