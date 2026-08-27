import { describe, expect, it, vi } from "vitest";
import { OctokitUserAuthorizationPort } from "./user-authorization";
import { githubRestClientStub } from "./production-testkit";

const token = "request-scoped-user-token";

describe("OctokitUserAuthorizationPort", () => {
  it("resolves the authenticated GitHub identity with a request-scoped token", async () => {
    const authorizations: string[] = [];
    const getAuthenticatedUser = vi.fn(async () => ({
      data: { id: 99, login: "octocat", email: "ignored@example.test" },
    }));
    const port = new OctokitUserAuthorizationPort({
      clientFactory: (authorization) => {
        authorizations.push(authorization);
        return githubRestClientStub({ getAuthenticatedUser });
      },
    });

    await expect(
      port.getAuthenticatedUser({ userToken: token }),
    ).resolves.toEqual({
      id: "99",
      login: "octocat",
    });
    expect(authorizations).toEqual([token]);
    expect(getAuthenticatedUser).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("freshly resolves the collaborator permission and custom role name", async () => {
    const getCollaboratorPermissionLevel = vi.fn(async () => ({
      data: {
        permission: "write",
        role_name: "release-manager",
        user: { login: "OctoCat", id: 99 },
      },
    }));
    const port = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({ getCollaboratorPermissionLevel }),
    });

    await expect(
      port.getCollaboratorPermission({
        userToken: token,
        owner: "acme",
        repositoryName: "cachekit",
        username: "octocat",
      }),
    ).resolves.toEqual({ permission: "write", roleName: "release-manager" });
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledWith(
      {
        owner: "acme",
        repositoryName: "cachekit",
        username: "octocat",
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects malformed identities, unknown permissions, and user mismatches", async () => {
    const malformedUser = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({
          getAuthenticatedUser: async () => ({
            data: { id: Number.MAX_SAFE_INTEGER + 1, login: "octocat" },
          }),
        }),
    });
    await expect(
      malformedUser.getAuthenticatedUser({ userToken: token }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const wrongCollaborator = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({
          getCollaboratorPermissionLevel: async () => ({
            data: {
              permission: "owner",
              role_name: "owner",
              user: { login: "someone-else" },
            },
          }),
        }),
    });
    await expect(
      wrongCollaborator.getCollaboratorPermission({
        userToken: token,
        owner: "acme",
        repositoryName: "cachekit",
        username: "octocat",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("pages this user's App installations and keeps a full last page without throwing", async () => {
    const listInstallationsForAuthenticatedUser = vi.fn(
      async (input: { page: number }) => ({
        data: {
          total_count: 1_000,
          installations:
            input.page <= 10
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: input.page * 1_000 + index + 1,
                }))
              : [],
        },
      }),
    );
    const port = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({ listInstallationsForAuthenticatedUser }),
    });

    await expect(
      port.listAccessibleAppInstallations({ userToken: token }),
    ).resolves.toHaveLength(1_000);
    expect(listInstallationsForAuthenticatedUser).toHaveBeenCalledTimes(10);
  });

  it("fails closed when the App installation result exceeds its bounded pagination", async () => {
    const port = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({
          listInstallationsForAuthenticatedUser: async () => ({
            data: { total_count: 1_001, installations: [] },
          }),
        }),
    });

    await expect(
      port.listAccessibleAppInstallations({ userToken: token }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("pages writable repositories through the request-scoped App-user endpoint", async () => {
    const listInstallationReposForAuthenticatedUser = vi.fn(
      async (input: { installationId: number; page: number }) => ({
        data:
          input.page === 1
            ? {
                total_count: 4,
                repositories: [
                  {
                    id: 201,
                    permissions: { admin: true, push: false },
                  },
                  {
                    id: 202,
                    permissions: { admin: false, push: true },
                  },
                  {
                    id: 203,
                    permissions: {
                      admin: false,
                      push: false,
                      maintain: true,
                    },
                  },
                  {
                    id: 204,
                    permissions: { admin: false, push: false },
                  },
                ],
              }
            : { total_count: 4, repositories: [] },
      }),
    );
    const port = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({
          listInstallationReposForAuthenticatedUser,
        }),
    });

    await expect(
      port.listWritableAppRepositories({
        userToken: token,
        githubInstallationIds: ["17"],
      }),
    ).resolves.toEqual(["201", "202", "203"]);
    expect(listInstallationReposForAuthenticatedUser).toHaveBeenCalledWith(
      { installationId: 17, page: 1, perPage: 100 },
      expect.any(AbortSignal),
    );
    expect(listInstallationReposForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete or unstable writable-repository pagination", async () => {
    const listInstallationReposForAuthenticatedUser = vi.fn(
      async (input: { page: number }) => ({
        data:
          input.page === 1
            ? {
                total_count: 2,
                repositories: [
                  {
                    id: 201,
                    permissions: { admin: true, push: false },
                  },
                ],
              }
            : { total_count: 3, repositories: [] },
      }),
    );
    const port = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({
          listInstallationReposForAuthenticatedUser,
        }),
    });

    await expect(
      port.listWritableAppRepositories({
        userToken: token,
        githubInstallationIds: ["17"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("strictly rejects extra request fields and never exposes a token in errors", async () => {
    const port = new OctokitUserAuthorizationPort({
      clientFactory: () =>
        githubRestClientStub({
          getAuthenticatedUser: async () => {
            throw new Error(`upstream included ${token}`);
          },
        }),
      requestPolicy: { maxAttempts: 1 },
    });
    const error = await port
      .getAuthenticatedUser({ userToken: token })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UNAVAILABLE" });
    expect(String(error)).not.toContain(token);

    await expect(
      port.getAuthenticatedUser({
        userToken: token,
        persistToken: true,
      } as { userToken: string }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
