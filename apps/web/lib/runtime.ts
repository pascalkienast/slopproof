import { loadWebConfig } from "@slopproof/config";
import {
  connectDatabase,
  startJobQueue,
  type DatabaseConnection,
} from "@slopproof/db";
import { createLogger } from "@slopproof/observability";
import { PgBossPullRequestPublisher } from "@slopproof/github";
import { S3EvidenceStore } from "@slopproof/storage";
import type { PgBoss } from "pg-boss";

export type WebRuntime = {
  config: ReturnType<typeof loadWebConfig>;
  database: DatabaseConnection;
  githubQueue: PgBossPullRequestPublisher;
  jobQueue: PgBoss;
  storage: S3EvidenceStore;
};

const globalRuntime = globalThis as typeof globalThis & {
  slopproofWebRuntime?: Promise<WebRuntime>;
};

async function createRuntime(): Promise<WebRuntime> {
  const config = loadWebConfig();
  const log = createLogger(
    { service: "web", version: "0.1.0" },
    config.LOG_LEVEL,
  );
  const database = connectDatabase(config.DATABASE_URL);
  let jobQueue: PgBoss | undefined;
  let storage: S3EvidenceStore | undefined;
  try {
    jobQueue = await startJobQueue(config.DATABASE_URL, (error) => {
      log.error(
        { errorClass: error instanceof Error ? error.name : "UnknownError" },
        "queue.error",
      );
    });
    const githubQueue = new PgBossPullRequestPublisher(jobQueue);
    storage = new S3EvidenceStore({
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      controlEndpoint: config.S3_CONTROL_ENDPOINT,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: true,
    });
    return { config, database, githubQueue, jobQueue, storage };
  } catch (error) {
    storage?.destroy();
    if (jobQueue) {
      await jobQueue
        .stop({ graceful: false, timeout: 1_000 })
        .catch(() => undefined);
    }
    await database.close().catch(() => undefined);
    throw error;
  }
}

export function createRetryableRuntimeGetter<T>(
  factory: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      const candidate = factory();
      pending = candidate;
      void candidate.catch(() => {
        if (pending === candidate) pending = undefined;
      });
    }
    return pending;
  };
}

const loadRuntime = createRetryableRuntimeGetter(createRuntime);

export function getWebRuntime(): Promise<WebRuntime> {
  globalRuntime.slopproofWebRuntime ??= loadRuntime();
  const candidate = globalRuntime.slopproofWebRuntime;
  void candidate.catch(() => {
    if (globalRuntime.slopproofWebRuntime === candidate) {
      delete globalRuntime.slopproofWebRuntime;
    }
  });
  return candidate;
}
