import {
  enqueueJob,
  registerJobWorker,
  startJobQueue,
  type JobPayload,
} from "@slopproof/db";
import type { PgBoss } from "pg-boss";
import {
  PullRequestJobPayloadSchema,
  type PullRequestJobPayload,
} from "./schemas";

export const GITHUB_INGEST_QUEUE = "github.ingest-pr" as const;

export interface PullRequestJobPublisher {
  publish(payload: PullRequestJobPayload): Promise<string>;
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

  async work(
    handler: (payload: JobPayload<"github.ingest-pr">) => Promise<void>,
  ): Promise<string> {
    await this.start();
    return registerJobWorker(
      this.requireBoss(),
      GITHUB_INGEST_QUEUE,
      async (job) => handler(job.data),
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
