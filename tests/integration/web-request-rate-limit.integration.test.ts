import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@understandproof/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  consumeWebRequestRateLimit,
  createWebRequestSubjectHash,
  WEB_REQUEST_RATE_LIMIT_POLICIES,
  WebRequestRateLimitExceededError,
} from "../../apps/web/lib/request-rate-limit";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const SECRET = "integration-request-rate-limit-secret-000000";

databaseDescribe("web request rate limits", () => {
  let database: DatabaseConnection;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("TRUNCATE TABLE web_request_rate_limits");
  });

  it("admits exactly the per-subject quota under concurrency", async () => {
    const action = "handoff_create" as const;
    const subjectKeyHash = subject(action, "same-private-actor");
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        consumeWebRequestRateLimit(database.pool, { action, subjectKeyHash }),
      ),
    );

    expect(successCount(attempts)).toBe(
      WEB_REQUEST_RATE_LIMIT_POLICIES[action].maximumEvents,
    );
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(WebRequestRateLimitExceededError),
    });
    if (rejected?.status === "rejected") {
      expect(rejected.reason.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(rejected.reason.retryAfterSeconds).toBeLessThanOrEqual(
        WEB_REQUEST_RATE_LIMIT_POLICIES[action].windowSeconds,
      );
    }
  });

  it("admits only one concurrent request at the action-global boundary", async () => {
    const action = "evidence_stream" as const;
    const quota = WEB_REQUEST_RATE_LIMIT_POLICIES[action];
    await database.pool.query(
      `INSERT INTO web_request_rate_limits
         (action, subject_key_hash, occurred_at, expires_at)
       SELECT $1, lpad(to_hex(series.ordinal), 64, '0'),
              clock_timestamp(),
              clock_timestamp() + ($2::integer * interval '1 second')
         FROM generate_series(1, $3::integer) AS series(ordinal)`,
      [action, quota.retentionSeconds, quota.globalMaximumEvents - 1],
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        consumeWebRequestRateLimit(database.pool, {
          action,
          subjectKeyHash: subject(action, `global-${String(index)}`),
        }),
      ),
    );

    expect(successCount(attempts)).toBe(1);
    await expect(rowCount(database)).resolves.toBe(quota.globalMaximumEvents);
  });

  it("uses indexed bounded cleanup and stores no raw subject", async () => {
    const rawSubject = "private-actor@example.invalid";
    await database.pool.query(
      `INSERT INTO web_request_rate_limits
         (action, subject_key_hash, occurred_at, expires_at)
       SELECT 'upload_start', lpad(to_hex(1000 + series.ordinal), 64, '0'),
              clock_timestamp() - interval '20 minutes',
              clock_timestamp() - interval '10 minutes'
         FROM generate_series(1, 600::integer) AS series(ordinal)`,
    );
    const hash = subject("upload_start", rawSubject);
    await consumeWebRequestRateLimit(database.pool, {
      action: "upload_start",
      subjectKeyHash: hash,
    });

    await expect(rowCount(database)).resolves.toBe(101);
    const retained = await database.pool.query<{
      subject_key_hash: string;
      raw_present: boolean;
    }>(
      `SELECT subject_key_hash,
              position($1 in subject_key_hash) > 0 AS raw_present
         FROM web_request_rate_limits
        WHERE subject_key_hash = $2`,
      [rawSubject, hash],
    );
    expect(retained.rows).toEqual([
      { subject_key_hash: hash, raw_present: false },
    ]);

    const indexes = await database.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'web_request_rate_limits'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "web_request_rate_limits_subject_window_idx",
        "web_request_rate_limits_global_window_idx",
        "web_request_rate_limits_cleanup_idx",
      ]),
    );
  });

  it("rejects unsupported actions and non-HMAC persistence", async () => {
    await expect(
      database.pool.query(
        `INSERT INTO web_request_rate_limits
           (action, subject_key_hash, occurred_at, expires_at)
         VALUES ('unbounded_action', 'raw-client-address',
                 clock_timestamp(), clock_timestamp() + interval '1 minute')`,
      ),
    ).rejects.toThrow();
    await expect(
      database.pool.query(
        `INSERT INTO web_request_rate_limits
           (action, subject_key_hash, occurred_at, expires_at)
         VALUES ('upload_start', 'raw-client-address',
                 clock_timestamp(), clock_timestamp() + interval '1 minute')`,
      ),
    ).rejects.toThrow();
  });
});

function subject(
  action: Parameters<typeof createWebRequestSubjectHash>[1],
  value: string,
): string {
  return createWebRequestSubjectHash(SECRET, action, [value]);
}

function successCount(
  results: readonly PromiseSettledResult<unknown>[],
): number {
  return results.filter((result) => result.status === "fulfilled").length;
}

async function rowCount(database: DatabaseConnection): Promise<number> {
  const result = await database.pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM web_request_rate_limits",
  );
  return result.rows[0]?.count ?? 0;
}
