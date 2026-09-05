import { createHash } from "node:crypto";
import type { OAuthStateHash } from "@understandproof/auth";
import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@understandproof/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgGithubOAuthStateRepository } from "../../apps/web/lib/github-oauth-production";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const NOW = new Date("2026-08-12T12:00:00.000Z");
const INSTALLATION_ID = "82000000-0000-4000-8000-000000000001";
const FIRST_REPOSITORY_ID = "82000000-0000-4000-8000-000000000002";
const SECOND_REPOSITORY_ID = "82000000-0000-4000-8000-000000000003";

databaseDescribe("production GitHub OAuth flow quotas", () => {
  let database: DatabaseConnection;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  beforeEach(async () => {
    await database.pool.query(
      "TRUNCATE TABLE github_oauth_flows, repositories, installations, github_app_account_allowlist CASCADE",
    );
    await database.pool.query(
      `INSERT INTO installations
         (id, github_installation_id, account_id, account_login)
       VALUES ($1, '8201', '8202', 'acme')`,
      [INSTALLATION_ID],
    );
    await database.pool.query(
      `INSERT INTO repositories
         (id, installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $3, '8203', 'acme', 'first', 'main'),
              ($2, $3, '8204', 'acme', 'second', 'main')`,
      [FIRST_REPOSITORY_ID, SECOND_REPOSITORY_ID, INSTALLATION_ID],
    );
  });

  it("serializes concurrent starts at the repository active and rolling-window quotas", async () => {
    const repository = new PgGithubOAuthStateRepository(database.pool);
    const firstWave = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        repository.create(flowRecord(`repository-active-${index}`)),
      ),
    );
    expect(successCount(firstWave)).toBe(8);
    await expect(flowCount(database)).resolves.toBe(8);

    await database.pool.query(
      `UPDATE github_oauth_flows
          SET consumed_at = $2
        WHERE repository_id = $1`,
      [FIRST_REPOSITORY_ID, new Date(NOW.getTime() + 1_000)],
    );
    const secondWave = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        repository.create(flowRecord(`repository-window-${index}`)),
      ),
    );
    expect(successCount(secondWave)).toBe(4);
    await expect(flowCount(database)).resolves.toBe(12);
  });

  it("admits only one concurrent start at the global rolling-window boundary", async () => {
    await seedFlows(database, {
      count: 239,
      repositoryId: FIRST_REPOSITORY_ID,
      createdAt: new Date(NOW.getTime() - 30_000),
      expiresAt: new Date(NOW.getTime() + 4 * 60_000 + 30_000),
      hashOffset: 1_000,
    });
    const repository = new PgGithubOAuthStateRepository(database.pool);
    const attempts = await Promise.allSettled([
      repository.create(flowRecord("global-window-1", SECOND_REPOSITORY_ID)),
      repository.create(flowRecord("global-window-2", SECOND_REPOSITORY_ID)),
      repository.create(flowRecord("global-window-3", SECOND_REPOSITORY_ID)),
    ]);

    expect(successCount(attempts)).toBe(1);
    await expect(flowCount(database)).resolves.toBe(240);
  });

  it("admits unbound identify starts only under the global quota", async () => {
    const repository = new PgGithubOAuthStateRepository(database.pool);
    await repository.create({
      purpose: "maintainer_identify",
      stateHash: createHash("sha256")
        .update("identify-unbound")
        .digest("hex") as OAuthStateHash,
      redirectPath: "/review",
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    const stored = await database.pool.query<{
      purpose: string;
      repository_id: string | null;
    }>(
      `SELECT purpose, repository_id
         FROM github_oauth_flows
        WHERE state_hash = $1`,
      [createHash("sha256").update("identify-unbound").digest("hex")],
    );
    expect(stored.rows[0]).toEqual({
      purpose: "maintainer_identify",
      repository_id: null,
    });
  });

  it("rejects a start at the global active-flow boundary", async () => {
    await seedFlows(database, {
      count: 500,
      repositoryId: FIRST_REPOSITORY_ID,
      createdAt: new Date(NOW.getTime() - 2 * 60_000),
      expiresAt: new Date(NOW.getTime() + 3 * 60_000),
      hashOffset: 2_000,
    });
    const repository = new PgGithubOAuthStateRepository(database.pool);

    await expect(
      repository.create(flowRecord("global-active", SECOND_REPOSITORY_ID)),
    ).rejects.toMatchObject({
      message: "GitHub OAuth persistence is unavailable.",
    });
    await expect(flowCount(database)).resolves.toBe(500);
  });

  it("deletes at most one indexed cleanup batch per transaction", async () => {
    await seedFlows(database, {
      count: 600,
      repositoryId: FIRST_REPOSITORY_ID,
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
      expiresAt: new Date(NOW.getTime() - 5 * 60_000),
      hashOffset: 3_000,
    });
    const repository = new PgGithubOAuthStateRepository(database.pool);
    await repository.create(flowRecord("cleanup", SECOND_REPOSITORY_ID));

    await expect(flowCount(database)).resolves.toBe(101);
    const expired = await database.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM github_oauth_flows
        WHERE expires_at <= $1`,
      [NOW],
    );
    expect(expired.rows[0]?.count).toBe(100);

    const indexes = await database.pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'github_oauth_flows'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "github_oauth_flows_cleanup_idx",
        "github_oauth_flows_created_idx",
        "github_oauth_flows_repository_active_idx",
        "github_oauth_flows_repository_created_idx",
      ]),
    );
  });
});

function flowRecord(label: string, repositoryId = FIRST_REPOSITORY_ID) {
  return {
    stateHash: createHash("sha256")
      .update(label)
      .digest("hex") as OAuthStateHash,
    purpose: "maintainer_reauth" as const,
    repositoryId,
    githubRepositoryId: repositoryId === FIRST_REPOSITORY_ID ? "8203" : "8204",
    redirectPath: "/review",
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 5 * 60_000),
  };
}

async function seedFlows(
  database: DatabaseConnection,
  input: Readonly<{
    count: number;
    repositoryId: string;
    createdAt: Date;
    expiresAt: Date;
    hashOffset: number;
  }>,
): Promise<void> {
  await database.pool.query(
    `INSERT INTO github_oauth_flows
       (state_hash, purpose, repository_id, redirect_path, expires_at, created_at)
     SELECT lpad(to_hex($5::bigint + series.ordinal), 64, '0'),
            'maintainer_reauth', $1, '/review', $2, $3
       FROM generate_series(1, $4::integer) AS series(ordinal)`,
    [
      input.repositoryId,
      input.expiresAt,
      input.createdAt,
      input.count,
      input.hashOffset,
    ],
  );
}

function successCount(
  results: readonly PromiseSettledResult<unknown>[],
): number {
  return results.filter((result) => result.status === "fulfilled").length;
}

async function flowCount(database: DatabaseConnection): Promise<number> {
  const result = await database.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM github_oauth_flows",
  );
  return result.rows[0]?.count ?? 0;
}
