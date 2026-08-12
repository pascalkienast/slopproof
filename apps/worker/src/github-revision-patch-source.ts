import { timingSafeEqual } from "node:crypto";
import {
  DEFAULT_GENERATION_CONTEXT_LIMITS_V1,
  GenerationContextValidationError,
  GithubRevisionSourceV1Schema,
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  githubRevisionSourceHash,
  type BoundedRevisionSourceV1,
  type GenerationContextLimitsV1,
  type PullRequestPatch,
} from "@slopproof/analysis";

export type DatabaseRevisionPatchRequest = {
  revisionId: string;
  owner: string;
  repositoryName: string;
  pullRequestNumber: number;
  githubPullRequestId: string;
  authorId: string;
  baseSha: string;
  headSha: string;
};

export interface DatabaseRevisionPatchSource {
  loadPatch(input: DatabaseRevisionPatchRequest): Promise<PullRequestPatch>;
}

export interface RevisionSourceQueryPort {
  query(
    statement: string,
    parameters?: unknown[],
  ): Promise<{ rows: unknown[] }>;
}

type RevisionSourceRow = {
  revision_id: string;
  revision_head_sha: string;
  revision_base_sha: string;
  owner: string;
  repository_name: string;
  pull_request_number: number;
  github_pull_request_id: string;
  pull_request_author_id: string;
  pull_request_state: string;
  source_head_sha: string;
  source_base_sha: string;
  source: unknown;
  source_hash: string;
};

export class GithubRevisionPatchSourceError extends Error {
  readonly code = "GITHUB_REVISION_PATCH_SOURCE_INVALID" as const;

  constructor() {
    super("Stored revision patch source is unavailable or invalid.");
    this.name = "GithubRevisionPatchSourceError";
  }
}

/**
 * Production patch boundary. It performs one exact DB read and never receives
 * a GitHub client, URL fetcher, filesystem checkout, archive reader or search
 * port, so repo traversal and content downloads are structurally unavailable.
 */
export class PostgresGithubRevisionPatchSource implements DatabaseRevisionPatchSource {
  private readonly limits: GenerationContextLimitsV1;

  constructor(
    private readonly pool: RevisionSourceQueryPort,
    limits: GenerationContextLimitsV1 = DEFAULT_GENERATION_CONTEXT_LIMITS_V1,
  ) {
    this.limits = limits;
  }

  async loadPatch(
    input: DatabaseRevisionPatchRequest,
  ): Promise<PullRequestPatch> {
    return boundedRevisionSourcePatch(await this.loadBoundedSource(input));
  }

  async loadBoundedSource(
    input: DatabaseRevisionPatchRequest,
  ): Promise<BoundedRevisionSourceV1> {
    if (!validRequest(input)) throw new GithubRevisionPatchSourceError();
    let result: { rows: unknown[] };
    try {
      result = await this.pool.query(
        `SELECT revision.id AS revision_id,
                revision.head_sha AS revision_head_sha,
                revision.base_sha AS revision_base_sha,
                repository.owner,
                repository.name AS repository_name,
                pull_request.number AS pull_request_number,
                pull_request.github_pull_request_id,
                pull_request.author_id AS pull_request_author_id,
                pull_request.state AS pull_request_state,
                source.head_sha AS source_head_sha,
                source.base_sha AS source_base_sha,
                source.source,
                source.source_hash
           FROM github_revision_sources source
           JOIN pull_request_revisions revision
             ON revision.id = source.revision_id
           JOIN pull_requests pull_request
             ON pull_request.id = revision.pull_request_id
           JOIN repositories repository
             ON repository.id = pull_request.repository_id
           JOIN installations installation
             ON installation.id = repository.installation_id
          WHERE source.revision_id = $1
            AND revision.head_sha = $2
            AND revision.base_sha = $3
            AND repository.owner = $4
            AND repository.name = $5
            AND pull_request.number = $6
            AND pull_request.state = 'open'
            AND revision.is_current = true
            AND repository.status = 'active'
            AND installation.status = 'active'
          LIMIT 2`,
        [
          input.revisionId,
          input.headSha,
          input.baseSha,
          input.owner,
          input.repositoryName,
          input.pullRequestNumber,
        ],
      );
    } catch {
      throw new GithubRevisionPatchSourceError();
    }
    if (result.rows.length !== 1) throw new GithubRevisionPatchSourceError();
    const row = parseRevisionSourceRow(result.rows[0]);
    if (!row) throw new GithubRevisionPatchSourceError();
    try {
      if (
        row.revision_id !== input.revisionId ||
        row.revision_head_sha !== input.headSha ||
        row.revision_base_sha !== input.baseSha ||
        row.source_head_sha !== input.headSha ||
        row.source_base_sha !== input.baseSha ||
        row.owner !== input.owner ||
        row.repository_name !== input.repositoryName ||
        row.pull_request_number !== input.pullRequestNumber ||
        row.github_pull_request_id !== input.githubPullRequestId ||
        row.pull_request_author_id !== input.authorId ||
        !/^[a-f0-9]{64}$/u.test(row.source_hash) ||
        !safeHashEqual(githubRevisionSourceHash(row.source), row.source_hash)
      ) {
        throw new GithubRevisionPatchSourceError();
      }
      const source = GithubRevisionSourceV1Schema.parse(row.source);
      if (
        source.githubPullRequestId !== row.github_pull_request_id ||
        source.number !== row.pull_request_number ||
        source.authorId !== row.pull_request_author_id ||
        source.state !== row.pull_request_state ||
        source.state !== "open"
      ) {
        throw new GithubRevisionPatchSourceError();
      }
      const bounded = buildBoundedRevisionSourceV1(source, this.limits);
      if (bounded.sourceHash !== row.source_hash) {
        throw new GithubRevisionPatchSourceError();
      }
      return bounded;
    } catch (error) {
      if (error instanceof GithubRevisionPatchSourceError) throw error;
      if (error instanceof GenerationContextValidationError) {
        throw new GithubRevisionPatchSourceError();
      }
      throw new GithubRevisionPatchSourceError();
    }
  }
}

function parseRevisionSourceRow(value: unknown): RevisionSourceRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.revision_id !== "string" ||
    typeof value.revision_head_sha !== "string" ||
    typeof value.revision_base_sha !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.repository_name !== "string" ||
    typeof value.pull_request_number !== "number" ||
    typeof value.github_pull_request_id !== "string" ||
    typeof value.pull_request_author_id !== "string" ||
    typeof value.pull_request_state !== "string" ||
    typeof value.source_head_sha !== "string" ||
    typeof value.source_base_sha !== "string" ||
    typeof value.source_hash !== "string"
  ) {
    return null;
  }
  return {
    revision_id: value.revision_id,
    revision_head_sha: value.revision_head_sha,
    revision_base_sha: value.revision_base_sha,
    owner: value.owner,
    repository_name: value.repository_name,
    pull_request_number: value.pull_request_number,
    github_pull_request_id: value.github_pull_request_id,
    pull_request_author_id: value.pull_request_author_id,
    pull_request_state: value.pull_request_state,
    source_head_sha: value.source_head_sha,
    source_base_sha: value.source_base_sha,
    source: value.source,
    source_hash: value.source_hash,
  };
}

function validRequest(input: DatabaseRevisionPatchRequest): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.revisionId,
    ) &&
    /^[a-f0-9]{40}$/u.test(input.baseSha) &&
    /^[a-f0-9]{40}$/u.test(input.headSha) &&
    input.owner.length > 0 &&
    input.owner.length <= 100 &&
    input.repositoryName.length > 0 &&
    input.repositoryName.length <= 100 &&
    Number.isSafeInteger(input.pullRequestNumber) &&
    input.pullRequestNumber > 0 &&
    input.pullRequestNumber <= 2_147_483_647 &&
    /^[1-9][0-9]{0,15}$/u.test(input.githubPullRequestId) &&
    /^[1-9][0-9]{0,15}$/u.test(input.authorId) &&
    !/[\0\r\n]/u.test(input.owner) &&
    !/[\0\r\n]/u.test(input.repositoryName)
  );
}

function safeHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
