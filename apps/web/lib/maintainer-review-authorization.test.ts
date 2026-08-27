import {
  sealGithubUserAccessToken,
  type AuthenticatedSession,
} from "@slopproof/auth";
import type { GithubUserAuthorizationPort } from "@slopproof/github";
import { describe, expect, it, vi } from "vitest";
import type { CheckIntentWriter } from "./attempt-lifecycle";
import { GITHUB_USER_TOKEN_COOKIE } from "./github-oauth-token";
import { MaintainerAuthorizationError } from "./maintainer-authorization";
import {
  decideReview,
  loadReviewDetail,
  loadReviewQueue,
  requireEvidenceAccess,
} from "./maintainer-review";
import type { WebRuntime } from "./runtime";
import { WebRequestRateLimitExceededError } from "./request-rate-limit";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const SESSION_SECRET = "maintainer-callsite-secret-that-is-at-least-32-bytes";
const REPOSITORY_ID = "10000000-0000-4000-8000-000000000002";
const OTHER_REPOSITORY_ID = "10000000-0000-4000-8000-000000000009";
const ATTEMPT_ID = "20000000-0000-4000-8000-000000000003";
const SESSION: AuthenticatedSession = {
  id: "00000000-0000-4000-8000-000000000001",
  actorId: "12345678",
  actorRole: "maintainer",
  repositoryId: REPOSITORY_ID,
  csrfHash: "c".repeat(64),
  expiresAt: new Date(NOW.getTime() + 60 * 60_000),
};
const REPOSITORY_ROW = {
  repository_id: REPOSITORY_ID,
  owner: "acme",
  name: "cachekit",
  github_repository_id: "987654321",
  github_installation_id: "87654321",
};

function productionDatabase(
  options: Readonly<{ activeBinding?: boolean; rateLimited?: boolean }> = {},
) {
  const query = vi.fn(async (rawSql: string) => {
    const sql = String(rawSql);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return queryResult([]);
    if (sql.includes("installation.github_installation_id")) {
      return queryResult(
        options.activeBinding === false ? [] : [REPOSITORY_ROW],
      );
    }
    if (
      sql.includes("pg_advisory_xact_lock") ||
      sql.includes("DELETE FROM web_request_rate_limits")
    ) {
      return queryResult([]);
    }
    if (sql.includes("INSERT INTO web_request_rate_limits")) {
      return queryResult(
        options.rateLimited ? [{ retry_after_seconds: 60 }] : [],
      );
    }
    if (sql.includes("AS question_count")) return queryResult([]);
    if (sql.includes("INSERT INTO audit_events")) return queryResult([]);
    throw new Error(`Unexpected private query: ${sql.slice(0, 80)}`);
  });
  const client = {
    query: query as unknown as WebRuntime["database"]["pool"]["query"],
    release: vi.fn(),
  };
  const connect = vi.fn(async () => client);
  const pool = {
    query: query as unknown as WebRuntime["database"]["pool"]["query"],
    connect,
  } as unknown as WebRuntime["database"]["pool"];
  return { pool, query, connect };
}

function queryResult(rows: unknown[]) {
  return { rows, rowCount: rows.length };
}

function productionApp(pool: WebRuntime["database"]["pool"]): WebRuntime {
  return {
    config: {
      DEPLOYMENT_PROFILE: "production",
      GITHUB_ADAPTER: "octokit",
      DEMO_MODE: false,
      SESSION_SECRET,
    },
    database: { pool },
  } as unknown as WebRuntime;
}

function githubAuthorization() {
  const getAuthenticatedUser = vi.fn(async () => ({
    id: SESSION.actorId,
    login: "OctoCat",
  }));
  const getCollaboratorPermission = vi.fn(
    async (): Promise<{
      permission: "admin" | "write" | "read" | "none";
      roleName: string;
    }> => ({
      permission: "write",
      roleName: "maintain",
    }),
  );
  return {
    port: {
      getAuthenticatedUser,
      getCollaboratorPermission,
      listAccessibleAppInstallations: vi.fn(async () => []),
    } satisfies GithubUserAuthorizationPort,
    getAuthenticatedUser,
    getCollaboratorPermission,
  };
}

function authorizationRequest(
  input: Readonly<{
    repositoryId?: string;
    issuedAt?: Date;
    expiresAt?: Date;
    includeCookie?: boolean;
  }> = {},
): Request {
  if (input.includeCookie === false) {
    return new Request("https://slopproof.example/review");
  }
  const sealed = sealGithubUserAccessToken(
    {
      accessToken: "request-scoped-maintainer-token",
      binding: {
        sessionId: SESSION.id,
        githubUserId: SESSION.actorId,
        repositoryId: input.repositoryId ?? REPOSITORY_ID,
        githubRepositoryId: REPOSITORY_ROW.github_repository_id,
        purpose: "maintainer_reauth",
      },
      issuedAt: input.issuedAt ?? NOW,
      expiresAt: input.expiresAt ?? new Date(NOW.getTime() + 10 * 60_000),
    },
    SESSION_SECRET,
    { entropy: (bytes) => Buffer.alloc(bytes, 7) },
  );
  return new Request("https://slopproof.example/review", {
    headers: { cookie: `${GITHUB_USER_TOKEN_COOKIE}=${sealed}` },
  });
}

function containsQuery(
  query: ReturnType<typeof vi.fn>,
  fragment: string,
): boolean {
  return query.mock.calls.some(([sql]) => String(sql).includes(fragment));
}

describe("maintainer review fresh-authorization call sites", () => {
  it("rejects a saturated cheap quota before an authorization transaction or GitHub call", async () => {
    const database = productionDatabase({ rateLimited: true });
    const github = githubAuthorization();

    await expect(
      loadReviewQueue(
        productionApp(database.pool),
        authorizationRequest(),
        SESSION,
        { authorizationPort: github.port, now: NOW },
      ),
    ).rejects.toBeInstanceOf(WebRequestRateLimitExceededError);

    expect(database.connect).toHaveBeenCalledTimes(1);
    expect(
      containsQuery(database.query, "installation.github_installation_id"),
    ).toBe(false);
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(github.getCollaboratorPermission).not.toHaveBeenCalled();
  });

  it("rechecks both live GitHub reads and observes permission revocation", async () => {
    const database = productionDatabase();
    const github = githubAuthorization();
    const app = productionApp(database.pool);
    const request = authorizationRequest();
    github.getCollaboratorPermission
      .mockResolvedValueOnce({ permission: "write", roleName: "maintain" })
      .mockResolvedValueOnce({ permission: "read", roleName: "read" });

    await loadReviewQueue(app, request, SESSION, {
      authorizationPort: github.port,
      now: NOW,
    });
    await expect(
      loadReviewQueue(app, request, SESSION, {
        authorizationPort: github.port,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MaintainerAuthorizationError);

    expect(github.getAuthenticatedUser).toHaveBeenCalledTimes(2);
    expect(github.getCollaboratorPermission).toHaveBeenCalledTimes(2);
    expect(github.getCollaboratorPermission).toHaveBeenLastCalledWith({
      userToken: "request-scoped-maintainer-token",
      owner: "acme",
      repositoryName: "cachekit",
      username: "OctoCat",
    });
  });

  it("rejects an attempt outside the session repository before GitHub or evidence reads", async () => {
    const database = productionDatabase({ activeBinding: false });
    const github = githubAuthorization();
    await expect(
      requireEvidenceAccess(
        productionApp(database.pool),
        authorizationRequest(),
        SESSION,
        ATTEMPT_ID,
        database.pool,
        { authorizationPort: github.port, now: NOW },
      ),
    ).rejects.toBeInstanceOf(MaintainerAuthorizationError);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM attempts attempt"),
      [ATTEMPT_ID, REPOSITORY_ID],
    );
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(
      containsQuery(database.query, "recording.id AS recording_object_id"),
    ).toBe(false);
  });

  it("fails a production detail read closed when the fresh cookie is missing", async () => {
    const database = productionDatabase();
    const github = githubAuthorization();
    await expect(
      loadReviewDetail(
        productionApp(database.pool),
        authorizationRequest({ includeCookie: false }),
        SESSION,
        ATTEMPT_ID,
        { authorizationPort: github.port, now: NOW },
      ),
    ).rejects.toBeInstanceOf(MaintainerAuthorizationError);
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(containsQuery(database.query, "AS frame_count")).toBe(false);
  });

  it("rejects a stale fresh cookie before evidence metadata is read", async () => {
    const database = productionDatabase();
    const github = githubAuthorization();
    await expect(
      requireEvidenceAccess(
        productionApp(database.pool),
        authorizationRequest({
          issuedAt: new Date(NOW.getTime() - 10 * 60_000),
          expiresAt: new Date(NOW.getTime() - 60_000),
        }),
        SESSION,
        ATTEMPT_ID,
        database.pool,
        { authorizationPort: github.port, now: NOW },
      ),
    ).rejects.toBeInstanceOf(MaintainerAuthorizationError);
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(
      containsQuery(database.query, "recording.id AS recording_object_id"),
    ).toBe(false);
  });

  it("rejects a cross-repository fresh cookie before a decision lock or write", async () => {
    const database = productionDatabase();
    const github = githubAuthorization();
    const checkIntents = {
      write: vi.fn(),
    } as unknown as CheckIntentWriter;
    await expect(
      decideReview(
        productionApp(database.pool),
        authorizationRequest({ repositoryId: OTHER_REPOSITORY_ID }),
        SESSION,
        ATTEMPT_ID,
        {
          action: "approve",
          expectedHeadSha: "a".repeat(40),
          idempotencyKey: `review:${ATTEMPT_ID}`,
        },
        checkIntents,
        { authorizationPort: github.port, now: NOW },
      ),
    ).rejects.toBeInstanceOf(MaintainerAuthorizationError);
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(containsQuery(database.query, "FOR UPDATE OF attempt")).toBe(false);
    expect(checkIntents.write).not.toHaveBeenCalled();
  });
});
