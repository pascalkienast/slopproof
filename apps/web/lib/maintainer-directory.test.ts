import { GithubControlError } from "@understandproof/github";
import { describe, expect, it, vi } from "vitest";
import {
  filterMaintainerDirectory,
  loadSealedMaintainerDirectory,
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
    listWritableAppRepositories: vi.fn(async () => []),
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
      if (sql.includes("SELECT github_installation_id")) {
        expect(parameters).toEqual([["17"]]);
        return {
          rows: [{ github_installation_id: "17" }],
          rowCount: 1,
        };
      }
      expect(sql).toContain(
        "installation.github_installation_id = ANY($1::text[])",
      );
      expect(sql).toContain(
        "repository.github_repository_id = ANY($2::text[])",
      );
      expect(sql).toContain("LIMIT $3");
      expect(parameters).toEqual([["17"], ["42"], 32]);
      return { rows: [FIRST], rowCount: 1 };
    });
    const listAccessibleAppInstallations = vi.fn(async () => ["17"]);
    const listWritableAppRepositories = vi.fn(async () => ["42"]);
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
          listWritableAppRepositories,
        },
      },
    );
    expect(identified).not.toBeNull();
    expect(listAccessibleAppInstallations).toHaveBeenCalledWith({
      userToken: "request-scoped-user-token",
    });
    expect(listWritableAppRepositories).toHaveBeenCalledWith({
      userToken: "request-scoped-user-token",
      githubInstallationIds: ["17"],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("filters by GitHub repository id before the directory limit so a late-sorted maintained repo remains", async () => {
    const kept = {
      id: "20000000-0000-4000-8000-000000000039",
      owner: "acme",
      name: "zzz-kept",
    };
    const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("SELECT github_installation_id")) {
        return {
          rows: [{ github_installation_id: "17" }],
          rowCount: 1,
        };
      }
      if (sql.includes("repository.github_repository_id = ANY($2::text[])")) {
        expect(sql).toContain("LIMIT $3");
        expect(parameters).toEqual([["17"], ["92040"], 32]);
        return { rows: [kept], rowCount: 1 };
      }
      if (sql.includes("repository.id = ANY($1::uuid[])")) {
        return { rows: [kept], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
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
          ...port(async () => {
            throw new Error("Identify must not call permission per repository");
          }),
          listAccessibleAppInstallations: vi.fn(async () => ["17"]),
          listWritableAppRepositories: vi.fn(async () => ["92040"]),
        },
      },
    );
    expect(identified).not.toBeNull();
    await expect(
      loadSealedMaintainerDirectory(
        {
          config: {
            SESSION_SECRET:
              "production-session-secret-that-is-at-least-32-bytes",
          },
          database: { pool: { query } },
        } as unknown as WebRuntime,
        identified!.sealedCookie,
        new Date("2026-08-27T12:00:00.000Z"),
      ),
    ).resolves.toEqual([kept]);
  });
});
