import { createHash } from "node:crypto";
import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeOAuthStartRateLimit } from "../../apps/web/lib/oauth-start-protection";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const NOW = new Date("2026-08-12T12:00:00.000Z");

databaseDescribe("OAuth start rate limit", () => {
  let database: DatabaseConnection;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("TRUNCATE TABLE oauth_start_rate_limits");
  });

  it("admits exactly the per-client quota under concurrency", async () => {
    const clientKeyHash = hash("same-client");
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        consumeOAuthStartRateLimit(database.pool, clientKeyHash, NOW),
      ),
    );

    expect(successCount(attempts)).toBe(4);
    await expect(rowCount(database)).resolves.toBe(4);
  });

  it("admits only one concurrent request at the global boundary", async () => {
    await database.pool.query(
      `INSERT INTO oauth_start_rate_limits
         (client_key_hash, occurred_at, expires_at)
       SELECT lpad(to_hex(series.ordinal), 64, '0'), $1, $2
         FROM generate_series(1, 599::integer) AS series(ordinal)`,
      [
        new Date(NOW.getTime() - 30_000),
        new Date(NOW.getTime() + 9 * 60_000 + 30_000),
      ],
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        consumeOAuthStartRateLimit(
          database.pool,
          hash(`global-client-${String(index)}`),
          NOW,
        ),
      ),
    );

    expect(successCount(attempts)).toBe(1);
    await expect(rowCount(database)).resolves.toBe(600);
  });

  it("removes only a bounded indexed cleanup batch", async () => {
    await database.pool.query(
      `INSERT INTO oauth_start_rate_limits
         (client_key_hash, occurred_at, expires_at)
       SELECT lpad(to_hex(1000::bigint + series.ordinal), 64, '0'), $1, $2
         FROM generate_series(1, 600::integer) AS series(ordinal)`,
      [
        new Date(NOW.getTime() - 20 * 60_000),
        new Date(NOW.getTime() - 10 * 60_000),
      ],
    );

    await consumeOAuthStartRateLimit(database.pool, hash("cleanup"), NOW);

    await expect(rowCount(database)).resolves.toBe(101);
    const expired = await database.pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM oauth_start_rate_limits
        WHERE expires_at <= $1`,
      [NOW],
    );
    expect(expired.rows[0]?.count).toBe(100);

    const indexes = await database.pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'oauth_start_rate_limits'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "oauth_start_rate_limits_client_window_idx",
        "oauth_start_rate_limits_cleanup_idx",
      ]),
    );
  });
});

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function successCount(
  results: readonly PromiseSettledResult<unknown>[],
): number {
  return results.filter((result) => result.status === "fulfilled").length;
}

async function rowCount(database: DatabaseConnection): Promise<number> {
  const result = await database.pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM oauth_start_rate_limits",
  );
  return result.rows[0]?.count ?? 0;
}
