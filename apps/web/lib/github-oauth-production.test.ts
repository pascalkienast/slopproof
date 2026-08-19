import { hashOpaqueCredential, type OAuthStateHash } from "@slopproof/auth";
import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PgGithubOAuthSessionPort,
  PgGithubOAuthStateRepository,
  createGithubOAuthProductionRuntime,
  listActiveMaintainerRepositories,
  loadActiveMaintainerRepository,
  loadMaintainerRepositoriesByIds,
  resolveProductionStartBinding,
} from "./github-oauth-production";
import { GithubOAuthWiringError } from "./github-oauth-runtime";
import { trustedProxyHeaders } from "./oauth-start-protection";
import type { WebRuntime } from "./runtime";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const SESSION_SECRET = "production-session-secret-that-is-at-least-32-bytes";
const PROXY_SECRET = "proxy_authenticator_with_at_least_32_chars_12345";
const REPOSITORY_ID = "10000000-0000-4000-8000-000000000002";
const REVISION_ID = "20000000-0000-4000-8000-000000000003";
const ATTEMPT_ID = "30000000-0000-4000-8000-000000000004";
const BINDING = {
  purpose: "contributor_login" as const,
  repositoryId: REPOSITORY_ID,
  githubRepositoryId: "987654321",
};

type QueryHandler = (
  sql: string,
  parameters: readonly unknown[],
) => Promise<Partial<QueryResult<never>>>;

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount = rows.length,
) {
  return { rows, rowCount } as unknown as QueryResult<never>;
}

function fakePool(queryHandler: QueryHandler, clientHandler = queryHandler) {
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) =>
    queryHandler(sql, parameters),
  );
  const clientQuery = vi.fn(async (sql: string, parameters: unknown[] = []) =>
    clientHandler(sql, parameters),
  );
  const client = {
    query: clientQuery,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    query,
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, query, clientQuery, client };
}

function app(pool: Pool, config: Record<string, unknown> = {}): WebRuntime {
  return {
    config: {
      DEPLOYMENT_PROFILE: "production",
      GITHUB_ADAPTER: "octokit",
      DEMO_MODE: false,
      APP_BASE_URL: "https://slopproof.example/",
      GITHUB_CLIENT_ID: "Iv1.slopproof-client",
      GITHUB_CLIENT_SECRET: "github-client-secret-placeholder",
      SESSION_SECRET,
      OAUTH_TRUSTED_PROXY_SECRET: PROXY_SECRET,
      ...config,
    },
    database: { pool },
  } as unknown as WebRuntime;
}

describe("production GitHub OAuth wiring", () => {
  it("derives contributor binding only from an exact active current revision", async () => {
    const database = fakePool(async (sql, parameters) => {
      expect(sql).toContain("pull_request_revisions revision");
      expect(sql).toContain("revision.is_current = true");
      expect(sql).toContain("pull_request.state = 'open'");
      expect(sql).toContain("installation.status = 'active'");
      expect(parameters).toEqual([REVISION_ID]);
      return result([
        {
          repository_id: REPOSITORY_ID,
          github_repository_id: "987654321",
        },
      ]);
    });
    await expect(
      resolveProductionStartBinding(
        app(database.pool),
        new Request("https://slopproof.example/api/auth/github/start"),
        `/revisions/${REVISION_ID}/contribute/practice`,
      ),
    ).resolves.toEqual(BINDING);
  });

  it("binds review detail to its attempt and starts identify for unbound /review", async () => {
    const detailDatabase = fakePool(async (sql, parameters) => {
      expect(sql).toContain("FROM attempts attempt");
      expect(parameters).toEqual([ATTEMPT_ID]);
      return result([
        {
          repository_id: REPOSITORY_ID,
          github_repository_id: "987654321",
        },
      ]);
    });
    await expect(
      resolveProductionStartBinding(
        app(detailDatabase.pool),
        new Request("https://slopproof.example/api/auth/github/start"),
        `/review/${ATTEMPT_ID}`,
      ),
    ).resolves.toEqual({
      purpose: "maintainer_reauth",
      repositoryId: REPOSITORY_ID,
      githubRepositoryId: "987654321",
    });

    await expect(
      resolveProductionStartBinding(
        app(fakePool(async () => result()).pool),
        new Request("https://slopproof.example/api/auth/github/start"),
        "/review",
      ),
    ).resolves.toEqual({ purpose: "maintainer_identify" });
  });

  it("binds /review to an exact active local repository id", async () => {
    const database = fakePool(async (sql, parameters) => {
      expect(sql).toContain("WHERE repository.id = $1");
      expect(sql).toContain("repository.status = 'active'");
      expect(parameters).toEqual([REPOSITORY_ID]);
      return result([
        {
          repository_id: REPOSITORY_ID,
          github_repository_id: "987654321",
        },
      ]);
    });
    await expect(
      resolveProductionStartBinding(
        app(database.pool),
        new Request(
          `https://slopproof.example/api/auth/github/start?returnTo=${encodeURIComponent("/review")}&repositoryId=${REPOSITORY_ID}`,
        ),
        "/review",
      ),
    ).resolves.toEqual({
      purpose: "maintainer_reauth",
      repositoryId: REPOSITORY_ID,
      githubRepositoryId: "987654321",
    });
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown or malformed review repository ids", async () => {
    const unknown = fakePool(async () => result());
    await expect(
      resolveProductionStartBinding(
        app(unknown.pool),
        new Request(
          `https://slopproof.example/api/auth/github/start?repositoryId=${REPOSITORY_ID}`,
        ),
        "/review",
      ),
    ).rejects.toBeInstanceOf(GithubOAuthWiringError);

    await expect(
      resolveProductionStartBinding(
        app(unknown.pool),
        new Request(
          "https://slopproof.example/api/auth/github/start?repositoryId=not-a-uuid",
        ),
        "/review",
      ),
    ).rejects.toBeInstanceOf(GithubOAuthWiringError);
    expect(unknown.query).toHaveBeenCalledTimes(1);
  });

  it("lists only active owner/name pairs for the authenticated directory filter", async () => {
    const database = fakePool(async (sql, parameters) => {
      expect(sql).toContain(
        "SELECT repository.id, repository.owner, repository.name",
      );
      expect(sql).toContain(
        "ORDER BY repository.owner, repository.name, repository.id",
      );
      expect(parameters).toEqual([33]);
      return result([
        {
          id: REPOSITORY_ID,
          owner: "pascalkienast",
          name: "pixelcampus",
        },
        {
          id: "40000000-0000-4000-8000-000000000005",
          owner: "pascalkienast",
          name: "slopproof",
        },
      ]);
    });
    await expect(
      listActiveMaintainerRepositories(database.pool),
    ).resolves.toEqual([
      {
        id: REPOSITORY_ID,
        owner: "pascalkienast",
        name: "pixelcampus",
      },
      {
        id: "40000000-0000-4000-8000-000000000005",
        owner: "pascalkienast",
        name: "slopproof",
      },
    ]);
  });

  it("reloads only the sealed directory's still-active repositories", async () => {
    const allowedId = "40000000-0000-4000-8000-000000000005";
    const database = fakePool(async (sql, parameters) => {
      expect(sql).toContain("WHERE repository.id = ANY($1::uuid[])");
      expect(sql).toContain("repository.status = 'active'");
      expect(parameters).toEqual([[REPOSITORY_ID, allowedId]]);
      return result([
        {
          id: REPOSITORY_ID,
          owner: "pascalkienast",
          name: "pixelcampus",
        },
      ]);
    });
    await expect(
      loadMaintainerRepositoriesByIds(database.pool, [
        REPOSITORY_ID,
        allowedId,
      ]),
    ).resolves.toEqual([
      {
        id: REPOSITORY_ID,
        owner: "pascalkienast",
        name: "pixelcampus",
      },
    ]);
  });

  it("loads one active maintainer repository by local id", async () => {
    const database = fakePool(async (sql, parameters) => {
      expect(sql).toContain("WHERE repository.id = $1");
      expect(sql).toContain("repository.status = 'active'");
      expect(parameters).toEqual([REPOSITORY_ID]);
      return result([
        {
          id: REPOSITORY_ID,
          owner: "pascalkienast",
          name: "slopproof",
        },
      ]);
    });
    await expect(
      loadActiveMaintainerRepository(database.pool, REPOSITORY_ID),
    ).resolves.toEqual({
      id: REPOSITORY_ID,
      owner: "pascalkienast",
      name: "slopproof",
    });
    await expect(
      loadActiveMaintainerRepository(database.pool, "not-a-uuid"),
    ).rejects.toBeInstanceOf(GithubOAuthWiringError);
  });

  it("prefers an active repository-bound session for /review", async () => {
    const database = fakePool(async (sql, parameters) => {
      expect(sql).toContain("FROM auth_sessions session");
      expect(sql).toContain("repository.status = 'active'");
      expect(parameters).toEqual([
        hashOpaqueCredential(SESSION_SECRET, "session", "old-session-token"),
      ]);
      return result([
        {
          repository_id: REPOSITORY_ID,
          github_repository_id: "987654321",
        },
      ]);
    });
    await expect(
      resolveProductionStartBinding(
        app(database.pool),
        new Request("https://slopproof.example/api/auth/github/start", {
          headers: { cookie: "slopproof_session=old-session-token" },
        }),
        "/review",
      ),
    ).resolves.toEqual({
      purpose: "maintainer_reauth",
      repositoryId: REPOSITORY_ID,
      githubRepositoryId: "987654321",
    });
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it("persists only hashed state and consumes it with active repo/install join", async () => {
    const database = fakePool(async (sql, parameters) => {
      if (sql === "BEGIN" || sql === "COMMIT") return result();
      if (sql.includes("pg_advisory_xact_lock")) {
        expect(parameters).toEqual([736_567_102]);
        return result([{ locked: true }]);
      }
      if (sql.includes("DELETE FROM github_oauth_flows")) {
        expect(sql).toContain("ORDER BY expires_at, id");
        expect(sql).toContain("LIMIT $2");
        expect(parameters).toEqual([NOW, 500]);
        return result([], 0);
      }
      if (sql.includes("INSERT INTO github_oauth_flows")) {
        expect(sql).toContain("repository.github_repository_id = $7");
        expect(sql).toContain("installation.status = 'active'");
        expect(sql).toContain("recent.created_at >= $9");
        expect(parameters[0]).toBe("a".repeat(64));
        expect(parameters.slice(7)).toEqual([
          8,
          new Date(NOW.getTime() - 60_000),
          12,
          500,
          240,
        ]);
        expect(JSON.stringify(parameters)).not.toContain("raw-oauth-state");
        return result([{ state_hash: "a".repeat(64) }]);
      }
      expect(sql).toContain("WITH consumed AS");
      expect(sql).toContain("flow.consumed_at IS NULL");
      expect(sql).toContain("repository.github_repository_id");
      return result([
        {
          state_hash: "a".repeat(64),
          purpose: "contributor_login",
          repository_id: REPOSITORY_ID,
          github_repository_id: "987654321",
          redirect_path: `/revisions/${REVISION_ID}/contribute`,
          created_at: NOW,
          expires_at: new Date(NOW.getTime() + 5 * 60_000),
        },
      ]);
    });
    const repository = new PgGithubOAuthStateRepository(database.pool);
    const record = {
      ...BINDING,
      stateHash: "a".repeat(64) as OAuthStateHash,
      redirectPath: `/revisions/${REVISION_ID}/contribute`,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    };
    await repository.create(record);
    await expect(
      repository.consume({ stateHash: record.stateHash, now: NOW }),
    ).resolves.toEqual(record);
    expect(database.client.release).toHaveBeenCalledTimes(1);
  });

  it("persists unbound identify state without joining a repository", async () => {
    const database = fakePool(async (sql, parameters) => {
      if (sql === "BEGIN" || sql === "COMMIT") return result();
      if (sql.includes("pg_advisory_xact_lock")) return result();
      if (sql.includes("DELETE FROM github_oauth_flows")) return result();
      if (sql.includes("INSERT INTO github_oauth_flows")) {
        expect(sql).toContain("SELECT $1, $2, NULL, $3");
        expect(sql).not.toContain("repository.github_repository_id");
        expect(parameters.slice(0, 3)).toEqual([
          "a".repeat(64),
          "maintainer_identify",
          "/review",
        ]);
        return result([{ state_hash: "a".repeat(64) }]);
      }
      expect(sql).toContain("flow.purpose = 'maintainer_identify'");
      return result([
        {
          state_hash: "a".repeat(64),
          purpose: "maintainer_identify",
          repository_id: null,
          github_repository_id: null,
          redirect_path: "/review",
          created_at: NOW,
          expires_at: new Date(NOW.getTime() + 5 * 60_000),
        },
      ]);
    });
    const repository = new PgGithubOAuthStateRepository(database.pool);
    const record = {
      purpose: "maintainer_identify" as const,
      stateHash: "a".repeat(64) as OAuthStateHash,
      redirectPath: "/review",
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    };
    await repository.create(record);
    await expect(
      repository.consume({ stateHash: record.stateHash, now: NOW }),
    ).resolves.toEqual(record);
  });

  it("commits bounded stale cleanup while rejecting a quota-exhausted start", async () => {
    const database = fakePool(
      async () => result(),
      async (sql, parameters) => {
        if (sql === "BEGIN" || sql === "COMMIT") return result();
        if (sql.includes("pg_advisory_xact_lock")) return result();
        if (sql.includes("DELETE FROM github_oauth_flows")) {
          expect(parameters).toEqual([NOW, 500]);
          return result([], 500);
        }
        if (sql.includes("INSERT INTO github_oauth_flows")) {
          return result([], 0);
        }
        throw new Error("unexpected SQL in test");
      },
    );
    const repository = new PgGithubOAuthStateRepository(database.pool);

    await expect(
      repository.create({
        ...BINDING,
        stateHash: "b".repeat(64) as OAuthStateHash,
        redirectPath: `/revisions/${REVISION_ID}/contribute`,
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 5 * 60_000),
      }),
    ).rejects.toMatchObject({
      message: "GitHub OAuth persistence is unavailable.",
    });

    const statements = database.clientQuery.mock.calls.map(([sql]) => sql);
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("DELETE FROM github_oauth_flows"),
      expect.stringContaining("INSERT INTO github_oauth_flows"),
      "COMMIT",
    ]);
    expect(statements).not.toContain("ROLLBACK");
  });

  it("rolls back a failed quota transaction and rejects invalid state lifetimes before connecting", async () => {
    const database = fakePool(
      async () => result(),
      async (sql) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return result();
        if (sql.includes("pg_advisory_xact_lock")) return result();
        if (sql.includes("DELETE FROM github_oauth_flows")) return result();
        if (sql.includes("INSERT INTO github_oauth_flows")) {
          throw new Error("database unavailable");
        }
        throw new Error("unexpected SQL in test");
      },
    );
    const repository = new PgGithubOAuthStateRepository(database.pool);
    const validRecord = {
      ...BINDING,
      stateHash: "c".repeat(64) as OAuthStateHash,
      redirectPath: `/revisions/${REVISION_ID}/contribute`,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    };

    await expect(repository.create(validRecord)).rejects.toMatchObject({
      message: "GitHub OAuth persistence is unavailable.",
    });
    expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toContain(
      "ROLLBACK",
    );

    const connectCalls = vi.mocked(database.pool.connect).mock.calls.length;
    await expect(
      repository.create({
        ...validRecord,
        stateHash: "d".repeat(64) as OAuthStateHash,
        expiresAt: new Date(NOW.getTime() + 5 * 60_000 + 1),
      }),
    ).rejects.toMatchObject({
      message: "GitHub OAuth persistence is unavailable.",
    });
    expect(database.pool.connect).toHaveBeenCalledTimes(connectCalls);
  });

  it("atomically rechecks contributor author/revision before rotating session", async () => {
    const database = fakePool(
      async () => result(),
      async (sql, parameters) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return result();
        }
        if (sql.includes("FROM pull_request_revisions revision")) {
          expect(sql).toContain("pull_request.author_id = $2");
          expect(parameters).toEqual([
            REVISION_ID,
            "12345678",
            REPOSITORY_ID,
            "987654321",
          ]);
          return result([{ authorized: 1 }]);
        }
        if (sql.includes("UPDATE auth_sessions")) return result([], 1);
        if (sql.includes("INSERT INTO auth_sessions")) {
          expect(parameters).toEqual(
            expect.arrayContaining(["12345678", "author", REPOSITORY_ID, NOW]),
          );
          return result([{ id: "50000000-0000-4000-8000-000000000006" }]);
        }
        throw new Error("unexpected SQL in test");
      },
    );
    const sessions = new PgGithubOAuthSessionPort(
      database.pool,
      SESSION_SECRET,
    );
    const issued = await sessions.rotate({
      user: { githubUserId: "12345678", login: "octocat" },
      binding: BINDING,
      actorRole: "author",
      redirectPath: `/revisions/${REVISION_ID}/contribute`,
      currentSessionToken: "old-session-token",
      ttlMs: 8 * 60 * 60_000,
      now: NOW,
    });
    expect(issued.session).toEqual(
      expect.objectContaining({
        actorId: "12345678",
        actorRole: "author",
        repositoryId: REPOSITORY_ID,
      }),
    );
    const statements = database.clientQuery.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(
      statements.findIndex((sql) => sql.includes("UPDATE auth_sessions")),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.includes("INSERT INTO auth_sessions")),
    );
  });

  it("rolls back and installs no author session when GitHub user is not revision author", async () => {
    const database = fakePool(
      async () => result(),
      async (sql) => {
        if (sql.includes("FROM pull_request_revisions revision")) {
          return result();
        }
        return result();
      },
    );
    const sessions = new PgGithubOAuthSessionPort(
      database.pool,
      SESSION_SECRET,
    );
    await expect(
      sessions.rotate({
        user: { githubUserId: "12345678", login: "octocat" },
        binding: BINDING,
        actorRole: "author",
        redirectPath: `/revisions/${REVISION_ID}/contribute`,
        ttlMs: 8 * 60 * 60_000,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      message: "GitHub OAuth persistence is unavailable.",
    });
    const statements = database.clientQuery.mock.calls.map(([sql]) => sql);
    expect(statements).toContain("ROLLBACK");
    expect(
      statements.some((sql) => sql.includes("INSERT INTO auth_sessions")),
    ).toBe(false);
  });

  it("revokes only after locking the session and verifying its bound CSRF hash", async () => {
    const csrfToken = "current-csrf-token";
    const database = fakePool(
      async () => result(),
      async (sql, parameters) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return result();
        }
        if (sql.includes("SELECT id, csrf_hash")) {
          expect(sql).toContain("FOR UPDATE");
          expect(parameters[0]).toBe(
            hashOpaqueCredential(
              SESSION_SECRET,
              "session",
              "current-session-token",
            ),
          );
          return result([
            {
              id: "50000000-0000-4000-8000-000000000006",
              csrf_hash: hashOpaqueCredential(
                SESSION_SECRET,
                "csrf",
                csrfToken,
              ),
            },
          ]);
        }
        if (sql.includes("UPDATE auth_sessions")) return result([], 1);
        throw new Error("unexpected SQL in test");
      },
    );
    const sessions = new PgGithubOAuthSessionPort(
      database.pool,
      SESSION_SECRET,
    );
    await sessions.revoke({
      sessionToken: "current-session-token",
      csrfToken,
      now: NOW,
    });
    const statements = database.clientQuery.mock.calls.map(([sql]) => sql);
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("SELECT id, csrf_hash"),
      expect.stringContaining("UPDATE auth_sessions"),
      "COMMIT",
    ]);
  });

  it("assembles the real production service without manual registration", async () => {
    const database = fakePool(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return result();
      if (sql.includes("pg_advisory_xact_lock")) return result();
      if (sql.includes("DELETE FROM oauth_start_rate_limits")) return result();
      if (sql.includes("INSERT INTO oauth_start_rate_limits")) return result();
      if (sql.includes("DELETE FROM github_oauth_flows")) return result();
      if (sql.includes("FROM pull_request_revisions revision")) {
        return result([
          {
            repository_id: REPOSITORY_ID,
            github_repository_id: "987654321",
          },
        ]);
      }
      if (sql.includes("INSERT INTO github_oauth_flows")) {
        return result([{ state_hash: "a".repeat(64) }]);
      }
      throw new Error("unexpected SQL in test");
    });
    const request = new Request(
      `https://slopproof.example/api/auth/github/start?returnTo=${encodeURIComponent(`/revisions/${REVISION_ID}/contribute`)}`,
      {
        headers: {
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          referer: "https://slopproof.example/review",
          ...trustedProxyHeaders(PROXY_SECRET, "203.0.113.17"),
        },
      },
    );
    const runtime = await createGithubOAuthProductionRuntime(
      app(database.pool),
      request,
    );
    const binding = await runtime.resolveStartBinding({
      request,
      requestedRedirectPath: `/revisions/${REVISION_ID}/contribute`,
    });
    const started = await runtime.oauth.start({
      binding,
      requestedRedirectPath: `/revisions/${REVISION_ID}/contribute`,
    });
    expect(started.authorizationUrl.origin).toBe("https://github.com");
    expect(started.authorizationUrl.searchParams.has("scope")).toBe(false);
    expect(
      started.authorizationUrl.searchParams.get("code_challenge_method"),
    ).toBe("S256");

    await expect(
      createGithubOAuthProductionRuntime(
        app(database.pool, {
          DEPLOYMENT_PROFILE: "local",
          GITHUB_ADAPTER: "fake",
          DEMO_MODE: true,
        }),
        request,
      ),
    ).rejects.toBeInstanceOf(GithubOAuthWiringError);
  });
});
