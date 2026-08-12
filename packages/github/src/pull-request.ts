import { z } from "zod";
import type { RepositoryInstallationTokenProvider } from "./app-auth";
import {
  createOctokitGithubRestClient,
  type GithubRestClient,
  type GithubRestClientFactory,
} from "./octokit-client";
import { GithubControlError } from "./production-errors";
import {
  GithubCurrentHeadInputSchema,
  GithubCurrentHeadSchema,
  GithubPullRequestReadInputSchema,
  GithubPullRequestSnapshotSchema,
  type GithubCurrentHead,
  type GithubCurrentHeadInput,
  type GithubPullRequestHeadPort,
  type GithubPullRequestPort,
  type GithubPullRequestReadInput,
  type GithubPullRequestSnapshot,
  type GithubRepositoryBinding,
} from "./production-ports";
import {
  executeGithubRequest,
  type GithubRequestPolicy,
} from "./request-policy";

const githubIdSchema = z.number().int().positive().safe();
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const upstreamRepositorySchema = z
  .object({
    id: githubIdSchema,
    full_name: z.string().min(3).max(201),
  })
  .passthrough();
const upstreamPullRequestSchema = z
  .object({
    id: githubIdSchema,
    number: z.number().int().positive().max(2_147_483_647),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().nullable().optional(),
    title: z.string().max(4_096),
    body: z.string().max(65_536).nullable(),
    changed_files: z.number().int().nonnegative().max(10_000_000),
    user: z
      .object({ id: githubIdSchema, login: z.string().min(1).max(100) })
      .passthrough(),
    head: z
      .object({
        sha: shaSchema,
        repo: upstreamRepositorySchema.nullable(),
      })
      .passthrough(),
    base: z
      .object({ sha: shaSchema, repo: upstreamRepositorySchema })
      .passthrough(),
  })
  .passthrough();

const MAX_ACCEPTED_PATCH_CHARACTERS = 1024 * 1024;
const upstreamChangedFileSchema = z
  .object({
    sha: shaSchema.nullable(),
    filename: z.string().min(1).max(1_024),
    previous_filename: z.string().min(1).max(1_024).optional(),
    status: z.enum([
      "added",
      "removed",
      "modified",
      "renamed",
      "copied",
      "changed",
      "unchanged",
    ]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    patch: z.string().max(MAX_ACCEPTED_PATCH_CHARACTERS).optional(),
  })
  .passthrough();
const upstreamChangedFilesSchema = z.array(upstreamChangedFileSchema).max(100);

export const DEFAULT_GITHUB_PULL_REQUEST_LIMITS = Object.freeze({
  maxFiles: 300,
  maxPatchBytesPerFile: 128 * 1_024,
  maxTotalPatchBytes: 2 * 1_024 * 1_024,
});

export type GithubPullRequestLimits = {
  maxFiles?: number;
  maxPatchBytesPerFile?: number;
  maxTotalPatchBytes?: number;
};

export type OctokitPullRequestPortOptions = {
  clientFactory?: GithubRestClientFactory;
  requestPolicy?: GithubRequestPolicy;
  limits?: GithubPullRequestLimits;
};

type ResolvedLimits = Required<GithubPullRequestLimits>;
type ParsedPullRequest = z.infer<typeof upstreamPullRequestSchema>;

/** Read-only GitHub PR source. It never clones or executes repository data. */
export class OctokitPullRequestPort
  implements GithubPullRequestPort, GithubPullRequestHeadPort
{
  private readonly clientFactory: GithubRestClientFactory;
  private readonly requestPolicy: GithubRequestPolicy;
  private readonly limits: ResolvedLimits;

  constructor(
    private readonly tokenProvider: RepositoryInstallationTokenProvider,
    options: OctokitPullRequestPortOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? createOctokitGithubRestClient;
    this.requestPolicy = options.requestPolicy ?? {};
    this.limits = resolveLimits(options.limits);
  }

  async load(
    rawInput: GithubPullRequestReadInput,
  ): Promise<GithubPullRequestSnapshot> {
    return this.loadWithAuthorization(rawInput, false);
  }

  async loadFresh(
    rawInput: GithubPullRequestReadInput,
  ): Promise<GithubPullRequestSnapshot> {
    return this.loadWithAuthorization(rawInput, true);
  }

  private async loadWithAuthorization(
    rawInput: GithubPullRequestReadInput,
    forceFreshAuthorization: boolean,
  ): Promise<GithubPullRequestSnapshot> {
    const input = parseInput(GithubPullRequestReadInputSchema, rawInput);
    return this.withRepositoryClient(
      input,
      async (client) => {
        const initial = await this.readPullRequest(client, input);
        assertRepositoryBinding(input, initial);
        // The webhook head is an immutable security binding. GitHub can move the
        // target branch without emitting a pull_request synchronize event,
        // though, so the freshly read base is authoritative for this snapshot.
        // The second PR read below still proves that the base stayed stable while
        // the file pages were fetched.
        if (initial.head.sha !== input.expectedHeadSha) {
          throw new GithubControlError("STALE_HEAD");
        }

        const mapped = await this.readFiles(
          client,
          input,
          initial.changed_files,
        );
        const final = await this.readPullRequest(client, input);
        assertRepositoryBinding(input, final);
        if (
          final.head.sha !== input.expectedHeadSha ||
          !sameSnapshotMetadata(initial, final)
        ) {
          throw new GithubControlError("STALE_HEAD");
        }

        const snapshot = {
          githubPullRequestId: String(initial.id),
          number: initial.number,
          state: initial.state,
          draft: initial.draft ?? false,
          title: initial.title,
          body: initial.body,
          authorId: String(initial.user.id),
          authorLogin: initial.user.login,
          headSha: initial.head.sha,
          baseSha: initial.base.sha,
          changedFiles: initial.changed_files,
          isFork:
            initial.head.repo === null ||
            initial.head.repo.id !== initial.base.repo.id,
          files: mapped.files,
          limitsHit: mapped.limitsHit,
        };
        const parsed = GithubPullRequestSnapshotSchema.safeParse(snapshot);
        if (!parsed.success) throw new GithubControlError("INVALID_RESPONSE");
        return parsed.data;
      },
      forceFreshAuthorization,
    );
  }

  async getCurrentHead(
    rawInput: GithubCurrentHeadInput,
  ): Promise<GithubCurrentHead> {
    return this.getCurrentHeadWithAuthorization(rawInput, false);
  }

  async getCurrentHeadFresh(
    rawInput: GithubCurrentHeadInput,
  ): Promise<GithubCurrentHead> {
    return this.getCurrentHeadWithAuthorization(rawInput, true);
  }

  private async getCurrentHeadWithAuthorization(
    rawInput: GithubCurrentHeadInput,
    forceFreshAuthorization: boolean,
  ): Promise<GithubCurrentHead> {
    const input = parseInput(GithubCurrentHeadInputSchema, rawInput);
    return this.withRepositoryClient(
      input,
      async (client) => {
        const pullRequest = await this.readPullRequest(client, input);
        assertRepositoryBinding(input, pullRequest);
        const parsed = GithubCurrentHeadSchema.safeParse({
          headSha: pullRequest.head.sha,
          baseSha: pullRequest.base.sha,
          state: pullRequest.state,
        });
        if (!parsed.success) throw new GithubControlError("INVALID_RESPONSE");
        return parsed.data;
      },
      forceFreshAuthorization,
    );
  }

  private async readPullRequest(
    client: GithubRestClient,
    input: GithubCurrentHeadInput,
  ): Promise<ParsedPullRequest> {
    const response = await executeGithubRequest(
      (signal) =>
        client.getPullRequest(
          {
            owner: input.owner,
            repositoryName: input.repositoryName,
            pullNumber: input.pullNumber,
          },
          signal,
        ),
      this.requestPolicy,
    );
    const parsed = upstreamPullRequestSchema.safeParse(response.data);
    if (!parsed.success) throw new GithubControlError("INVALID_RESPONSE");
    if (parsed.data.number !== input.pullNumber) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    return parsed.data;
  }

  private async readFiles(
    client: GithubRestClient,
    input: GithubPullRequestReadInput,
    changedFiles: number,
  ): Promise<{
    files: GithubPullRequestSnapshot["files"];
    limitsHit: GithubPullRequestSnapshot["limitsHit"];
  }> {
    const target = Math.min(changedFiles, this.limits.maxFiles);
    const files: GithubPullRequestSnapshot["files"] = [];
    const filenames = new Set<string>();
    let patchBytes = 0;
    let patchBytesLimitHit = false;
    let patchUnavailable = false;
    let page = 1;
    const perPage = Math.min(100, this.limits.maxFiles);

    while (files.length < target) {
      const response = await executeGithubRequest(
        (signal) =>
          client.listPullRequestFiles(
            {
              owner: input.owner,
              repositoryName: input.repositoryName,
              pullNumber: input.pullNumber,
              page,
              perPage,
            },
            signal,
          ),
        this.requestPolicy,
      );
      const parsed = upstreamChangedFilesSchema.safeParse(response.data);
      if (!parsed.success || parsed.data.length > perPage) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
      if (parsed.data.length === 0) {
        throw new GithubControlError("INVALID_RESPONSE");
      }

      for (const file of parsed.data.slice(0, target - files.length)) {
        if (filenames.has(file.filename)) {
          throw new GithubControlError("INVALID_RESPONSE");
        }
        filenames.add(file.filename);
        const rawPatch = file.patch ?? null;
        let patch = rawPatch;
        if (rawPatch === null) {
          patchUnavailable = true;
        } else {
          const bytes = Buffer.byteLength(rawPatch, "utf8");
          if (
            bytes > this.limits.maxPatchBytesPerFile ||
            patchBytes + bytes > this.limits.maxTotalPatchBytes
          ) {
            patch = null;
            patchBytesLimitHit = true;
          } else {
            patchBytes += bytes;
          }
        }
        files.push({
          sha: file.sha,
          filename: file.filename,
          previousFilename: file.previous_filename ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch,
        });
      }
      page += 1;
    }

    if (files.length !== target) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    return {
      files,
      limitsHit: {
        files: changedFiles > this.limits.maxFiles,
        patchBytes: patchBytesLimitHit,
        patchUnavailable,
      },
    };
  }

  private async withRepositoryClient<T>(
    binding: GithubRepositoryBinding,
    operation: (client: GithubRestClient) => Promise<T>,
    forceFreshAuthorization = false,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let client: GithubRestClient;
      try {
        const repository = repositoryBinding(binding);
        const token =
          forceFreshAuthorization && attempt === 0
            ? await this.getFreshToken(repository)
            : await this.tokenProvider.get(repository);
        client = this.clientFactory(token);
      } catch (error) {
        if (error instanceof GithubControlError) throw error;
        throw new GithubControlError("UNAVAILABLE");
      }

      try {
        return await operation(client);
      } catch (error) {
        if (isUnauthorized(error)) {
          this.tokenProvider.invalidate(repositoryBinding(binding));
          if (attempt === 0) continue;
        }
        if (error instanceof GithubControlError) throw error;
        throw new GithubControlError("UNAVAILABLE");
      }
    }
    throw new GithubControlError("UNAVAILABLE");
  }

  private async getFreshToken(
    binding: GithubRepositoryBinding,
  ): Promise<string> {
    if (!this.tokenProvider.getFresh) {
      throw new GithubControlError("INVALID_INPUT");
    }
    return this.tokenProvider.getFresh(binding);
  }
}

function sameSnapshotMetadata(
  initial: ParsedPullRequest,
  final: ParsedPullRequest,
): boolean {
  return (
    final.id === initial.id &&
    final.number === initial.number &&
    final.state === initial.state &&
    (final.draft ?? false) === (initial.draft ?? false) &&
    final.title === initial.title &&
    final.body === initial.body &&
    final.changed_files === initial.changed_files &&
    final.user.id === initial.user.id &&
    final.user.login === initial.user.login &&
    final.head.sha === initial.head.sha &&
    final.head.repo?.id === initial.head.repo?.id &&
    final.head.repo?.full_name === initial.head.repo?.full_name &&
    final.base.sha === initial.base.sha &&
    final.base.repo.id === initial.base.repo.id &&
    final.base.repo.full_name === initial.base.repo.full_name
  );
}

function repositoryBinding(
  input: GithubRepositoryBinding,
): GithubRepositoryBinding {
  return {
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    owner: input.owner,
    repositoryName: input.repositoryName,
  };
}

function isUnauthorized(error: unknown): error is GithubControlError {
  return (
    error instanceof GithubControlError &&
    error.code === "REJECTED" &&
    error.status === 401
  );
}

function resolveLimits(input: GithubPullRequestLimits = {}): ResolvedLimits {
  const parsed = z
    .object({
      maxFiles: z.number().int().positive().max(3_000).default(300),
      maxPatchBytesPerFile: z
        .number()
        .int()
        .positive()
        .max(MAX_ACCEPTED_PATCH_CHARACTERS)
        .default(128 * 1_024),
      maxTotalPatchBytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1_024 * 1_024)
        .default(2 * 1_024 * 1_024),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
  return parsed.data;
}

function parseInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
  return parsed.data;
}

function assertRepositoryBinding(
  binding: GithubRepositoryBinding,
  pullRequest: ParsedPullRequest,
): void {
  const expectedFullName = `${binding.owner}/${binding.repositoryName}`;
  if (
    String(pullRequest.base.repo.id) !== binding.repositoryId ||
    pullRequest.base.repo.full_name.toLowerCase() !==
      expectedFullName.toLowerCase()
  ) {
    throw new GithubControlError("INVALID_RESPONSE");
  }
}
