import { GithubControlError } from "@slopproof/github";
import { describe, expect, it, vi } from "vitest";
import {
  filterMaintainerDirectory,
  sealMaintainerDirectory,
  unsealMaintainerDirectory,
} from "./maintainer-directory";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const SECRET = "directory-session-secret-that-is-at-least-32-bytes";
const FIRST = {
  id: "10000000-0000-4000-8000-000000000002",
  owner: "pascalkienast",
  name: "pixelcampus",
};
const SECOND = {
  id: "40000000-0000-4000-8000-000000000005",
  owner: "acme",
  name: "private-cache",
};

function port(
  lookup: (
    repositoryName: string,
  ) => Promise<{
    permission: "admin" | "write" | "read" | "none";
    roleName: string;
  }>,
) {
  return {
    getAuthenticatedUser: vi.fn(),
    getCollaboratorPermission: vi.fn(async (input) =>
      lookup(input.repositoryName),
    ),
  };
}

describe("maintainer directory filter", () => {
  it("keeps only live maintainer+installed repositories", async () => {
    const allowed = await filterMaintainerDirectory({
      user: { githubUserId: "12345678", login: "octocat" },
      accessToken: "request-scoped-user-token",
      repositories: [FIRST, SECOND],
      authorizationPort: port(async (name) =>
        name === FIRST.name
          ? { permission: "write", roleName: "maintain" }
          : { permission: "read", roleName: "triage" },
      ),
    });
    expect(allowed).toEqual([FIRST]);
    expect(JSON.stringify(allowed)).not.toContain("request-scoped-user-token");
  });

  it("treats 403/404 collaborator rejection as absence, not a partial directory", async () => {
    await expect(
      filterMaintainerDirectory({
        user: { githubUserId: "12345678", login: "octocat" },
        accessToken: "request-scoped-user-token",
        repositories: [FIRST, SECOND],
        authorizationPort: port(async (name) => {
          if (name === FIRST.name) {
            throw new GithubControlError("REJECTED", { status: 404 });
          }
          return { permission: "admin", roleName: "admin" };
        }),
      }),
    ).resolves.toEqual([SECOND]);
  });

  it("fails closed when any permission check is inconclusive", async () => {
    await expect(
      filterMaintainerDirectory({
        user: { githubUserId: "12345678", login: "octocat" },
        accessToken: "request-scoped-user-token",
        repositories: [FIRST, SECOND],
        authorizationPort: port(async (name) => {
          if (name === FIRST.name) {
            return { permission: "admin", roleName: "admin" };
          }
          throw new GithubControlError("UNAVAILABLE", { status: 503 });
        }),
      }),
    ).rejects.toMatchObject({
      message: "Maintainer directory is unavailable.",
    });
  });

  it("fails closed on 401 instead of treating it as a missing collaborator", async () => {
    await expect(
      filterMaintainerDirectory({
        user: { githubUserId: "12345678", login: "octocat" },
        accessToken: "request-scoped-user-token",
        repositories: [FIRST],
        authorizationPort: port(async () => {
          throw new GithubControlError("REJECTED", { status: 401 });
        }),
      }),
    ).rejects.toMatchObject({
      message: "Maintainer directory is unavailable.",
    });
  });

  it("round-trips repository ids without owner/name or token material", () => {
    const sealed = sealMaintainerDirectory(
      {
        githubUserId: "12345678",
        repositoryIds: [FIRST.id, SECOND.id],
        now: NOW,
      },
      SECRET,
      { entropy: (bytes) => Buffer.alloc(bytes, 9) },
    );
    expect(sealed.sealedCookie).not.toContain(FIRST.owner);
    expect(sealed.sealedCookie).not.toContain(FIRST.name);
    expect(sealed.sealedCookie).not.toContain("request-scoped-user-token");
    expect(unsealMaintainerDirectory(sealed.sealedCookie, SECRET, NOW)).toEqual(
      [FIRST.id, SECOND.id],
    );
  });
});
