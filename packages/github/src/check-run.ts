import { z } from "zod";
import type { RepositoryInstallationTokenProvider } from "./app-auth";
import {
  createOctokitGithubRestClient,
  type GithubRestClient,
  type GithubRestClientFactory,
} from "./octokit-client";
import { GithubControlError } from "./production-errors";
import {
  CheckIntentInputSchema,
  CheckRunReferenceSchema,
  CheckUpdateInputSchema,
  StaleCheckUpdateInputSchema,
  GITHUB_CHECK_NAME,
  type CheckIntentInput,
  type CheckRunReference,
  type CheckUpdateInput,
  type StaleCheckUpdateInput,
  type GithubCheckRunPort,
  type GithubPullRequestHeadPort,
} from "./production-ports";
import {
  executeGithubRequest,
  type GithubApiResponse,
  type GithubRequest,
  type GithubRequestPolicy,
} from "./request-policy";

const remoteCheckStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const remoteCheckConclusionSchema = z
  .enum([
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "success",
    "skipped",
    "stale",
    "timed_out",
  ])
  .nullable();
const upstreamCheckRunSchema = z
  .object({
    id: z.number().int().positive().safe(),
    name: z.string(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/u),
    external_id: z.string().nullable(),
    status: remoteCheckStatusSchema,
    conclusion: remoteCheckConclusionSchema,
  })
  .passthrough();
const upstreamCheckRunListSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(upstreamCheckRunSchema).max(100),
  })
  .passthrough();

const MAX_EXISTING_CHECK_RUNS = 300;

export type OctokitCheckRunAdapterOptions = {
  clientFactory?: GithubRestClientFactory;
  requestPolicy?: GithubRequestPolicy;
};

/** Network-only check-run adapter. The caller persists returned check IDs. */
export class OctokitCheckRunAdapter implements GithubCheckRunPort {
  private readonly clientFactory: GithubRestClientFactory;
  private readonly requestPolicy: GithubRequestPolicy;

  constructor(
    private readonly tokenProvider: RepositoryInstallationTokenProvider,
    private readonly pullRequestHeadPort: GithubPullRequestHeadPort,
    options: OctokitCheckRunAdapterOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? createOctokitGithubRestClient;
    this.requestPolicy = options.requestPolicy ?? {};
  }

  async create(rawInput: CheckIntentInput): Promise<CheckRunReference> {
    const parsed = CheckIntentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
    const input = parsed.data;
    const client = await this.createClient(input);
    try {
      const existing = await this.findExistingWithClient(client, input);
      await this.assertCurrentHead(input);
      return await this.applyIntent(
        client,
        input,
        existing && canReuseRemoteCheck(existing, input)
          ? existing.checkRunId
          : undefined,
      );
    } catch (error) {
      this.invalidateRejectedToken(input, error);
      throw error;
    }
  }

  async update(rawInput: CheckUpdateInput): Promise<CheckRunReference> {
    const parsed = CheckUpdateInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
    const input = parsed.data;
    const client = await this.createClient(input);
    try {
      const persisted = await executeGithubRequest(
        (signal) =>
          client.getCheckRun(
            {
              owner: input.owner,
              repositoryName: input.repositoryName,
              checkRunId: Number(input.checkRunId),
            },
            signal,
          ),
        this.requestPolicy,
      );
      const remote = parseRemoteCheck(persisted.data, input, input.checkRunId);
      await this.assertCurrentHead(input);
      return await this.applyIntent(
        client,
        input,
        canReuseRemoteCheck(remote, input) ? input.checkRunId : undefined,
      );
    } catch (error) {
      this.invalidateRejectedToken(input, error);
      throw error;
    }
  }

  async invalidateStale(
    rawInput: StaleCheckUpdateInput,
  ): Promise<CheckRunReference> {
    const parsed = StaleCheckUpdateInputSchema.safeParse(rawInput);
    if (
      !parsed.success ||
      parsed.data.status !== "completed" ||
      parsed.data.conclusion !== "cancelled"
    ) {
      throw new GithubControlError("INVALID_INPUT");
    }
    const input = parsed.data;
    const client = await this.createClient(input);
    try {
      const persisted = await executeGithubRequest(
        (signal) =>
          client.getCheckRun(
            {
              owner: input.owner,
              repositoryName: input.repositoryName,
              checkRunId: Number(input.checkRunId),
            },
            signal,
          ),
        this.requestPolicy,
      );
      parseRemoteCheck(persisted.data, input, input.checkRunId);
      const current = await this.pullRequestHeadPort.getCurrentHead({
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        owner: input.owner,
        repositoryName: input.repositoryName,
        pullNumber: input.pullNumber,
      });
      if (
        current.headSha === input.headSha &&
        current.baseSha === input.baseSha
      ) {
        throw new GithubControlError("STALE_HEAD");
      }
      const response = await this.executeWrite((signal) =>
        client.updateCheckRun(
          checkUpdateRequest(input, input.checkRunId),
          signal,
        ),
      );
      const remote = parseRemoteCheck(response.data, input, input.checkRunId);
      if (!remoteMatchesIntent(remote, input)) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
      return { checkRunId: remote.checkRunId };
    } catch (error) {
      this.invalidateRejectedToken(input, error);
      throw error;
    }
  }

  async findExisting(
    rawInput: CheckIntentInput,
  ): Promise<CheckRunReference | null> {
    const parsed = CheckIntentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
    const input = parsed.data;
    const client = await this.createClient(input);
    try {
      const existing = await this.findExistingWithClient(client, input);
      return existing ? { checkRunId: existing.checkRunId } : null;
    } catch (error) {
      this.invalidateRejectedToken(input, error);
      throw error;
    }
  }

  /**
   * GitHub cannot reopen a completed check run. An in_progress update can also
   * land as completed+neutral. In either case a new run with the same name
   * supersedes the old one and keeps a required check pending.
   */
  private async applyIntent(
    client: GithubRestClient,
    input: CheckIntentInput,
    existingCheckRunId: string | undefined,
  ): Promise<CheckRunReference> {
    if (existingCheckRunId !== undefined) {
      const updated = await this.writeUpdate(client, input, existingCheckRunId);
      if (remoteMatchesIntent(updated, input)) {
        return { checkRunId: updated.checkRunId };
      }
      if (!shouldCreateSupersedingCheck(updated, input)) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
    }
    return this.writeCreate(client, input);
  }

  private async writeCreate(
    client: GithubRestClient,
    input: CheckIntentInput,
  ): Promise<CheckRunReference> {
    const response = await this.executeWrite((signal) =>
      client.createCheckRun(
        {
          owner: input.owner,
          repositoryName: input.repositoryName,
          name: GITHUB_CHECK_NAME,
          headSha: input.headSha,
          detailsUrl: input.detailsUrl,
          externalId: input.revisionId,
          status: input.status,
          conclusion: input.conclusion,
          summary: input.summary,
        },
        signal,
      ),
    );
    const remote = parseRemoteCheck(response.data, input);
    if (!remoteMatchesIntent(remote, input)) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    return { checkRunId: remote.checkRunId };
  }

  private async writeUpdate(
    client: GithubRestClient,
    input: CheckIntentInput,
    checkRunId: string,
  ): Promise<RemoteCheck> {
    const response = await this.executeWrite((signal) =>
      client.updateCheckRun(checkUpdateRequest(input, checkRunId), signal),
    );
    return parseRemoteCheck(response.data, input, checkRunId);
  }

  private async findExistingWithClient(
    client: GithubRestClient,
    input: CheckIntentInput,
  ): Promise<RemoteCheck | null> {
    let page = 1;
    let expectedTotal: number | undefined;
    let seen = 0;
    const matches: RemoteCheck[] = [];

    do {
      const response = await executeGithubRequest(
        (signal) =>
          client.listCheckRunsForRef(
            {
              owner: input.owner,
              repositoryName: input.repositoryName,
              headSha: input.headSha,
              checkName: GITHUB_CHECK_NAME,
              page,
              perPage: 100,
            },
            signal,
          ),
        this.requestPolicy,
      );
      const parsed = upstreamCheckRunListSchema.safeParse(response.data);
      if (
        !parsed.success ||
        parsed.data.total_count > MAX_EXISTING_CHECK_RUNS
      ) {
        throw new GithubControlError(
          parsed.success ? "LIMIT_EXCEEDED" : "INVALID_RESPONSE",
        );
      }
      if (
        expectedTotal !== undefined &&
        parsed.data.total_count !== expectedTotal
      ) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
      expectedTotal = parsed.data.total_count;
      if (parsed.data.check_runs.length === 0 && seen < expectedTotal) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
      seen += parsed.data.check_runs.length;
      if (seen > expectedTotal)
        throw new GithubControlError("INVALID_RESPONSE");

      for (const check of parsed.data.check_runs) {
        if (
          check.name === GITHUB_CHECK_NAME &&
          check.external_id === input.revisionId
        ) {
          if (check.head_sha !== input.headSha) {
            throw new GithubControlError("INVALID_RESPONSE");
          }
          const reference = CheckRunReferenceSchema.safeParse({
            checkRunId: String(check.id),
          });
          if (!reference.success) {
            throw new GithubControlError("INVALID_RESPONSE");
          }
          matches.push({
            checkRunId: reference.data.checkRunId,
            status: check.status,
            conclusion: check.conclusion,
          });
        }
      }
      page += 1;
    } while (seen < (expectedTotal ?? 0));

    return selectReusableRemote(matches, input);
  }

  private async assertCurrentHead(input: CheckIntentInput): Promise<void> {
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
    input: CheckIntentInput,
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
      // GitHub Check Run writes have no request idempotency key. Retrying a
      // timed-out/5xx create could create duplicates, so writes run once and
      // ambiguous outcomes must be reconciled by the caller.
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
    input: CheckIntentInput,
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

function repositoryBinding(input: CheckIntentInput) {
  return {
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    owner: input.owner,
    repositoryName: input.repositoryName,
  };
}

function checkUpdateRequest(input: CheckIntentInput, checkRunId: string) {
  return {
    owner: input.owner,
    repositoryName: input.repositoryName,
    checkRunId: Number(checkRunId),
    name: GITHUB_CHECK_NAME,
    detailsUrl: input.detailsUrl,
    externalId: input.revisionId,
    status: input.status,
    conclusion: input.conclusion,
    summary: input.summary,
  };
}

type RemoteCheck = {
  checkRunId: string;
  status: z.infer<typeof remoteCheckStatusSchema>;
  conclusion: z.infer<typeof remoteCheckConclusionSchema>;
};

function parseRemoteCheck(
  value: unknown,
  input: CheckIntentInput,
  expectedCheckRunId?: string,
): RemoteCheck {
  const parsed = upstreamCheckRunSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.name !== GITHUB_CHECK_NAME ||
    parsed.data.head_sha !== input.headSha ||
    parsed.data.external_id !== input.revisionId ||
    (expectedCheckRunId !== undefined &&
      String(parsed.data.id) !== expectedCheckRunId)
  ) {
    throw new GithubControlError("INVALID_RESPONSE");
  }
  const reference = CheckRunReferenceSchema.safeParse({
    checkRunId: String(parsed.data.id),
  });
  if (!reference.success) throw new GithubControlError("INVALID_RESPONSE");
  return {
    checkRunId: reference.data.checkRunId,
    status: parsed.data.status,
    conclusion: parsed.data.conclusion,
  };
}

function canReuseRemoteCheck(
  remote: RemoteCheck,
  intent: CheckIntentInput,
): boolean {
  return intent.status === "completed" || remote.status !== "completed";
}

function shouldCreateSupersedingCheck(
  remote: RemoteCheck,
  intent: CheckIntentInput,
): boolean {
  return intent.status !== "completed" && remote.status === "completed";
}

function remoteMatchesIntent(
  remote: RemoteCheck,
  intent: CheckIntentInput,
): boolean {
  if (intent.status !== "completed") {
    return remote.status !== "completed" && remote.conclusion === null;
  }
  return (
    remote.status === "completed" && remote.conclusion === intent.conclusion
  );
}

function selectReusableRemote(
  matches: RemoteCheck[],
  intent: CheckIntentInput,
): RemoteCheck | null {
  const open = matches.filter((match) => match.status !== "completed");
  const pool =
    intent.status === "completed" && open.length === 0 ? matches : open;
  if (pool.length === 0) return null;
  return pool.reduce((latest, current) =>
    Number(current.checkRunId) > Number(latest.checkRunId) ? current : latest,
  );
}
