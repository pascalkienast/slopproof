import { sealGithubUserAccessToken } from "@understandproof/auth";
import { describe, expect, it } from "vitest";
import {
  GITHUB_USER_TOKEN_COOKIE,
  requireFreshGithubUserToken,
} from "./github-oauth-token";

const SECRET = "fresh-auth-session-secret-that-is-at-least-32-bytes";
const NOW = new Date("2026-08-12T12:00:00.000Z");
const SESSION = {
  id: "00000000-0000-4000-8000-000000000001",
  actorId: "12345678",
  actorRole: "maintainer" as const,
  repositoryId: "10000000-0000-4000-8000-000000000002",
  csrfHash: "c".repeat(64),
  expiresAt: new Date(NOW.getTime() + 60 * 60_000),
};

function tokenCookie() {
  return sealGithubUserAccessToken(
    {
      accessToken: "request-scoped-user-token",
      binding: {
        sessionId: SESSION.id,
        githubUserId: SESSION.actorId,
        repositoryId: SESSION.repositoryId,
        githubRepositoryId: "987654321",
        purpose: "maintainer_reauth",
      },
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    },
    SECRET,
    { entropy: (bytes) => Buffer.alloc(bytes, 5) },
  );
}

describe("fresh GitHub user-token web helper", () => {
  it("unseals only after binding to the authenticated session and repository", () => {
    const request = new Request("https://slopproof.example/api/review", {
      headers: { cookie: `${GITHUB_USER_TOKEN_COOKIE}=${tokenCookie()}` },
    });
    expect(
      requireFreshGithubUserToken(request, {
        session: SESSION,
        githubRepositoryId: "987654321",
        purpose: "maintainer_reauth",
        sessionSecret: SECRET,
        now: NOW,
      }),
    ).toEqual({
      accessToken: "request-scoped-user-token",
      issuedAt: NOW,
      expiresAt: new Date("2026-08-12T12:10:00.000Z"),
    });
  });

  it("rejects a different session/repository without exposing token material", () => {
    const request = new Request("https://slopproof.example/api/review", {
      headers: { cookie: `${GITHUB_USER_TOKEN_COOKIE}=${tokenCookie()}` },
    });
    const error = (() => {
      try {
        requireFreshGithubUserToken(request, {
          session: { ...SESSION, actorId: "87654321" },
          githubRepositoryId: "987654321",
          purpose: "maintainer_reauth",
          sessionSecret: SECRET,
          now: NOW,
        });
      } catch (caught) {
        return caught;
      }
    })();
    expect(String(error)).toBe(
      "GithubUserTokenRejectedError: GitHub user authorization is unavailable.",
    );
    expect(String(error)).not.toContain("request-scoped-user-token");
  });
});
