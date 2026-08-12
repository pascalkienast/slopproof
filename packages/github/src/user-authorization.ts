import { z } from "zod";
import {
  createOctokitGithubRestClient,
  type GithubRestClient,
  type GithubRestClientFactory,
} from "./octokit-client";
import { GithubControlError } from "./production-errors";
import {
  GithubAuthenticatedUserInputSchema,
  GithubAuthenticatedUserSchema,
  GithubCollaboratorPermissionInputSchema,
  GithubCollaboratorPermissionSchema,
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

  private createClient(userToken: string): GithubRestClient {
    try {
      return this.clientFactory(userToken);
    } catch {
      throw new GithubControlError("UNAVAILABLE");
    }
  }
}
