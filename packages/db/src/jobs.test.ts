import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { expediteJob } from "./jobs";

const auditRunId = "84000000-0000-4000-8000-000000000001";
const payload = {
  schemaVersion: "1",
  idempotencyKey: "retention:audit:84000000-0000-4000-8000-000000000001",
  auditRunId,
} as const;

describe("expediteJob", () => {
  it("retries one failed singleton in place and replaces its payload immediately", async () => {
    const failedId = "85000000-0000-4000-8000-000000000001";
    const queue = fakeQueue({
      jobs: [{ id: failedId, state: "failed" }],
      updated: 1,
    });
    const before = Date.now();

    await expect(
      expediteJob(queue.boss, "evidence.audit-retention", payload),
    ).resolves.toBe(failedId);

    expect(queue.findJobs).toHaveBeenCalledWith("evidence.audit-retention", {
      key: auditRunId,
    });
    expect(queue.retry).toHaveBeenCalledWith(
      "evidence.audit-retention",
      failedId,
    );
    expect(queue.update).toHaveBeenCalledWith(
      "evidence.audit-retention",
      payload,
      expect.objectContaining({ id: failedId, startAfter: expect.any(Date) }),
    );
    const updateOptions = queue.update.mock.calls[0]?.[2] as
      { startAfter?: Date } | undefined;
    expect(updateOptions?.startAfter?.getTime()).toBeGreaterThanOrEqual(before);
    expect(queue.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when the singleton key has multiple failed jobs", async () => {
    const queue = fakeQueue({
      jobs: [
        { id: "85000000-0000-4000-8000-000000000002", state: "failed" },
        { id: "85000000-0000-4000-8000-000000000003", state: "failed" },
      ],
    });

    await expect(
      expediteJob(queue.boss, "evidence.audit-retention", payload),
    ).rejects.toThrow(
      "Queue has multiple failed evidence.audit-retention singleton jobs",
    );
    expect(queue.retry).not.toHaveBeenCalled();
    expect(queue.update).not.toHaveBeenCalled();
    expect(queue.upsert).not.toHaveBeenCalled();
  });

  it("treats an equivalent existing singleton as success when upsert returns null", async () => {
    const queue = fakeQueue({
      jobs: [{ id: "85000000-0000-4000-8000-000000000004", state: "created" }],
      upsertedJobs: [],
    });
    const before = Date.now();

    await expect(
      expediteJob(queue.boss, "evidence.audit-retention", payload),
    ).resolves.toBeNull();

    expect(queue.retry).not.toHaveBeenCalled();
    expect(queue.update).not.toHaveBeenCalled();
    expect(queue.upsert).toHaveBeenCalledWith(
      "evidence.audit-retention",
      payload,
      expect.objectContaining({
        singletonKey: auditRunId,
        match: "oldest",
        startAfter: expect.any(Date),
      }),
    );
    const upsertOptions = queue.upsert.mock.calls[0]?.[2] as
      { startAfter?: Date } | undefined;
    expect(upsertOptions?.startAfter?.getTime()).toBeGreaterThanOrEqual(before);
  });
});

function fakeQueue(input: {
  jobs: Array<{ id: string; state: string }>;
  updated?: number;
  upsertedJobs?: string[];
}): {
  boss: PgBoss;
  findJobs: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
} {
  const findJobs = vi.fn(async () => input.jobs);
  const retry = vi.fn(async () => undefined);
  const update = vi.fn(async () => ({ updated: input.updated ?? 0 }));
  const upsert = vi.fn(async () => ({ jobs: input.upsertedJobs ?? [] }));
  return {
    boss: { findJobs, retry, update, upsert } as unknown as PgBoss,
    findJobs,
    retry,
    update,
    upsert,
  };
}
