import {
  sealGithubUserAccessToken,
  type AuthenticatedSession,
} from "@slopproof/auth";
import type { GithubUserAuthorizationPort } from "@slopproof/github";
import { describe, expect, it, vi } from "vitest";
import {
  MaintainerAuthorizationError,
  requireFreshMaintainerAuthorization,
  requireRequestMaintainerAuthorization,
  type SqlExecutor,
} from "./maintainer-authorization";
import type { WebRuntime } from "./runtime";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const SESSION_SECRET = "maintainer-session-secret-that-is-at-least-32-bytes";
const REPOSITORY_ID = "10000000-0000-4000-8000-000000000002";
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

function executor(row: unknown = REPOSITORY_ROW) {
  const query = vi.fn(async () => ({
    rows: row ? [row] : [],
    rowCount: row ? 1 : 0,
  })) as unknown as SqlExecutor["query"];
  return { query, executor: { query } as SqlExecutor };
}

function app(sql: SqlExecutor, profile: "local" | "production"): WebRuntime {
  return {
    config: {
      DEPLOYMENT_PROFILE: profile,
      GITHUB_ADAPTER: profile === "production" ? "octokit" : "fake",
      DEMO_MODE: profile === "local",
      SESSION_SECRET,
    },
    database: { pool: sql },
  } as unknown as WebRuntime;
}

function sealedRequest(
  session: AuthenticatedSession = SESSION,
  githubRepositoryId = "987654321",
): Request {
  const sealed = sealGithubUserAccessToken(
    {
      accessToken: "request-scoped-user-token",
      binding: {
        sessionId: session.id,
        githubUserId: session.actorId,
        repositoryId: session.repositoryId!,
        githubRepositoryId,
        purpose: "maintainer_reauth",
      },
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    },
    SESSION_SECRET,
    { entropy: (bytes) => Buffer.alloc(bytes, 4) },
  );
  return new Request("https://slopproof.example/api/review", {
    headers: { cookie: `__Host-slopproof_github_user=${sealed}` },
  });
}

function authorizationPort(
  permission: "admin" | "write" | "read" | "none" = "write",
  roleName = "maintain",
) {
  const getAuthenticatedUser = vi.fn(async () => ({
    id: "12345678",
    login: "OctoCat",
  }));
  const getCollaboratorPermission = vi.fn(async () => ({
    permission,
    roleName,
  }));
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

describe("maintainer authorization", () => {
  it("preserves the repository-bound local fake authorization", async () => {
    const database = executor();
    const localSession = {
      ...SESSION,
      actorId: "demo-maintainer",
    };
    await expect(
      requireFreshMaintainerAuthorization(
        app(database.executor, "local"),
        localSession,
        database.executor,
      ),
    ).resolves.toEqual({
      actorId: "demo-maintainer",
      sessionId: SESSION.id,
      repositoryId: REPOSITORY_ID,
      owner: "acme",
      name: "cachekit",
      githubRepositoryId: "987654321",
      githubInstallationId: "87654321",
      githubLogin: "demo-maintainer",
      permission: "admin",
      roleName: "local-demo",
      source: "local-demo",
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("repository.status = 'active'"),
      [REPOSITORY_ID, REPOSITORY_ID],
    );
  });

  it("uses the sealed request token for fresh identity and repository permission checks", async () => {
    const database = executor();
    const github = authorizationPort("write", "maintain");
    const authorized = await requireRequestMaintainerAuthorization(
      app(database.executor, "production"),
      {
        request: sealedRequest(),
        session: SESSION,
        binding: { kind: "repository", repositoryId: REPOSITORY_ID },
        executor: database.executor,
      },
      { authorizationPort: github.port, now: NOW },
    );

    expect(github.getAuthenticatedUser).toHaveBeenCalledWith({
      userToken: "request-scoped-user-token",
    });
    expect(github.getCollaboratorPermission).toHaveBeenCalledWith({
      userToken: "request-scoped-user-token",
      owner: "acme",
      repositoryName: "cachekit",
      username: "OctoCat",
    });
    expect(authorized).toEqual({
      actorId: "12345678",
      sessionId: SESSION.id,
      repositoryId: REPOSITORY_ID,
      owner: "acme",
      name: "cachekit",
      githubRepositoryId: "987654321",
      githubInstallationId: "87654321",
      githubLogin: "OctoCat",
      permission: "write",
      roleName: "maintain",
      source: "github-live",
    });
    expect(JSON.stringify(authorized)).not.toContain(
      "request-scoped-user-token",
    );
  });

  it("loads an attempt-bound active repository instead of trusting session scope alone", async () => {
    const database = executor();
    const github = authorizationPort("admin", "admin");
    await requireRequestMaintainerAuthorization(
      app(database.executor, "production"),
      {
        request: sealedRequest(),
        session: SESSION,
        binding: { kind: "attempt", attemptId: ATTEMPT_ID },
        executor: database.executor,
      },
      { authorizationPort: github.port, now: NOW },
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM attempts attempt"),
      [ATTEMPT_ID, REPOSITORY_ID],
    );
  });

  it.each([
    ["admin", "admin"],
    ["write", "maintain"],
    ["write", "write"],
    ["write", "release-manager"],
  ] as const)(
    "accepts live %s/%s maintainer authority",
    async (permission, roleName) => {
      const database = executor();
      const github = authorizationPort(permission, roleName);
      await expect(
        requireRequestMaintainerAuthorization(
          app(database.executor, "production"),
          {
            request: sealedRequest(),
            session: SESSION,
            binding: { kind: "repository", repositoryId: REPOSITORY_ID },
          },
          { authorizationPort: github.port, now: NOW },
        ),
      ).resolves.toMatchObject({ permission, roleName, source: "github-live" });
    },
  );

  it.each([
    ["read", "triage"],
    ["read", "read"],
    ["none", "none"],
    ["write", "triage"],
  ] as const)(
    "rejects insufficient live %s/%s authority",
    async (permission, roleName) => {
      const database = executor();
      const github = authorizationPort(permission, roleName);
      await expect(
        requireRequestMaintainerAuthorization(
          app(database.executor, "production"),
          {
            request: sealedRequest(),
            session: SESSION,
            binding: { kind: "repository", repositoryId: REPOSITORY_ID },
          },
          { authorizationPort: github.port, now: NOW },
        ),
      ).rejects.toBeInstanceOf(MaintainerAuthorizationError);
    },
  );

  it("rejects an identity inconsistent with the session before permission lookup", async () => {
    const database = executor();
    const github = authorizationPort();
    github.getAuthenticatedUser.mockResolvedValue({
      id: "87654321",
      login: "someone-else",
    });
    await expect(
      requireRequestMaintainerAuthorization(
        app(database.executor, "production"),
        {
          request: sealedRequest(),
          session: SESSION,
          binding: { kind: "repository", repositoryId: REPOSITORY_ID },
        },
        { authorizationPort: github.port, now: NOW },
      ),
    ).rejects.toBeInstanceOf(MaintainerAuthorizationError);
    expect(github.getCollaboratorPermission).not.toHaveBeenCalled();
  });

  it("rejects a token bound to another repository without making GitHub calls", async () => {
    const database = executor();
    const github = authorizationPort();
    await expect(
      requireRequestMaintainerAuthorization(
        app(database.executor, "production"),
        {
          request: sealedRequest(SESSION, "987654322"),
          session: SESSION,
          binding: { kind: "repository", repositoryId: REPOSITORY_ID },
        },
        { authorizationPort: github.port, now: NOW },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        message: "Maintainer authorization is required.",
      }),
    );
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("keeps provider errors and token material out of the public error", async () => {
    const database = executor();
    const github = authorizationPort();
    github.getAuthenticatedUser.mockRejectedValue(
      new Error("provider exposed request-scoped-user-token"),
    );
    const error = await requireRequestMaintainerAuthorization(
      app(database.executor, "production"),
      {
        request: sealedRequest(),
        session: SESSION,
        binding: { kind: "repository", repositoryId: REPOSITORY_ID },
      },
      { authorizationPort: github.port, now: NOW },
    ).catch((caught: unknown) => caught);
    expect(String(error)).toBe(
      "MaintainerAuthorizationError: Maintainer authorization is required.",
    );
    expect(String(error)).not.toContain("request-scoped-user-token");
  });

  it("keeps the legacy API fail-closed in production", async () => {
    const database = executor();
    await expect(
      requireFreshMaintainerAuthorization(
        app(database.executor, "production"),
        SESSION,
      ),
    ).rejects.toBeInstanceOf(MaintainerAuthorizationError);
  });
});
