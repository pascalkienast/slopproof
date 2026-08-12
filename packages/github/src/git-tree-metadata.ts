import { z } from "zod";
import type { GithubRestClient } from "./octokit-client";
import { GithubControlError } from "./production-errors";
import type {
  GithubChangedFile,
  GithubChangedFileGitKind,
} from "./production-ports";
import {
  executeGithubRequest,
  type GithubRequestPolicy,
} from "./request-policy";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const repositoryPartSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== "." && value !== "..");
const gitCommitResponseSchema = z
  .object({
    sha: shaSchema,
    tree: z.object({ sha: shaSchema }).passthrough(),
  })
  .passthrough();
const gitTreeEntrySchema = z
  .object({
    path: z.string().min(1).max(1_024),
    mode: z.string().min(1).max(16),
    type: z.string().min(1).max(16),
    sha: shaSchema,
  })
  .passthrough();
const gitTreeResponseSchema = z
  .object({
    sha: shaSchema,
    truncated: z.boolean(),
    tree: z.array(gitTreeEntrySchema).max(5_000),
  })
  .passthrough();

export const GithubGitTreeMetadataLimitsSchema = z
  .object({
    maxDepth: z.number().int().positive().max(64),
    maxApiCalls: z.number().int().positive().max(2_000),
    maxEntriesPerTree: z.number().int().positive().max(5_000),
    maxTotalEntries: z.number().int().positive().max(200_000),
    maxTotalDurationMs: z.number().int().positive().max(60_000),
  })
  .strict();

export type GithubGitTreeMetadataLimits = z.infer<
  typeof GithubGitTreeMetadataLimitsSchema
>;

export const DEFAULT_GITHUB_GIT_TREE_METADATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxApiCalls: 1_200,
  maxEntriesPerTree: 1_000,
  maxTotalEntries: 100_000,
  maxTotalDurationMs: 20_000,
}) satisfies GithubGitTreeMetadataLimits;

export type GithubGitTreeMetadataLimitsInput =
  Partial<GithubGitTreeMetadataLimits>;

type RepositoryRevision = {
  owner: string;
  repositoryName: string;
  commitSha: string;
};

type FileForKindResolution = Pick<
  GithubChangedFile,
  "filename" | "previousFilename" | "status"
>;

type ResolveFileKindsInput = {
  head: RepositoryRevision | null;
  base: RepositoryRevision;
  files: readonly FileForKindResolution[];
};

type GitTreeEntry = z.infer<typeof gitTreeEntrySchema>;

/**
 * Resolves only Git object metadata for exact changed paths. It never requests
 * recursive trees, blobs, repository contents, clones, or code search.
 */
export class GithubExactPathKindResolver {
  private readonly limits: GithubGitTreeMetadataLimits;
  private readonly treeCache = new Map<string, readonly GitTreeEntry[]>();
  private readonly rootTreeCache = new Map<string, string>();
  private apiCalls = 0;
  private totalEntries = 0;
  private readonly deadlineAt: number;

  constructor(
    private readonly client: GithubRestClient,
    private readonly requestPolicy: GithubRequestPolicy = {},
    limits: GithubGitTreeMetadataLimitsInput = {},
  ) {
    const parsed = GithubGitTreeMetadataLimitsSchema.safeParse({
      ...DEFAULT_GITHUB_GIT_TREE_METADATA_LIMITS,
      ...limits,
    });
    if (!parsed.success) throw new GithubControlError("INVALID_INPUT");
    this.limits = parsed.data;
    this.deadlineAt = this.now() + this.limits.maxTotalDurationMs;
  }

  async resolve(
    input: ResolveFileKindsInput,
  ): Promise<GithubChangedFileGitKind[]> {
    const kinds: GithubChangedFileGitKind[] = [];
    for (const file of input.files) {
      const paths = requiredPaths(file);
      const headKind =
        paths.head === null
          ? null
          : await this.resolvePath(requireHead(input.head), paths.head);
      const baseKind =
        paths.base === null
          ? null
          : await this.resolvePath(input.base, paths.base);
      kinds.push(combineKinds(headKind, baseKind));
    }
    return kinds;
  }

  private async resolvePath(
    revision: RepositoryRevision,
    path: string,
  ): Promise<GithubChangedFileGitKind> {
    const segments = parseGitPath(path, this.limits.maxDepth);
    let treeSha = await this.loadRootTreeSha(revision);

    for (let index = 0; index < segments.length; index += 1) {
      const entries = await this.loadTree(revision, treeSha);
      const segment = segments[index];
      const matches = entries.filter((entry) => entry.path === segment);
      if (matches.length !== 1)
        throw new GithubControlError("INVALID_RESPONSE");
      const entry = matches[0];
      if (entry === undefined) throw new GithubControlError("INVALID_RESPONSE");
      const last = index === segments.length - 1;
      if (!last) {
        if (entry.mode !== "040000" || entry.type !== "tree") {
          throw new GithubControlError("INVALID_RESPONSE");
        }
        treeSha = entry.sha;
        continue;
      }
      return leafKind(entry);
    }
    throw new GithubControlError("INVALID_RESPONSE");
  }

  private async loadRootTreeSha(revision: RepositoryRevision): Promise<string> {
    validateRevision(revision);
    const key = revisionKey(revision);
    const cached = this.rootTreeCache.get(key);
    if (cached !== undefined) return cached;
    const response = await this.executeRequest((signal) =>
      this.client.getGitCommit(
        {
          owner: revision.owner,
          repositoryName: revision.repositoryName,
          commitSha: revision.commitSha,
        },
        signal,
      ),
    );
    const parsed = gitCommitResponseSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.sha !== revision.commitSha) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    this.rootTreeCache.set(key, parsed.data.tree.sha);
    return parsed.data.tree.sha;
  }

  private async loadTree(
    revision: RepositoryRevision,
    treeSha: string,
  ): Promise<readonly GitTreeEntry[]> {
    const key = `${revision.owner.toLowerCase()}/${revision.repositoryName.toLowerCase()}:${treeSha}`;
    const cached = this.treeCache.get(key);
    if (cached !== undefined) return cached;
    const response = await this.executeRequest((signal) =>
      this.client.getGitTree(
        {
          owner: revision.owner,
          repositoryName: revision.repositoryName,
          treeSha,
        },
        signal,
      ),
    );
    const parsed = gitTreeResponseSchema.safeParse(response.data);
    if (
      !parsed.success ||
      parsed.data.sha !== treeSha ||
      parsed.data.truncated ||
      parsed.data.tree.length > this.limits.maxEntriesPerTree
    ) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    this.totalEntries += parsed.data.tree.length;
    if (this.totalEntries > this.limits.maxTotalEntries) {
      throw new GithubControlError("LIMIT_EXCEEDED");
    }
    validateTreeEntries(parsed.data.tree);
    this.treeCache.set(key, parsed.data.tree);
    return parsed.data.tree;
  }

  private consumeApiCall(): void {
    this.apiCalls += 1;
    if (this.apiCalls > this.limits.maxApiCalls) {
      throw new GithubControlError("LIMIT_EXCEEDED");
    }
  }

  private async executeRequest<T>(
    request: Parameters<typeof executeGithubRequest<T>>[0],
  ): Promise<Awaited<ReturnType<typeof executeGithubRequest<T>>>> {
    const remaining = Math.floor(this.deadlineAt - this.now());
    if (remaining < 1) throw new GithubControlError("TIMEOUT");
    return executeGithubRequest(
      (signal) => {
        this.consumeApiCall();
        return request(signal);
      },
      {
        ...this.requestPolicy,
        deadlineMs: Math.min(
          this.requestPolicy.deadlineMs ?? remaining,
          remaining,
        ),
        attemptTimeoutMs: Math.min(
          this.requestPolicy.attemptTimeoutMs ?? remaining,
          remaining,
        ),
      },
    );
  }

  private now(): number {
    return (this.requestPolicy.now ?? Date.now)();
  }
}

function requiredPaths(file: FileForKindResolution): {
  head: string | null;
  base: string | null;
} {
  if (file.status === "added") return { head: file.filename, base: null };
  if (file.status === "removed") return { head: null, base: file.filename };
  if (file.status === "renamed" || file.status === "copied") {
    if (file.previousFilename === null) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    return { head: file.filename, base: file.previousFilename };
  }
  return { head: file.filename, base: file.filename };
}

function requireHead(revision: RepositoryRevision | null): RepositoryRevision {
  if (revision === null) throw new GithubControlError("INVALID_RESPONSE");
  return revision;
}

function combineKinds(
  head: GithubChangedFileGitKind | null,
  base: GithubChangedFileGitKind | null,
): GithubChangedFileGitKind {
  if (head === null && base === null) {
    throw new GithubControlError("INVALID_RESPONSE");
  }
  if (head === "submodule" || base === "submodule") return "submodule";
  if (head === "symlink" || base === "symlink") return "symlink";
  return "blob";
}

function leafKind(entry: GitTreeEntry): GithubChangedFileGitKind {
  if (
    (entry.mode === "100644" || entry.mode === "100755") &&
    entry.type === "blob"
  ) {
    return "blob";
  }
  if (entry.mode === "120000" && entry.type === "blob") return "symlink";
  if (entry.mode === "160000" && entry.type === "commit") {
    return "submodule";
  }
  throw new GithubControlError("INVALID_RESPONSE");
}

function validateTreeEntries(entries: readonly GitTreeEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (
      entry.path.includes("/") ||
      entry.path.includes("\0") ||
      entry.path === "." ||
      entry.path === ".." ||
      paths.has(entry.path)
    ) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    paths.add(entry.path);
    const valid =
      ((entry.mode === "100644" || entry.mode === "100755") &&
        entry.type === "blob") ||
      (entry.mode === "120000" && entry.type === "blob") ||
      (entry.mode === "160000" && entry.type === "commit") ||
      (entry.mode === "040000" && entry.type === "tree");
    if (!valid) throw new GithubControlError("INVALID_RESPONSE");
  }
}

function parseGitPath(path: string, maxDepth: number): string[] {
  if (path.startsWith("/") || path.includes("\0")) {
    throw new GithubControlError("INVALID_RESPONSE");
  }
  const segments = path.split("/");
  if (
    segments.length === 0 ||
    segments.length > maxDepth ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new GithubControlError(
      segments.length > maxDepth ? "LIMIT_EXCEEDED" : "INVALID_RESPONSE",
    );
  }
  return segments;
}

function validateRevision(revision: RepositoryRevision): void {
  const parsed = z
    .object({
      owner: repositoryPartSchema,
      repositoryName: repositoryPartSchema,
      commitSha: shaSchema,
    })
    .strict()
    .safeParse(revision);
  if (!parsed.success) throw new GithubControlError("INVALID_RESPONSE");
}

function revisionKey(revision: RepositoryRevision): string {
  return `${revision.owner.toLowerCase()}/${revision.repositoryName.toLowerCase()}:${revision.commitSha}`;
}
