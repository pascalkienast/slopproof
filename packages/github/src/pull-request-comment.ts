import { z } from "zod";
import type { RepositoryInstallationTokenProvider } from "./app-auth";
import {
  createOctokitGithubRestClient,
  type GithubRestClient,
  type GithubRestClientFactory,
} from "./octokit-client";
import { GithubControlError } from "./production-errors";
import {
  PullRequestCommentInputSchema,
  type GithubPullRequestCommentPort,
  type GithubPullRequestHeadPort,
  type PullRequestCommentInput,
} from "./production-ports";
import {
  executeGithubRequest,
  type GithubApiResponse,
  type GithubRequest,
  type GithubRequestPolicy,
} from "./request-policy";

const githubIdSchema = z.number().int().positive().safe();
const upstreamIssueCommentSchema = z
  .object({
    id: githubIdSchema,
    body: z.string().nullable(),
    performed_via_github_app: z
      .object({ id: githubIdSchema })
      .passthrough()
      .nullable(),
  })
  .passthrough();
const upstreamIssueCommentsSchema = z
  .array(upstreamIssueCommentSchema)
  .max(100);

const appIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .refine((value) => Number.isSafeInteger(Number(value)));
const MAX_SCANNED_COMMENTS = 1_000;
const COMMENT_MARKER = "<!-- slopproof:understanding-check -->";

export type OctokitPullRequestCommentAdapterOptions = {
  appId: string;
  clientFactory?: GithubRestClientFactory;
  requestPolicy?: GithubRequestPolicy;
};

/** Maintains one App-owned PR timeline comment and updates it per revision. */
export class OctokitPullRequestCommentAdapter implements GithubPullRequestCommentPort {
  private readonly appId: string;
  private readonly clientFactory: GithubRestClientFactory;
  private readonly requestPolicy: GithubRequestPolicy;

  constructor(
    private readonly tokenProvider: RepositoryInstallationTokenProvider,
    private readonly pullRequestHeadPort: GithubPullRequestHeadPort,
    options: OctokitPullRequestCommentAdapterOptions,
  ) {
    const appId = appIdSchema.safeParse(options.appId);
    if (!appId.success) throw new GithubControlError("INVALID_INPUT");
    this.appId = appId.data;
    this.clientFactory = options.clientFactory ?? createOctokitGithubRestClient;
    this.requestPolicy = options.requestPolicy ?? {};
  }

  async upsert(rawInput: PullRequestCommentInput): Promise<void> {
    const parsed = PullRequestCommentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
    const input = parsed.data;
    const body = buildPullRequestCommentBody(input);
    const client = await this.createClient(input);

    try {
      const existing = await this.findExisting(client, input);
      await this.assertCurrentHead(input);
      if (existing?.body === body) return;

      const response = existing
        ? await this.executeWrite((signal) =>
            client.updateIssueComment(
              {
                owner: input.owner,
                repositoryName: input.repositoryName,
                commentId: existing.id,
                body,
              },
              signal,
            ),
          )
        : await this.executeWrite((signal) =>
            client.createIssueComment(
              {
                owner: input.owner,
                repositoryName: input.repositoryName,
                pullNumber: input.pullNumber,
                body,
              },
              signal,
            ),
          );
      parseOwnedComment(response.data, this.appId, body, existing?.id);
    } catch (error) {
      this.invalidateRejectedToken(input, error);
      throw error;
    }
  }

  private async findExisting(
    client: GithubRestClient,
    input: PullRequestCommentInput,
  ): Promise<z.output<typeof upstreamIssueCommentSchema> | null> {
    let page = 1;
    let seen = 0;
    let match: z.output<typeof upstreamIssueCommentSchema> | undefined;

    while (seen < MAX_SCANNED_COMMENTS) {
      const response = await executeGithubRequest(
        (signal) =>
          client.listIssueComments(
            {
              owner: input.owner,
              repositoryName: input.repositoryName,
              pullNumber: input.pullNumber,
              page,
              perPage: 100,
            },
            signal,
          ),
        this.requestPolicy,
      );
      const parsed = upstreamIssueCommentsSchema.safeParse(response.data);
      if (!parsed.success) throw new GithubControlError("INVALID_RESPONSE");

      seen += parsed.data.length;
      for (const comment of parsed.data) {
        if (
          comment.performed_via_github_app?.id === Number(this.appId) &&
          comment.body?.includes(COMMENT_MARKER)
        ) {
          if (match !== undefined) {
            throw new GithubControlError("INVALID_RESPONSE");
          }
          match = comment;
        }
      }
      if (parsed.data.length < 100) return match ?? null;
      page += 1;
    }

    throw new GithubControlError("LIMIT_EXCEEDED");
  }

  private async assertCurrentHead(
    input: PullRequestCommentInput,
  ): Promise<void> {
    let current;
    try {
      current = await this.pullRequestHeadPort.getCurrentHead({
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        owner: input.owner,
        repositoryName: input.repositoryName,
        pullNumber: input.pullNumber,
      });
    } catch (error) {
      if (error instanceof GithubControlError) throw error;
      throw new GithubControlError("UNAVAILABLE");
    }
    if (
      current.headSha !== input.headSha ||
      current.baseSha !== input.baseSha ||
      current.state !== input.expectedPullRequestState
    ) {
      throw new GithubControlError("STALE_HEAD");
    }
  }

  private async createClient(
    input: PullRequestCommentInput,
  ): Promise<GithubRestClient> {
    try {
      const token = await this.tokenProvider.get(repositoryBinding(input));
      return this.clientFactory(token);
    } catch (error) {
      if (error instanceof GithubControlError) throw error;
      throw new GithubControlError("UNAVAILABLE");
    }
  }

  private async executeWrite<T>(
    request: GithubRequest<T>,
  ): Promise<GithubApiResponse<T>> {
    try {
      return await executeGithubRequest(request, {
        ...this.requestPolicy,
        maxAttempts: 1,
      });
    } catch (error) {
      if (
        error instanceof GithubControlError &&
        (error.code === "TIMEOUT" || error.code === "UNAVAILABLE")
      ) {
        throw new GithubControlError("AMBIGUOUS_WRITE", {
          ...(error.status !== undefined ? { status: error.status } : {}),
        });
      }
      if (error instanceof GithubControlError) throw error;
      throw new GithubControlError("AMBIGUOUS_WRITE");
    }
  }

  private invalidateRejectedToken(
    input: PullRequestCommentInput,
    error: unknown,
  ): void {
    if (
      error instanceof GithubControlError &&
      error.code === "REJECTED" &&
      error.status === 401
    ) {
      this.tokenProvider.invalidate(repositoryBinding(input));
    }
  }
}

export function buildPullRequestCommentBody(
  input: PullRequestCommentInput,
): string {
  return `${COMMENT_MARKER}
## UnderstandProof understanding check

This pull request requires proof of understanding for its current revision.

[Open the contributor flow](${input.detailsUrl})

After GitHub authorization, the contributor can choose optional practice or start the required live proof. Maintainers can open the protected review from the same UnderstandProof page.

Bound head: \`${input.headSha}\``;
}

function parseOwnedComment(
  value: unknown,
  appId: string,
  expectedBody: string,
  expectedCommentId: number | undefined,
): void {
  const parsed = upstreamIssueCommentSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.performed_via_github_app?.id !== Number(appId) ||
    parsed.data.body !== expectedBody ||
    (expectedCommentId !== undefined && parsed.data.id !== expectedCommentId)
  ) {
    throw new GithubControlError("INVALID_RESPONSE");
  }
}

function repositoryBinding(input: PullRequestCommentInput) {
  return {
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    owner: input.owner,
    repositoryName: input.repositoryName,
  };
}
