import {
  enqueueJob,
  expediteJobInPgTransaction,
  registerJobWorker,
  startJobQueue,
} from "@understandproof/db";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import {
  PullRequestJobPayloadSchema,
  type PullRequestJobPayload,
} from "./schemas";

export const GITHUB_INGEST_QUEUE = "github.ingest-pr" as const;

export interface PullRequestJobPublisher {
  publish(payload: PullRequestJobPayload): Promise<string>;
  publishInTransaction(
    client: PoolClient,
    payload: PullRequestJobPayload,
  ): Promise<string | null>;
}

/** Publishes through an already-owned pg-boss runtime without starting a
 * second supervisor in a request process. */
export class PgBossPullRequestPublisher implements PullRequestJobPublisher {
  constructor(private readonly boss: PgBoss) {}

  async publish(rawPayload: PullRequestJobPayload): Promise<string> {
    const payload = PullRequestJobPayloadSchema.parse(rawPayload);
    return enqueueJob(this.boss, GITHUB_INGEST_QUEUE, payload);
  }

  async publishInTransaction(
    client: PoolClient,
    rawPayload: PullRequestJobPayload,
  ): Promise<string | null> {
    const payload = PullRequestJobPayloadSchema.parse(rawPayload);
    return expediteJobInPgTransaction(
      this.boss,
      client,
      GITHUB_INGEST_QUEUE,
      payload,
    );
  }
}

export class PgBossPullRequestQueue implements PullRequestJobPublisher {
  private boss: PgBoss | undefined;

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    if (this.boss) return;
    this.boss = await startJobQueue({
      connectionString: this.connectionString,
      schema: "pgboss",
      application_name: "slopproof",
    });
  }

  async publish(rawPayload: PullRequestJobPayload): Promise<string> {
    const payload = PullRequestJobPayloadSchema.parse(rawPayload);
    await this.start();
    return enqueueJob(this.requireBoss(), GITHUB_INGEST_QUEUE, payload);
  }

  async publishInTransaction(
    client: PoolClient,
    rawPayload: PullRequestJobPayload,
  ): Promise<string | null> {
    const payload = PullRequestJobPayloadSchema.parse(rawPayload);
    await this.start();
    return expediteJobInPgTransaction(
      this.requireBoss(),
      client,
      GITHUB_INGEST_QUEUE,
      payload,
    );
  }

  async work(
    handler: (payload: PullRequestJobPayload) => Promise<void>,
  ): Promise<string> {
    await this.start();
    return registerJobWorker(
      this.requireBoss(),
      GITHUB_INGEST_QUEUE,
      async (job) => {
        if (job.data.eventName !== "pull_request") {
          throw new Error(
            "This webhook-only queue consumer cannot process a PR refresh",
          );
        }
        await handler(job.data);
      },
    );
  }

  async stop(): Promise<void> {
    if (!this.boss) return;
    await this.boss.stop({ graceful: true, timeout: 5_000 });
    this.boss = undefined;
  }

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error("GitHub queue has not been started");
    return this.boss;
  }
}
