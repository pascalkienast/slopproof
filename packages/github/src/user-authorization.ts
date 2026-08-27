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
  type GithubAccessibleAppInstallationsInput,
  type GithubAuthenticatedUser,
  type GithubAuthenticatedUserInput,
  type GithubCollaboratorPermission,
  type GithubCollaboratorPermissionInput,
  type GithubUserAuthorizationPort,
} from "./production-ports";
import {
  executeGithubRequest,
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

const upstreamInstallationPageSchema = z
  .object({
    installations: z.array(
      z
        .object({
          id: z.number().int().positive().safe(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function parseAccessibleAppInstallationPage(data: unknown): {
  ids: string[];
  hasMore: boolean;
} | null {
  const page = upstreamInstallationPageSchema.safeParse(data);
  if (!page.success) return null;
  const ids: string[] = [];
  for (const installation of page.data.installations) {
    const parsed = GithubAccessibleAppInstallationIdSchema.safeParse(
      String(installation.id),
    );
    if (parsed.success) ids.push(parsed.data);
  }
  return {
    ids,
    hasMore:
      page.data.installations.length >= USER_APP_INSTALLATIONS_PAGE_SIZE,
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
    const input = GithubAccessibleAppInstallationsInputSchema.safeParse(rawInput);
    if (!input.success) throw new GithubControlError("INVALID_INPUT");
    const client = this.createClient(input.data.userToken);
    const installationIds: string[] = [];
    for (let page = 1; page <= MAX_USER_APP_INSTALLATION_PAGES; page += 1) {
      const response = await executeGithubRequest(
        (signal) =>
          client.listInstallationsForAuthenticatedUser(
            {
              page,
              perPage: USER_APP_INSTALLATIONS_PAGE_SIZE,
            },
            signal,
          ),
        this.requestPolicy,
      );
      const parsed = parseAccessibleAppInstallationPage(response.data);
      if (!parsed) throw new GithubControlError("INVALID_RESPONSE");
      installationIds.push(...parsed.ids);
      if (!parsed.hasMore) break;
    }
    return Object.freeze(installationIds);
  }

  private createClient(userToken: string): GithubRestClient {
    try {
      return this.clientFactory(userToken);
    } catch {
      throw new GithubControlError("UNAVAILABLE");
    }
  }
}
