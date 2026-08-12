import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IssuedSession } from "./session";
import { unsealGithubUserAccessToken } from "./github-user-token";
import {
  GithubOAuthRejectedError,
  GithubOAuthService,
  GithubOAuthUnavailableError,
  type GithubOAuthBinding,
  type GithubOAuthClient,
  type GithubOAuthSessionPort,
  type GithubOAuthStateRecord,
  type GithubOAuthStateRepository,
} from "./github-oauth";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const SECRET = "github-oauth-session-secret-that-is-at-least-32-bytes";
const REPOSITORY_ID = "10000000-0000-4000-8000-000000000002";
const BINDING: GithubOAuthBinding = {
  purpose: "maintainer_reauth",
  repositoryId: REPOSITORY_ID,
  githubRepositoryId: "987654321",
};

type Harness = ReturnType<typeof createHarness>;

function issuedSession(): IssuedSession {
  return {
    session: {
      id: "00000000-0000-4000-8000-000000000001",
      actorId: "12345678",
      actorRole: "maintainer",
      repositoryId: REPOSITORY_ID,
      csrfHash: "c".repeat(64),
      expiresAt: new Date(NOW.getTime() + 8 * 60 * 60_000),
    },
    sessionToken: "new-session-token",
    csrfToken: "new-csrf-token",
  };
}

function createHarness() {
  const records = new Map<string, GithubOAuthStateRecord>();
  const created: GithubOAuthStateRecord[] = [];
  const stateRepository: GithubOAuthStateRepository = {
    async create(record) {
      created.push(record);
      records.set(record.stateHash, record);
    },
    async consume({ stateHash, now }) {
      const record = records.get(stateHash);
      if (!record || record.expiresAt <= now) return null;
      records.delete(stateHash);
      return record;
    },
  };
  const client: GithubOAuthClient = {
    exchangeCode: vi.fn(async () => ({
      accessToken: "request-scoped-user-token",
      expiresAt: new Date(NOW.getTime() + 8 * 60 * 60_000),
    })),
    getUser: vi.fn(async () => ({
      githubUserId: "12345678",
      login: "octocat",
    })),
  };
  const sessions: GithubOAuthSessionPort = {
    rotate: vi.fn(async () => issuedSession()),
    revoke: vi.fn(async () => {}),
  };
  let entropyCall = 0;
  const entropy = (bytes: number): Buffer => {
    entropyCall += 1;
    return Buffer.alloc(bytes, entropyCall);
  };
  const service = new GithubOAuthService({
    clientId: "Iv1.slopproof-client",
    callbackUrl: "https://slopproof.example/api/auth/github/callback",
    sessionSecret: SECRET,
    allowedRedirectPaths: ["/", "/review"],
    defaultRedirectPath: "/",
    stateRepository,
    client,
    sessions,
    now: () => new Date(NOW),
    entropy,
  });
  return { service, stateRepository, client, sessions, records, created };
}

async function started(harness: Harness, redirectPath = "/review") {
  const start = await harness.service.start({
    binding: BINDING,
    requestedRedirectPath: redirectPath,
  });
  const state = start.authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("test setup expected state");
  return { start, state };
}

describe("GitHub OAuth service", () => {
  it("persists only a state hash and creates an exact GitHub App PKCE URL", async () => {
    const harness = createHarness();
    const { start, state } = await started(harness);

    expect(start.authorizationUrl.origin).toBe("https://github.com");
    expect(start.authorizationUrl.pathname).toBe("/login/oauth/authorize");
    expect(Object.fromEntries(start.authorizationUrl.searchParams)).toEqual({
      client_id: "Iv1.slopproof-client",
      redirect_uri: "https://slopproof.example/api/auth/github/callback",
      state,
      code_challenge: createHash("sha256")
        .update(Buffer.alloc(32, 2).toString("base64url"), "ascii")
        .digest("base64url"),
      code_challenge_method: "S256",
      allow_signup: "false",
    });
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]).toEqual(
      expect.objectContaining({
        ...BINDING,
        redirectPath: "/review",
      }),
    );
    expect(harness.created[0]?.stateHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.created[0]?.stateHash).not.toBe(state);
    expect(JSON.stringify(harness.created)).not.toContain(state);
    expect(JSON.stringify(harness.created)).not.toContain(
      Buffer.alloc(32, 2).toString("base64url"),
    );
    expect(start.sealedCookie).not.toContain(state);
    expect(start.cookieExpiresAt.toISOString()).toBe(
      "2026-08-12T12:05:00.000Z",
    );
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/review?next=/",
    "/other",
  ])(
    "rejects a redirect that is not an exact local allowlist member: %s",
    async (redirectPath) => {
      const harness = createHarness();
      await expect(
        harness.service.start({
          binding: BINDING,
          requestedRedirectPath: redirectPath,
        }),
      ).rejects.toBeInstanceOf(GithubOAuthRejectedError);
      expect(harness.created).toHaveLength(0);
    },
  );

  it("limits the exchange to one repository, rotates the session, and returns only a sealed user token", async () => {
    const harness = createHarness();
    const { start, state } = await started(harness);

    const result = await harness.service.callback({
      code: "provider-code",
      state,
      sealedCookie: start.sealedCookie,
      currentSessionToken: "old-session-token",
    });

    expect(harness.client.exchangeCode).toHaveBeenCalledWith({
      code: "provider-code",
      codeVerifier: Buffer.alloc(32, 2).toString("base64url"),
      redirectUri: "https://slopproof.example/api/auth/github/callback",
      repositoryId: "987654321",
    });
    expect(harness.client.getUser).toHaveBeenCalledWith(
      "request-scoped-user-token",
    );
    expect(harness.sessions.rotate).toHaveBeenCalledWith({
      user: { githubUserId: "12345678", login: "octocat" },
      binding: BINDING,
      actorRole: "maintainer",
      redirectPath: "/review",
      currentSessionToken: "old-session-token",
      ttlMs: 8 * 60 * 60_000,
      now: NOW,
    });
    expect(
      JSON.stringify(vi.mocked(harness.sessions.rotate).mock.calls),
    ).not.toContain("request-scoped-user-token");
    expect(JSON.stringify(result)).not.toContain("request-scoped-user-token");
    expect(result.userTokenExpiresAt.toISOString()).toBe(
      "2026-08-12T12:10:00.000Z",
    );
    expect(result.userTokenMaxAgeSeconds).toBe(600);
    expect(
      unsealGithubUserAccessToken(
        result.sealedUserToken,
        {
          sessionId: result.issuedSession.session.id,
          githubUserId: result.user.githubUserId,
          repositoryId: BINDING.repositoryId,
          githubRepositoryId: BINDING.githubRepositoryId,
          purpose: BINDING.purpose,
        },
        SECRET,
        NOW,
      ),
    ).toEqual({
      accessToken: "request-scoped-user-token",
      issuedAt: NOW,
      expiresAt: new Date("2026-08-12T12:10:00.000Z"),
    });
    expect(result.redirectPath).toBe("/review");
    expect(result.issuedSession.sessionToken).toBe("new-session-token");
    expect(harness.records.size).toBe(0);

    await expect(
      harness.service.callback({
        code: "provider-code",
        state,
        sealedCookie: start.sealedCookie,
      }),
    ).rejects.toBeInstanceOf(GithubOAuthRejectedError);
  });

  it("rejects state mismatch and cookie tampering before provider calls", async () => {
    const harness = createHarness();
    const { start } = await started(harness);
    const differentState = Buffer.alloc(32, 9).toString("base64url");

    await expect(
      harness.service.callback({
        code: "provider-code",
        state: differentState,
        sealedCookie: start.sealedCookie,
      }),
    ).rejects.toBeInstanceOf(GithubOAuthRejectedError);
    await expect(
      harness.service.callback({
        code: "provider-code",
        state: start.authorizationUrl.searchParams.get("state")!,
        sealedCookie: `${start.sealedCookie.slice(0, -1)}x`,
      }),
    ).rejects.toBeInstanceOf(GithubOAuthRejectedError);
    expect(harness.client.exchangeCode).not.toHaveBeenCalled();
  });

  it("fails closed when persistence, provider exchange, or session binding is invalid", async () => {
    const createFailure = createHarness();
    createFailure.stateRepository.create = async () => {
      throw new Error("database detail must not escape");
    };
    await expect(
      createFailure.service.start({ binding: BINDING }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GithubOAuthUnavailableError",
        message: "GitHub OAuth is unavailable.",
      }),
    );

    const providerFailure = createHarness();
    const providerStart = await started(providerFailure);
    providerFailure.client.exchangeCode = async () => {
      throw new Error("provider payload and code must not escape");
    };
    await expect(
      providerFailure.service.callback({
        code: "private-provider-code",
        state: providerStart.state,
        sealedCookie: providerStart.start.sealedCookie,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GithubOAuthUnavailableError",
        message: "GitHub OAuth is unavailable.",
      }),
    );

    const badSession = createHarness();
    const badSessionStart = await started(badSession);
    badSession.sessions.rotate = async () => ({
      ...issuedSession(),
      session: { ...issuedSession().session, repositoryId: null },
    });
    await expect(
      badSession.service.callback({
        code: "private-provider-code",
        state: badSessionStart.state,
        sealedCookie: badSessionStart.start.sealedCookie,
      }),
    ).rejects.toBeInstanceOf(GithubOAuthUnavailableError);
  });

  it("revokes logout through the session/CSRF port without provider material", async () => {
    const harness = createHarness();
    await harness.service.logout({
      sessionToken: "current-session-token",
      csrfToken: "current-csrf-token",
    });
    expect(harness.sessions.revoke).toHaveBeenCalledWith({
      sessionToken: "current-session-token",
      csrfToken: "current-csrf-token",
      now: NOW,
    });
  });

  it("validates callback, binding, secret, and bounded TTL configuration", async () => {
    const harness = createHarness();
    const base = {
      clientId: "client",
      callbackUrl: "https://slopproof.example/api/auth/github/callback",
      sessionSecret: SECRET,
      allowedRedirectPaths: ["/"],
      defaultRedirectPath: "/",
      stateRepository: harness.stateRepository,
      client: harness.client,
      sessions: harness.sessions,
    };
    expect(
      () =>
        new GithubOAuthService({
          ...base,
          callbackUrl: "https://slopproof.example/wrong",
        }),
    ).toThrow(GithubOAuthRejectedError);
    expect(
      () =>
        new GithubOAuthService({
          ...base,
          sessionSecret: "too-short",
        }),
    ).toThrow(GithubOAuthRejectedError);
    expect(
      () =>
        new GithubOAuthService({ ...base, freshTokenTtlMs: 15 * 60_000 + 1 }),
    ).toThrow(GithubOAuthRejectedError);
    await expect(
      harness.service.start({
        binding: { ...BINDING, githubRepositoryId: "not-a-number" },
      }),
    ).rejects.toBeInstanceOf(GithubOAuthRejectedError);
    expect(GithubOAuthUnavailableError).toBeDefined();
  });
});
