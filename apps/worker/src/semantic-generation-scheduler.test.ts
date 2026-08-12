import type { JobPayload } from "@slopproof/db";
import type { PgBoss } from "pg-boss";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgBossSemanticTransactionalScheduler } from "./semantic-generation-scheduler";

describe("PgBossSemanticTransactionalScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a new private-expiry singleton at its future deadline", async () => {
    const future = new Date("2026-08-14T00:00:00.000Z");
    const queue = queueFixture([]);
    const scheduler = new PgBossSemanticTransactionalScheduler(queue.instance);

    await scheduler.recoverOrExpedite(
      clientFixture(),
      "semantic.expire-private",
      expiryPayload(),
      future,
    );

    expect(queue.upsert).toHaveBeenCalledWith(
      "semantic.expire-private",
      expiryPayload(),
      expect.objectContaining({
        singletonKey: `learning_bundle_v1:${IDS.artifact}`,
        startAfter: future,
      }),
    );
    expect(queue.retry).not.toHaveBeenCalled();
    expect(queue.update).not.toHaveBeenCalled();
  });

  it("retries a failed singleton only when its deletion deadline is due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:01:00.000Z"));
    const queue = queueFixture([{ id: IDS.job, state: "failed" }]);
    const scheduler = new PgBossSemanticTransactionalScheduler(queue.instance);

    await scheduler.recoverOrExpedite(
      clientFixture(),
      "semantic.expire-private",
      expiryPayload(),
      new Date("2026-08-14T00:00:00.000Z"),
    );

    expect(queue.retry).toHaveBeenCalledWith(
      "semantic.expire-private",
      IDS.job,
      expect.objectContaining({ db: expect.any(Object) }),
    );
    expect(queue.update).toHaveBeenCalledWith(
      "semantic.expire-private",
      expiryPayload(),
      expect.objectContaining({
        id: IDS.job,
        startAfter: new Date("2026-08-14T00:01:00.000Z"),
      }),
    );
  });

  it("preserves a future deadline for failed and pending singletons", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const future = new Date("2026-08-14T00:00:00.000Z");
    for (const state of ["failed", "created"] as const) {
      const queue = queueFixture([{ id: IDS.job, state }]);
      const scheduler = new PgBossSemanticTransactionalScheduler(
        queue.instance,
      );

      await scheduler.recoverOrExpedite(
        clientFixture(),
        "semantic.expire-private",
        expiryPayload(),
        future,
      );

      expect(queue.retry).not.toHaveBeenCalled();
      expect(queue.update).toHaveBeenCalledWith(
        "semantic.expire-private",
        expiryPayload(),
        expect.objectContaining({ id: IDS.job, startAfter: future }),
      );
      expect(queue.upsert).not.toHaveBeenCalled();
    }
  });
});

const IDS = {
  revision: "84000000-0000-4000-8000-000000000001",
  artifact: "84000000-0000-4000-8000-000000000002",
  job: "84000000-0000-4000-8000-000000000003",
} as const;

function expiryPayload(): JobPayload<"semantic.expire-private"> {
  return {
    schemaVersion: "1",
    idempotencyKey: `semantic.expire.private:${IDS.artifact}`,
    revisionId: IDS.revision,
    artifactId: IDS.artifact,
    artifactKind: "learning_bundle_v1",
  };
}

function clientFixture(): PoolClient {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as PoolClient;
}

function queueFixture(jobs: Array<{ id: string; state: string }>) {
  const findJobs = vi.fn(async () => jobs);
  const upsert = vi.fn(async () => ({ jobs: [IDS.job] }));
  const retry = vi.fn(async () => undefined);
  const update = vi.fn(async () => ({ updated: 1 }));
  return {
    findJobs,
    upsert,
    retry,
    update,
    instance: { findJobs, upsert, retry, update } as unknown as PgBoss,
  };
}
