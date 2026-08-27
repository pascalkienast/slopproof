import { z } from "zod";
import {
  createOctokitGithubRestClient,
  type GithubRestClient,
  type GithubRestClientFactory,
} from "./octokit-client";
import { GithubControlError } from "./production-errors";
import {
  GithubAccessibleAppInstallationIdSchema,
  GithubAccessibleAppInstallationsInputSchema,
  GithubAuthenticatedUserInputSchema,
  GithubAuthenticatedUserSchema,
  GithubCollaboratorPermissionInputSchema,
  GithubCollaboratorPermissionSchema,
  GithubWritableAppRepositoriesInputSchema,
  GithubWritableAppRepositoryIdSchema,
  type GithubAccessibleAppInstallationsInput,
  type GithubAuthenticatedUser,
  type GithubAuthenticatedUserInput,
  type GithubCollaboratorPermission,
  type GithubCollaboratorPermissionInput,
  type GithubUserAuthorizationPort,
  type GithubWritableAppRepositoriesInput,
} from "./production-ports";
import {
  executeGithubRequest,
  type GithubApiResponse,
  type GithubRequest,
  type GithubRequestPolicy,
} from "./request-policy";

const upstreamUserSchema = z
  .object({
    id: z.number().int().positive().safe(),
    login: z.string().min(1).max(100),
  })
  .passthrough();
const upstreamPermissionSchema = z
  .object({
    permission: z.enum(["admin", "write", "read", "none"]),
    role_name: z.string().min(1).max(100),
    user: z
      .object({ login: z.string().min(1).max(100) })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const USER_APP_INSTALLATIONS_PAGE_SIZE = 100;
const MAX_USER_APP_INSTALLATION_PAGES = 10;
const USER_APP_REPOSITORIES_PAGE_SIZE = 100;
const MAX_USER_APP_REPOSITORY_PAGES = 32;
const MAX_USER_APP_REPOSITORY_RESULTS =
  USER_APP_REPOSITORIES_PAGE_SIZE * MAX_USER_APP_REPOSITORY_PAGES;
const DEFAULT_USER_AUTHORIZATION_DEADLINE_MS = 25_000;

const upstreamInstallationPageSchema = z
  .object({
    total_count: z.number().int().nonnegative().safe(),
    installations: z
      .array(
        z
          .object({
            id: z.number().int().positive().safe(),
          })
          .passthrough(),
      )
      .max(USER_APP_INSTALLATIONS_PAGE_SIZE),
  })
  .passthrough();

const upstreamRepositoryPageSchema = z
  .object({
    total_count: z.number().int().nonnegative().safe(),
    repositories: z
      .array(
        z
          .object({
            id: z.number().int().positive().safe(),
            permissions: z
              .object({
                admin: z.boolean(),
                push: z.boolean(),
                maintain: z.boolean().optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(USER_APP_REPOSITORIES_PAGE_SIZE),
  })
  .passthrough();

function parseAccessibleAppInstallationPage(data: unknown): {
  ids: string[];
  pageSize: number;
  totalCount: number;
} | null {
  const page = upstreamInstallationPageSchema.safeParse(data);
  if (!page.success) return null;
  const ids: string[] = [];
  for (const installation of page.data.installations) {
    const parsed = GithubAccessibleAppInstallationIdSchema.safeParse(
      String(installation.id),
    );
    if (!parsed.success) return null;
    ids.push(parsed.data);
  }
  return {
    ids,
    pageSize: page.data.installations.length,
    totalCount: page.data.total_count,
  };
}

function parseWritableAppRepositoryPage(data: unknown): {
  ids: string[];
  pageSize: number;
  totalCount: number;
} | null {
  const page = upstreamRepositoryPageSchema.safeParse(data);
  if (!page.success) return null;
  const ids: string[] = [];
  for (const repository of page.data.repositories) {
    if (
      !repository.permissions.admin &&
      !repository.permissions.push &&
      repository.permissions.maintain !== true
    ) {
      continue;
    }
    const parsed = GithubWritableAppRepositoryIdSchema.safeParse(
      String(repository.id),
    );
    if (!parsed.success) return null;
    ids.push(parsed.data);
  }
  return {
    ids,
    pageSize: page.data.repositories.length,
    totalCount: page.data.total_count,
  };
}

function createBoundGithubRequest(policy: GithubRequestPolicy) {
  const now = policy.now ?? Date.now;
  const deadlineAt =
    now() + (policy.deadlineMs ?? DEFAULT_USER_AUTHORIZATION_DEADLINE_MS);
  return async <T>(
    request: GithubRequest<T>,
  ): Promise<GithubApiResponse<T>> => {
    const remaining = Math.floor(deadlineAt - now());
    if (remaining < 1) throw new GithubControlError("TIMEOUT");
    return executeGithubRequest(request, {
      ...policy,
      deadlineMs: remaining,
    });
  };
}

export type OctokitUserAuthorizationPortOptions = {
  clientFactory?: GithubRestClientFactory;
  requestPolicy?: GithubRequestPolicy;
};

/** User tokens remain method-local and are never cached by this adapter. */
export class OctokitUserAuthorizationPort implements GithubUserAuthorizationPort {
  private readonly clientFactory: GithubRestClientFactory;
  private readonly requestPolicy: GithubRequestPolicy;

  constructor(options: OctokitUserAuthorizationPortOptions = {}) {
    this.clientFactory = options.clientFactory ?? createOctokitGithubRestClient;
    this.requestPolicy = options.requestPolicy ?? {};
  }

  async getAuthenticatedUser(
    rawInput: GithubAuthenticatedUserInput,
  ): Promise<GithubAuthenticatedUser> {
    const input = GithubAuthenticatedUserInputSchema.safeParse(rawInput);
    if (!input.success) throw new GithubControlError("INVALID_INPUT");
    const client = this.createClient(input.data.userToken);
    const response = await executeGithubRequest(
      (signal) => client.getAuthenticatedUser(signal),
      this.requestPolicy,
    );
    const upstream = upstreamUserSchema.safeParse(response.data);
    if (!upstream.success) throw new GithubControlError("INVALID_RESPONSE");
    const result = GithubAuthenticatedUserSchema.safeParse({
      id: String(upstream.data.id),
      login: upstream.data.login,
    });
    if (!result.success) throw new GithubControlError("INVALID_RESPONSE");
    return result.data;
  }

  async getCollaboratorPermission(
    rawInput: GithubCollaboratorPermissionInput,
  ): Promise<GithubCollaboratorPermission> {
    const input = GithubCollaboratorPermissionInputSchema.safeParse(rawInput);
    if (!input.success) throw new GithubControlError("INVALID_INPUT");
    const client = this.createClient(input.data.userToken);
    const response = await executeGithubRequest(
      (signal) =>
        client.getCollaboratorPermissionLevel(
          {
            owner: input.data.owner,
            repositoryName: input.data.repositoryName,
            username: input.data.username,
          },
          signal,
        ),
      this.requestPolicy,
    );
    const upstream = upstreamPermissionSchema.safeParse(response.data);
    if (
      !upstream.success ||
      upstream.data.user === null ||
      upstream.data.user.login.toLowerCase() !==
        input.data.username.toLowerCase()
    ) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    const result = GithubCollaboratorPermissionSchema.safeParse({
      permission: upstream.data.permission,
      roleName: upstream.data.role_name,
    });
    if (!result.success) throw new GithubControlError("INVALID_RESPONSE");
    return result.data;
  }

  async listAccessibleAppInstallations(
    rawInput: GithubAccessibleAppInstallationsInput,
  ): Promise<readonly string[]> {
    const input =
      GithubAccessibleAppInstallationsInputSchema.safeParse(rawInput);
    if (!input.success) throw new GithubControlError("INVALID_INPUT");
    const client = this.createClient(input.data.userToken);
    const request = createBoundGithubRequest(this.requestPolicy);
    const installationIds: string[] = [];
    let announcedTotal: number | undefined;
    let receivedInstallations = 0;
    for (let page = 1; page <= MAX_USER_APP_INSTALLATION_PAGES; page += 1) {
      const response = await request((signal) =>
        client.listInstallationsForAuthenticatedUser(
          {
            page,
            perPage: USER_APP_INSTALLATIONS_PAGE_SIZE,
          },
          signal,
        ),
      );
      const parsed = parseAccessibleAppInstallationPage(response.data);
      if (!parsed) throw new GithubControlError("INVALID_RESPONSE");
      if (announcedTotal === undefined) {
        announcedTotal = parsed.totalCount;
      } else if (parsed.totalCount !== announcedTotal) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
      receivedInstallations += parsed.pageSize;
      installationIds.push(...parsed.ids);
      if (
        announcedTotal >
          USER_APP_INSTALLATIONS_PAGE_SIZE * MAX_USER_APP_INSTALLATION_PAGES ||
        receivedInstallations > announcedTotal ||
        (parsed.pageSize === 0 && receivedInstallations < announcedTotal)
      ) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
      if (receivedInstallations === announcedTotal) {
        return Object.freeze([...new Set(installationIds)]);
      }
    }
    throw new GithubControlError("INVALID_RESPONSE");
  }

  async listWritableAppRepositories(
    rawInput: GithubWritableAppRepositoriesInput,
  ): Promise<readonly string[]> {
    const input = GithubWritableAppRepositoriesInputSchema.safeParse(rawInput);
    if (!input.success) throw new GithubControlError("INVALID_INPUT");
    const client = this.createClient(input.data.userToken);
    const request = createBoundGithubRequest(this.requestPolicy);
    const repositoryIds = new Set<string>();
    let pagesRead = 0;
    let announcedRepositories = 0;

    for (const installationId of input.data.githubInstallationIds) {
      let receivedForInstallation = 0;
      let totalForInstallation: number | undefined;
      for (let page = 1; ; page += 1) {
        if (pagesRead >= MAX_USER_APP_REPOSITORY_PAGES) {
          throw new GithubControlError("INVALID_RESPONSE");
        }
        pagesRead += 1;
        const response = await request((signal) =>
          client.listInstallationReposForAuthenticatedUser(
            {
              installationId: Number(installationId),
              page,
              perPage: USER_APP_REPOSITORIES_PAGE_SIZE,
            },
            signal,
          ),
        );
        const parsed = parseWritableAppRepositoryPage(response.data);
        if (!parsed) throw new GithubControlError("INVALID_RESPONSE");
        if (totalForInstallation === undefined) {
          totalForInstallation = parsed.totalCount;
          announcedRepositories += parsed.totalCount;
          if (announcedRepositories > MAX_USER_APP_REPOSITORY_RESULTS) {
            throw new GithubControlError("INVALID_RESPONSE");
          }
        } else if (parsed.totalCount !== totalForInstallation) {
          throw new GithubControlError("INVALID_RESPONSE");
        }
        receivedForInstallation += parsed.pageSize;
        if (
          receivedForInstallation > parsed.totalCount ||
          (parsed.pageSize === 0 && receivedForInstallation < parsed.totalCount)
        ) {
          throw new GithubControlError("INVALID_RESPONSE");
        }
        for (const repositoryId of parsed.ids) {
          repositoryIds.add(repositoryId);
        }
        if (receivedForInstallation >= parsed.totalCount) break;
      }
    }
    return Object.freeze([...repositoryIds]);
  }

  private createClient(userToken: string): GithubRestClient {
    try {
      return this.clientFactory(userToken);
    } catch {
      throw new GithubControlError("UNAVAILABLE");
    }
  }
}
