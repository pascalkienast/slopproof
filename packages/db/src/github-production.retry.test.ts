import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  claimGithubCheckSync,
  failGithubCheckSync,
  replayDueGithubCheckSyncs,
  type GithubCheckOutbox,
} from "./github-production";

const revisionId = "82000000-0000-4000-8000-000000000001";
const checkRunId = "82000000-0000-4000-8000-000000000002";
const headSha = "a".repeat(40);

describe("durable GitHub Check retry scheduling", () => {
  it("guards claims until an explicit retry schedule is due", async () => {
    let statement = "";
    const pool = {
      query: vi.fn(async (sql: string) => {
        statement = sql;
        return queryResult([]);
      }),
    } as unknown as Pool;

    await expect(
      claimGithubCheckSync(pool, {
        revisionId,
        expectedHeadSha: headSha,
        reason: "webhook_ingested",
      }),
    ).resolves.toBeNull();
    expect(statement).toContain(
      "check_run.next_sync_after IS NULL OR check_run.next_sync_after <= now()",
    );
  });

  it("persists a retry deadline and forbids one on permanent failure", async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        return queryResult([], 1);
      }),
    } as unknown as Pool;
    const nextSyncAfter = new Date("2026-08-12T20:15:00.000Z");

    await expect(
      failGithubCheckSync(pool, {
        checkRunId,
        attempt: 1,
        errorClass: "Unavailable",
        retryable: true,
      }),
    ).rejects.toThrow("a retryable failure requires a durable retry schedule");

    await expect(
      failGithubCheckSync(pool, {
        checkRunId,
        attempt: 1,
        errorClass: "RateLimited",
        retryable: true,
        nextSyncAfter,
      }),
    ).resolves.toBe(true);
    expect(calls[0]?.sql).toContain("next_sync_after");
    expect(calls[0]?.values).toEqual([
      checkRunId,
      1,
      "RateLimited",
      true,
      nextSyncAfter,
    ]);

    await expect(
      failGithubCheckSync(pool, {
        checkRunId,
        attempt: 1,
        errorClass: "Rejected",
        retryable: false,
        nextSyncAfter,
      }),
    ).rejects.toThrow("a permanent failure cannot have a retry schedule");
  });

  it("publishes due retries transactionally and retains a due row during an active singleton race", async () => {
    const dueRow = {
      id: checkRunId,
      revision_id: revisionId,
      intent_idempotency_key: "check:intent:retry",
      intent_reason: "webhook_ingested" as const,
      head_sha: headSha,
    };
    const first = fakeTransactionalPool(dueRow);
    const singletonBusy: GithubCheckOutbox = {
      publish: vi.fn(async () => null),
    };

    await expect(
      replayDueGithubCheckSyncs(first.pool, singletonBusy),
    ).resolves.toEqual({ examined: 1, published: 0 });
    expect(
      first.statements.some((sql) =>
        sql.includes("SET next_sync_after = NULL"),
      ),
    ).toBe(false);
    expect(first.statements.at(-1)).toBe("COMMIT");
    expect(
      first.statements.some(
        (sql) =>
          sql.includes("sync_status = 'retry_required'") &&
          sql.includes("AbandonedSyncLease"),
      ),
    ).toBe(true);

    const second = fakeTransactionalPool(dueRow);
    const available: GithubCheckOutbox = {
      publish: vi.fn(async () => "83000000-0000-4000-8000-000000000001"),
    };
    await expect(
      replayDueGithubCheckSyncs(second.pool, available, { limit: 10 }),
    ).resolves.toEqual({ examined: 1, published: 1 });
    expect(
      second.statements.some((sql) =>
        sql.includes("SET next_sync_after = NULL"),
      ),
    ).toBe(true);
    expect(available.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        revisionId,
        expectedHeadSha: headSha,
        reason: "webhook_ingested",
      }),
    );
  });
});

function fakeTransactionalPool(dueRow: Record<string, unknown>): {
  pool: Pool;
  statements: string[];
} {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("SELECT check_run.id")) return queryResult([dueRow]);
      if (sql.includes("UPDATE check_runs")) return queryResult([], 1);
      return queryResult([]);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    statements,
  };
}

function queryResult<Row extends Record<string, unknown>>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return {
    command: "TEST",
    rowCount,
    oid: 0,
    fields: [],
    rows,
  };
}
