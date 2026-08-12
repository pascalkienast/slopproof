import {
  expediteJobInPgTransaction,
  getJobSingletonKey,
  scheduleJobInPgTransaction,
  type JobPayload,
} from "@slopproof/db";
import type { PgBoss } from "pg-boss";
import type { Db } from "pg-boss";
import type { PoolClient } from "pg";
import type {
  SemanticGenerationJobName,
  SemanticTransactionalScheduler,
} from "./semantic-generation-contracts";

export class PgBossSemanticTransactionalScheduler implements SemanticTransactionalScheduler {
  constructor(private readonly queue: PgBoss) {}

  async schedule<Name extends SemanticGenerationJobName>(
    client: PoolClient,
    name: Name,
    payload: JobPayload<Name>,
    startAfter?: Date,
  ): Promise<void> {
    if (startAfter === undefined) {
      await expediteJobInPgTransaction(this.queue, client, name, payload);
    } else {
      await scheduleJobInPgTransaction(
        this.queue,
        client,
        name,
        payload,
        startAfter,
      );
    }
  }

  async recoverOrExpedite<Name extends SemanticGenerationJobName>(
    client: PoolClient,
    name: Name,
    payload: JobPayload<Name>,
    startAfter?: Date,
  ): Promise<void> {
    const db: Db = {
      async executeSql(text, values = []) {
        const result = await client.query(text, values);
        return { rows: result.rows };
      },
    };
    const singletonKey = getJobSingletonKey(name, payload);
    const jobs = await this.queue.findJobs<JobPayload<Name>>(name, {
      key: singletonKey,
      db,
    });
    const live = jobs.filter((job) =>
      ["created", "retry", "active"].includes(job.state),
    );
    const failed = jobs.filter((job) => job.state === "failed");
    if (live.length > 1 || failed.length > 1) {
      throw new Error(`Queue has conflicting ${name} singleton jobs`);
    }
    if (failed[0] !== undefined) {
      const due =
        startAfter === undefined || startAfter.getTime() <= Date.now();
      if (!due) {
        const updated = await this.queue.update(name, payload, {
          id: failed[0].id,
          startAfter,
          db,
        });
        if (updated.updated !== 1) {
          throw new Error(`Queue could not defer failed ${name} singleton job`);
        }
        return;
      }
      await this.queue.retry(name, failed[0].id, { db });
      const updated = await this.queue.update(name, payload, {
        id: failed[0].id,
        startAfter: new Date(),
        db,
      });
      if (updated.updated !== 1) {
        throw new Error(`Queue could not recover failed ${name} singleton job`);
      }
      return;
    }
    if (live[0] !== undefined) {
      if (live[0].state === "active") return;
      const updated = await this.queue.update(name, payload, {
        id: live[0].id,
        ...(startAfter === undefined ? {} : { startAfter }),
        db,
      });
      if (updated.updated !== 1) {
        throw new Error(`Queue could not update pending ${name} singleton job`);
      }
      return;
    }
    if (startAfter !== undefined) {
      await scheduleJobInPgTransaction(
        this.queue,
        client,
        name,
        payload,
        startAfter,
      );
      return;
    }
    await this.schedule(client, name, payload);
  }

  async scheduleAttemptExpiry(
    client: PoolClient,
    payload: JobPayload<"proof.expire-attempt">,
    startAfter: Date,
  ): Promise<void> {
    await scheduleJobInPgTransaction(
      this.queue,
      client,
      "proof.expire-attempt",
      payload,
      startAfter,
    );
  }
}
