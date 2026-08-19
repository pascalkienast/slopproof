import { describe, expect, it } from "vitest";
import {
  GITHUB_USER_SEAL_TTL_MS,
  GithubUserTokenRejectedError,
  sealGithubMaintainerDirectory,
  sealGithubUserAccessToken,
  unsealGithubMaintainerDirectory,
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
          expiresAt: new Date(NOW.getTime() + GITHUB_USER_SEAL_TTL_MS + 1),
        },
        SECRET,
      ),
    ).toThrow(GithubUserTokenRejectedError);
  });
});

const FIRST_REPOSITORY_ID = "10000000-0000-4000-8000-000000000002";
const SECOND_REPOSITORY_ID = "40000000-0000-4000-8000-000000000005";

function sealDirectory() {
  return sealGithubMaintainerDirectory(
    {
      githubUserId: "12345678",
      repositoryIds: [FIRST_REPOSITORY_ID, SECOND_REPOSITORY_ID],
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + GITHUB_USER_SEAL_TTL_MS),
    },
    SECRET,
    { entropy: (bytes) => Buffer.alloc(bytes, 9) },
  );
}

describe("sealed GitHub maintainer directory", () => {
  it("round-trips repository ids without owner/name or token material", () => {
    const sealed = sealDirectory();
    expect(sealed).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
    expect(sealed).not.toContain("pascalkienast");
    expect(sealed).not.toContain("pixelcampus");
    expect(sealed).not.toContain("request-scoped-user-token");
    expect(unsealGithubMaintainerDirectory(sealed, SECRET, NOW)).toEqual({
      githubUserId: "12345678",
      repositoryIds: [FIRST_REPOSITORY_ID, SECOND_REPOSITORY_ID],
      issuedAt: NOW,
      expiresAt: new Date("2026-08-12T12:15:00.000Z"),
    });
  });

  it("rejects a user-token cookie and a directory cookie at each other's AAD", () => {
    expect(() => unsealGithubMaintainerDirectory(seal(), SECRET, NOW)).toThrow(
      GithubUserTokenRejectedError,
    );
    expect(() =>
      unsealGithubUserAccessToken(sealDirectory(), BINDING, SECRET, NOW),
    ).toThrow(GithubUserTokenRejectedError);
  });

  it("rejects tampering, another secret, and expired authorization", () => {
    const sealed = sealDirectory();
    expect(() =>
      unsealGithubMaintainerDirectory(`${sealed.slice(0, -1)}x`, SECRET, NOW),
    ).toThrow(GithubUserTokenRejectedError);
    expect(() =>
      unsealGithubMaintainerDirectory(sealed, `${SECRET}-different`, NOW),
    ).toThrow(GithubUserTokenRejectedError);
    expect(() =>
      unsealGithubMaintainerDirectory(
        sealed,
        SECRET,
        new Date("2026-08-12T12:15:00.000Z"),
      ),
    ).toThrow(GithubUserTokenRejectedError);
  });

  it("refuses a lifetime above the short 15-minute cap", () => {
    expect(() =>
      sealGithubMaintainerDirectory(
        {
          githubUserId: "12345678",
          repositoryIds: [FIRST_REPOSITORY_ID],
          issuedAt: NOW,
          expiresAt: new Date(NOW.getTime() + GITHUB_USER_SEAL_TTL_MS + 1),
        },
        SECRET,
      ),
    ).toThrow(GithubUserTokenRejectedError);
  });

  it("refuses duplicate repository ids", () => {
    expect(() =>
      sealGithubMaintainerDirectory(
        {
          githubUserId: "12345678",
          repositoryIds: [FIRST_REPOSITORY_ID, FIRST_REPOSITORY_ID],
          issuedAt: NOW,
          expiresAt: new Date(NOW.getTime() + GITHUB_USER_SEAL_TTL_MS),
        },
        SECRET,
      ),
    ).toThrow(GithubUserTokenRejectedError);
  });
});
