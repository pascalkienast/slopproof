import { describe, expect, it } from "vitest";
import {
  GithubUserTokenRejectedError,
  sealGithubUserAccessToken,
  unsealGithubUserAccessToken,
  type GithubUserTokenBinding,
} from "./github-user-token";

const SECRET = "fresh-auth-session-secret-that-is-at-least-32-bytes";
const NOW = new Date("2026-08-12T12:00:00.000Z");
const BINDING: GithubUserTokenBinding = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  githubUserId: "12345678",
  repositoryId: "10000000-0000-4000-8000-000000000002",
  githubRepositoryId: "987654321",
  purpose: "maintainer_reauth",
};

function seal() {
  return sealGithubUserAccessToken(
    {
      accessToken: "request-scoped-user-token",
      binding: BINDING,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    },
    SECRET,
    { entropy: (bytes) => Buffer.alloc(bytes, 7) },
  );
}

describe("sealed GitHub user access token", () => {
  it("round-trips only through the exact AEAD binding without plaintext leakage", () => {
    const sealed = seal();
    expect(sealed).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
    expect(sealed).not.toContain("request-scoped-user-token");
    expect(unsealGithubUserAccessToken(sealed, BINDING, SECRET, NOW)).toEqual({
      accessToken: "request-scoped-user-token",
      issuedAt: NOW,
      expiresAt: new Date("2026-08-12T12:10:00.000Z"),
    });
  });

  it.each([
    { sessionId: "00000000-0000-4000-8000-000000000009" },
    { githubUserId: "87654321" },
    { repositoryId: "10000000-0000-4000-8000-000000000009" },
    { githubRepositoryId: "111111111" },
    { purpose: "contributor_login" as const },
  ])("rejects a changed session/actor/repository/purpose binding", (change) => {
    expect(() =>
      unsealGithubUserAccessToken(
        seal(),
        { ...BINDING, ...change },
        SECRET,
        NOW,
      ),
    ).toThrow(GithubUserTokenRejectedError);
  });

  it("rejects tampering, another secret, and expired authorization", () => {
    const sealed = seal();
    expect(() =>
      unsealGithubUserAccessToken(
        `${sealed.slice(0, -1)}x`,
        BINDING,
        SECRET,
        NOW,
      ),
    ).toThrow(GithubUserTokenRejectedError);
    expect(() =>
      unsealGithubUserAccessToken(sealed, BINDING, `${SECRET}-different`, NOW),
    ).toThrow(GithubUserTokenRejectedError);
    expect(() =>
      unsealGithubUserAccessToken(
        sealed,
        BINDING,
        SECRET,
        new Date("2026-08-12T12:10:00.000Z"),
      ),
    ).toThrow(GithubUserTokenRejectedError);
  });

  it("refuses a lifetime above the short 15-minute cap", () => {
    expect(() =>
      sealGithubUserAccessToken(
        {
          accessToken: "request-scoped-user-token",
          binding: BINDING,
          issuedAt: NOW,
          expiresAt: new Date(NOW.getTime() + 15 * 60_000 + 1),
        },
        SECRET,
      ),
    ).toThrow(GithubUserTokenRejectedError);
  });
});
