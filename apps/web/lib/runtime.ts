import { loadWebConfig } from "@slopproof/config";
import {
  connectDatabase,
  startJobQueue,
  type DatabaseConnection,
} from "@slopproof/db";
import { PgBossPullRequestQueue } from "@slopproof/github";
import { S3EvidenceStore } from "@slopproof/storage";
import type { PgBoss } from "pg-boss";

export type WebRuntime = {
  config: ReturnType<typeof loadWebConfig>;
  database: DatabaseConnection;
  githubQueue: PgBossPullRequestQueue;
  jobQueue: PgBoss;
  storage: S3EvidenceStore;
};

const globalRuntime = globalThis as typeof globalThis & {
  slopproofWebRuntime?: Promise<WebRuntime>;
};

async function createRuntime(): Promise<WebRuntime> {
  const config = loadWebConfig();
  const database = connectDatabase(config.DATABASE_URL);
  const githubQueue = new PgBossPullRequestQueue(config.DATABASE_URL);
  const jobQueue = await startJobQueue(config.DATABASE_URL);
  const storage = new S3EvidenceStore({
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    controlEndpoint: config.S3_CONTROL_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  });
  await githubQueue.start();
  return { config, database, githubQueue, jobQueue, storage };
}

export function getWebRuntime(): Promise<WebRuntime> {
  globalRuntime.slopproofWebRuntime ??= createRuntime();
  return globalRuntime.slopproofWebRuntime;
}
