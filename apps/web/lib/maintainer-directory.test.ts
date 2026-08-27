import { GithubControlError } from "@slopproof/github";
import { describe, expect, it, vi } from "vitest";
import {
  filterMaintainerDirectory,
  resolveProductionIdentifyDirectory,
} from "./maintainer-directory";
import type { WebRuntime } from "./runtime";

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
  lookup: (repositoryName: string) => Promise<{
    permission: "admin" | "write" | "read" | "none";
    roleName: string;
  }>,
) {
  return {
    getAuthenticatedUser: vi.fn(),
    getCollaboratorPermission: vi.fn(
      async (input: { repositoryName: string }) => lookup(input.repositoryName),
    ),
    listAccessibleAppInstallations: vi.fn(async () => []),
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

  it("resolves Identify from the user's App installations instead of every tenant", async () => {
    const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      expect(sql).toContain(
        "installation.github_installation_id = ANY($1::text[])",
      );
      expect(parameters[0]).toEqual(["17"]);
      expect(parameters[1]).toBe(32);
      return { rows: [FIRST], rowCount: 1 };
    });
    const listAccessibleAppInstallations = vi.fn(async () => ["17"]);
    const identified = await resolveProductionIdentifyDirectory(
      {
        config: {
          DEPLOYMENT_PROFILE: "production",
          GITHUB_ADAPTER: "octokit",
          DEMO_MODE: false,
          SESSION_SECRET: "production-session-secret-that-is-at-least-32-bytes",
        },
        database: { pool: { query } },
      } as unknown as WebRuntime,
      {
        user: { githubUserId: "12345678", login: "octocat" },
        accessToken: "request-scoped-user-token",
        now: new Date("2026-08-27T12:00:00.000Z"),
      },
      {
        authorizationPort: {
          ...port(async () => ({ permission: "admin", roleName: "admin" })),
          listAccessibleAppInstallations,
        },
      },
    );
    expect(identified).not.toBeNull();
    expect(listAccessibleAppInstallations).toHaveBeenCalledWith({
      userToken: "request-scoped-user-token",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
