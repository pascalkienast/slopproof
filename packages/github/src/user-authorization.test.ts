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
