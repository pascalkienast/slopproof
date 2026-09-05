import type {
  GithubOAuthCallback,
  GithubOAuthStart,
  IssuedSession,
} from "@understandproof/auth";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_OAUTH_FLOW_COOKIE,
  handleGithubOAuthCallback,
  handleGithubOAuthLogout,
  handleGithubOAuthStart,
} from "./github-oauth-routes";
import type {
  GithubOAuthRuntimeResolver,
  GithubOAuthWebRuntime,
} from "./github-oauth-runtime";
import {
  GithubOAuthStartPolicyError,
  GithubOAuthStartRateLimitError,
} from "./github-oauth-runtime";
import { MAINTAINER_DIRECTORY_COOKIE } from "./maintainer-directory";
import { GITHUB_USER_TOKEN_COOKIE } from "./github-oauth-token";

const REPOSITORY_ID = "10000000-0000-4000-8000-000000000002";
const PRACTICE_PATH =
  "/revisions/20000000-0000-4000-8000-000000000003/contribute/practice";

function issuedSession(): IssuedSession {
  return {
    session: {
      id: "00000000-0000-4000-8000-000000000001",
      actorId: "12345678",
      actorRole: "maintainer",
      repositoryId: REPOSITORY_ID,
      csrfHash: "c".repeat(64),
      expiresAt: new Date("2099-08-12T20:00:00.000Z"),
    },
    sessionToken: "new-session-token",
    csrfToken: "new-csrf-token",
  };
}

function harness() {
  const startResult: GithubOAuthStart = {
    authorizationUrl: new URL(
      "https://github.com/login/oauth/authorize?state=provider-state",
    ),
    sealedCookie: "v1.sealed-pkce-cookie",
    cookieExpiresAt: new Date("2099-08-12T12:05:00.000Z"),
  };
  const callbackResult: GithubOAuthCallback = {
    kind: "session",
    issuedSession: issuedSession(),
    redirectPath: PRACTICE_PATH,
    user: { githubUserId: "12345678", login: "octocat" },
    binding: {
      purpose: "maintainer_reauth",
      repositoryId: REPOSITORY_ID,
      githubRepositoryId: "987654321",
    },
    sealedUserToken: "v1.sealed-user-token",
    userTokenExpiresAt: new Date("2099-08-12T12:10:00.000Z"),
    userTokenMaxAgeSeconds: 600,
  };
  const oauth = {
    callbackUrl: "https://slopproof.example/api/auth/github/callback",
    stateTtlMs: 5 * 60_000,
    freshTokenTtlMs: 10 * 60_000,
    start: vi.fn(async () => startResult),
    callback: vi.fn(async (): Promise<GithubOAuthCallback> => callbackResult),
    logout: vi.fn(async () => {}),
  };
  const resolveStartBinding = vi.fn(async () => callbackResult.binding);
  const runtime: GithubOAuthWebRuntime = {
    appBaseUrl: "https://slopproof.example/",
    oauth,
    resolveStartBinding,
  };
  const resolve: GithubOAuthRuntimeResolver = async () => runtime;
  return { resolve, runtime, oauth, resolveStartBinding };
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe("GitHub OAuth route handlers", () => {
  it("starts from an exact allowlisted practice path with a sealed PKCE cookie", async () => {
    const test = harness();
    const response = await handleGithubOAuthStart(
      new Request(
        `https://slopproof.example/api/auth/github/start?returnTo=${encodeURIComponent(PRACTICE_PATH)}`,
      ),
      test.resolve,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?state=provider-state",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(test.resolveStartBinding).toHaveBeenCalledWith({
      request: expect.any(Request),
      requestedRedirectPath: PRACTICE_PATH,
    });
    expect(test.oauth.start).toHaveBeenCalledWith({
      binding: {
        purpose: "maintainer_reauth",
        repositoryId: REPOSITORY_ID,
        githubRepositoryId: "987654321",
      },
      requestedRedirectPath: PRACTICE_PATH,
    });
    expect(setCookies(response).join("\n")).toContain(
      `${GITHUB_OAUTH_FLOW_COOKIE}=v1.sealed-pkce-cookie`,
    );
    expect(setCookies(response).join("\n")).toContain("HttpOnly");
    expect(setCookies(response).join("\n")).toContain("Secure");
    expect(setCookies(response).join("\n")).toContain("SameSite=lax");
    expect(setCookies(response).join("\n")).toContain(
      "Path=/api/auth/github/callback",
    );
  });

  it("returns value-free policy and rate-limit responses before OAuth state creation", async () => {
    const policyRejected = await handleGithubOAuthStart(
      new Request("https://slopproof.example/api/auth/github/start"),
      async () => {
        throw new GithubOAuthStartPolicyError();
      },
    );
    expect(policyRejected.status).toBe(400);
    expect(await policyRejected.json()).toEqual({ error: "oauth_rejected" });

    const rateLimited = await handleGithubOAuthStart(
      new Request("https://slopproof.example/api/auth/github/start"),
      async () => {
        throw new GithubOAuthStartRateLimitError(123);
      },
    );
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBe("123");
    expect(await rateLimited.json()).toEqual({ error: "rate_limited" });
  });

  it("allows a local review repositoryId and rejects extra start parameters", async () => {
    const allowed = harness();
    const response = await handleGithubOAuthStart(
      new Request(
        `https://slopproof.example/api/auth/github/start?returnTo=${encodeURIComponent("/review")}&repositoryId=${REPOSITORY_ID}`,
      ),
      allowed.resolve,
    );
    expect(response.status).toBe(302);
    expect(allowed.resolveStartBinding).toHaveBeenCalledWith({
      request: expect.any(Request),
      requestedRedirectPath: "/review",
    });

    const rejected = await handleGithubOAuthStart(
      new Request(
        `https://slopproof.example/api/auth/github/start?returnTo=${encodeURIComponent("/review")}&repositoryId=${REPOSITORY_ID}&repositoryId=${REPOSITORY_ID}`,
      ),
      harness().resolve,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "oauth_rejected" });
  });

  it("accepts GitHub iss on the callback query allowlist and ignores its value", async () => {
    const test = harness();
    const response = await handleGithubOAuthCallback(
      new Request(
        "https://slopproof.example/api/auth/github/callback?code=one-use-code&state=one-use-state&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth",
        {
          headers: {
            cookie: `${GITHUB_OAUTH_FLOW_COOKIE}=v1.sealed-pkce-cookie`,
          },
        },
      ),
      test.resolve,
    );
    expect(response.status).toBe(303);
    expect(test.oauth.callback).toHaveBeenCalledWith({
      code: "one-use-code",
      state: "one-use-state",
      sealedCookie: "v1.sealed-pkce-cookie",
    });
  });

  it("still rejects unknown callback query keys after allowing iss", async () => {
    const test = harness();
    const response = await handleGithubOAuthCallback(
      new Request(
        "https://slopproof.example/api/auth/github/callback?code=one-use-code&state=one-use-state&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth&scope=repo",
        {
          headers: {
            cookie: `${GITHUB_OAUTH_FLOW_COOKIE}=v1.sealed-pkce-cookie`,
          },
        },
      ),
      test.resolve,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "GitHub authorization did not finish",
    );
    expect(test.oauth.callback).not.toHaveBeenCalled();
  });

  it("sets only a sealed directory cookie after identify and does not install a session", async () => {
    const test = harness();
    test.oauth.callback.mockResolvedValueOnce({
      kind: "identify",
      redirectPath: "/review",
      user: { githubUserId: "12345678", login: "octocat" },
      binding: { purpose: "maintainer_identify" },
      sealedDirectory: "v1.sealed-directory-cookie",
      directoryExpiresAt: new Date("2099-08-12T12:15:00.000Z"),
      directoryMaxAgeSeconds: 900,
    });
    const response = await handleGithubOAuthCallback(
      new Request(
        "https://slopproof.example/api/auth/github/callback?code=one-use-code&state=one-use-state",
        {
          headers: {
            cookie: `${GITHUB_OAUTH_FLOW_COOKIE}=v1.sealed-pkce-cookie`,
          },
        },
      ),
      test.resolve,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://slopproof.example/review",
    );
    const cookies = setCookies(response).join("\n");
    expect(cookies).toContain(
      `${MAINTAINER_DIRECTORY_COOKIE}=v1.sealed-directory-cookie`,
    );
    expect(cookies).not.toContain("slopproof_session=");
    expect(cookies).not.toContain(`${GITHUB_USER_TOKEN_COOKIE}=v1.`);
    expect(cookies).not.toContain("request-scoped-user-token");
    expect(await response.text()).toBe("");
  });

  it("rotates session and sets only sealed Fresh-Auth material on callback", async () => {
    const test = harness();
    const response = await handleGithubOAuthCallback(
      new Request(
        "https://slopproof.example/api/auth/github/callback?code=one-use-code&state=one-use-state",
        {
          headers: {
            cookie: `${GITHUB_OAUTH_FLOW_COOKIE}=v1.sealed-pkce-cookie; slopproof_session=old-session-token`,
          },
        },
      ),
      test.resolve,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://slopproof.example${PRACTICE_PATH}`,
    );
    expect(test.oauth.callback).toHaveBeenCalledWith({
      code: "one-use-code",
      state: "one-use-state",
      sealedCookie: "v1.sealed-pkce-cookie",
      currentSessionToken: "old-session-token",
    });
    const cookies = setCookies(response).join("\n");
    expect(cookies).toContain("slopproof_session=new-session-token");
    expect(cookies).toContain("slopproof_csrf=new-csrf-token");
    expect(
      setCookies(response).find((cookie) =>
        cookie.startsWith("slopproof_csrf="),
      ),
    ).toContain("SameSite=lax");
    expect(cookies).toContain(
      `${GITHUB_USER_TOKEN_COOKIE}=v1.sealed-user-token`,
    );
    expect(cookies).toContain("Max-Age=600");
    expect(cookies).toContain(`${GITHUB_OAUTH_FLOW_COOKIE}=`);
    expect(cookies).not.toContain("request-scoped-user-token");
    expect(await response.text()).toBe("");
  });

  it("renders provider denial and duplicate callback parameters as value-free recovery pages", async () => {
    const test = harness();
    const denied = await handleGithubOAuthCallback(
      new Request(
        "https://slopproof.example/api/auth/github/callback?error=access_denied&error_description=provider-private-marker&state=state",
      ),
      test.resolve,
    );
    expect(denied.status).toBe(400);
    const deniedBody = await denied.text();
    expect(denied.headers.get("content-type")).toContain("text/html");
    expect(denied.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(deniedBody).toContain("GitHub authorization did not finish");
    expect(deniedBody).toContain("Return to UnderstandProof");
    expect(deniedBody).not.toContain("provider-private-marker");
    expect(test.oauth.callback).not.toHaveBeenCalled();
    expect(setCookies(denied).join("\n")).toContain(
      `${GITHUB_USER_TOKEN_COOKIE}=`,
    );

    const duplicate = await handleGithubOAuthCallback(
      new Request(
        "https://slopproof.example/api/auth/github/callback?code=a&code=b&state=c",
      ),
      test.resolve,
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).toContain(
      "GitHub authorization did not finish",
    );
  });

  it("renders provider outages without leaking internal failures", async () => {
    const test = harness();
    test.oauth.callback.mockRejectedValueOnce(
      new Error("provider-private-upstream-marker"),
    );
    const response = await handleGithubOAuthCallback(
      new Request(
        "https://slopproof.example/api/auth/github/callback?code=one-use-code&state=one-use-state",
        {
          headers: {
            cookie: `${GITHUB_OAUTH_FLOW_COOKIE}=v1.sealed-pkce-cookie`,
          },
        },
      ),
      test.resolve,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    expect(body).toContain("GitHub is temporarily unavailable");
    expect(body).not.toContain("provider-private-upstream-marker");
    expect(setCookies(response).join("\n")).toContain(
      `${GITHUB_USER_TOKEN_COOKIE}=`,
    );
  });

  it("revokes with exact Origin and session-bound CSRF, then clears every auth cookie", async () => {
    const test = harness();
    const response = await handleGithubOAuthLogout(
      new Request("https://slopproof.example/api/auth/github/logout", {
        method: "POST",
        headers: {
          origin: "https://slopproof.example",
          "x-slopproof-csrf": "current-csrf-token",
          cookie: "slopproof_session=current-session-token",
        },
      }),
      test.resolve,
    );
    expect(response.status).toBe(204);
    expect(test.oauth.logout).toHaveBeenCalledWith({
      sessionToken: "current-session-token",
      csrfToken: "current-csrf-token",
    });
    const cookies = setCookies(response).join("\n");
    expect(cookies).toContain("slopproof_session=");
    expect(cookies).toContain("slopproof_csrf=");
    expect(cookies).toContain(`${GITHUB_OAUTH_FLOW_COOKIE}=`);
    expect(cookies).toContain(`${GITHUB_USER_TOKEN_COOKIE}=`);
    expect(cookies).toContain(`${MAINTAINER_DIRECTORY_COOKIE}=`);
    expect(cookies).toContain("Max-Age=0");
  });

  it("does not revoke or clear cookies on an invalid Origin/CSRF request", async () => {
    const test = harness();
    const response = await handleGithubOAuthLogout(
      new Request("https://slopproof.example/api/auth/github/logout", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          cookie: "slopproof_session=current-session-token",
        },
      }),
      test.resolve,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "oauth_rejected" });
    expect(test.oauth.logout).not.toHaveBeenCalled();
    expect(setCookies(response)).toHaveLength(0);
  });
});
