import { createHash } from "node:crypto";
import {
  GitShaSchema,
  IdempotencyKeySchema,
  Sha256Schema,
  UuidSchema,
} from "@slopproof/domain";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import {
  GithubReconcileCheckJobSchema,
  expediteJobInPgTransaction,
  type JobPayload,
} from "./jobs";

const GithubOauthPurposeSchema = z.enum([
  "contributor_login",
  "maintainer_reauth",
]);
const GithubRedirectPathSchema = z
  .string()
  .regex(
    /^\/(?:review(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?|revisions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/contribute(?:\/practice)?)?)$/,
  );
const CheckStatusSchema = z.enum(["queued", "in_progress", "completed"]);
const CheckConclusionSchema = z.enum([
  "action_required",
  "success",
  "neutral",
  "cancelled",
]);
const CheckReasonSchema = GithubReconcileCheckJobSchema.shape.reason;
const ErrorClassSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const GithubRemoteIdSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(32);
const CheckDetailsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}, "must use HTTPS or credential-free loopback HTTP without query or fragment");

const GithubChangedFileSchema = z
  .object({
    sha: GitShaSchema.nullable(),
    filename: z.string().min(1).max(1_024),
    previousFilename: z.string().min(1).max(1_024).nullable(),
    status: z.enum([
      "added",
      "removed",
      "modified",
      "renamed",
      "copied",
      "changed",
      "unchanged",
    ]),
    additions: z.number().int().nonnegative().safe(),
    deletions: z.number().int().nonnegative().safe(),
    changes: z.number().int().nonnegative().safe(),
    patch: z
      .string()
      .max(128 * 1_024)
      .nullable(),
    gitKind: z.enum(["blob", "symlink", "submodule"]),
  })
  .strict();

const GithubRevisionSourceSchema = z
  .object({
    githubPullRequestId: z.string().regex(/^[1-9][0-9]{0,15}$/),
    number: z.number().int().positive().max(2_147_483_647),
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    title: z.string().max(4_096),
    body: z.string().max(65_536).nullable(),
    authorId: z.string().regex(/^[1-9][0-9]{0,15}$/),
    authorLogin: z.string().min(1).max(100),
    headSha: GitShaSchema,
    baseSha: GitShaSchema,
    changedFiles: z.number().int().nonnegative().safe(),
    isFork: z.boolean(),
    files: z.array(GithubChangedFileSchema).max(300),
    limitsHit: z
      .object({
        files: z.boolean(),
        patchBytes: z.boolean(),
        patchUnavailable: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((source, context) => {
    const patchBytes = source.files.reduce(
      (total, file) => total + Buffer.byteLength(file.patch ?? "", "utf8"),
      0,
    );
    const oversizedFile = source.files.some(
      (file) => Buffer.byteLength(file.patch ?? "", "utf8") > 128 * 1_024,
    );
    if (patchBytes > 2 * 1_024 * 1_024 || oversizedFile) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "total patch data exceeds 2 MiB",
      });
    }
    const expectedFiles = Math.min(source.changedFiles, 300);
    const filesTruncated = source.changedFiles > 300;
    const missingPatch = source.files.some((file) => file.patch === null);
    if (
      source.files.length !== expectedFiles ||
      source.limitsHit.files !== filesTruncated ||
      (source.limitsHit.patchUnavailable || source.limitsHit.patchBytes) !==
        missingPatch
    ) {
      context.addIssue({
        code: "custom",
        path: ["limitsHit"],
        message: "source truncation flags require exact bounded evidence",
      });
    }
  });

const GithubRevisionSourceInputSchema = z
  .object({
    revisionId: UuidSchema,
    fetchedAt: z.date(),
    source: GithubRevisionSourceSchema,
  })
  .strict();

type GithubRevisionSource = z.output<typeof GithubRevisionSourceSchema>;

function immutableRevisionMaterial(source: GithubRevisionSource): string {
  return JSON.stringify([
    "slopproof-github-revision-material",
    1,
    source.githubPullRequestId,
    source.number,
    source.authorId,
    source.headSha,
    source.baseSha,
    source.changedFiles,
    source.isFork,
    source.files.map((file) => [
      file.sha,
      file.filename,
      file.previousFilename,
      file.status,
      file.additions,
      file.deletions,
      file.changes,
      file.patch,
      file.gitKind,
    ]),
    [
      source.limitsHit.files,
      source.limitsHit.patchBytes,
      source.limitsHit.patchUnavailable,
    ],
  ]);
}

const GithubOauthFlowInputSchema = z
  .object({
    stateHash: Sha256Schema,
    purpose: GithubOauthPurposeSchema,
    repositoryId: UuidSchema,
    redirectPath: GithubRedirectPathSchema,
    expiresAt: z.date(),
  })
  .strict();

const GithubCheckIntentSchema = z
  .object({
    revisionId: UuidSchema,
    expectedHeadSha: GitShaSchema,
    idempotencyKey: IdempotencyKeySchema,
    reason: CheckReasonSchema,
    name: z.string().trim().min(1).max(200),
    status: CheckStatusSchema,
    conclusion: CheckConclusionSchema.nullable(),
    publicSummary: z.string().min(1).max(2_000),
    detailsUrl: CheckDetailsUrlSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.status === "completed" && intent.conclusion === null) {
      context.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "completed checks require a conclusion",
      });
    }
    if (intent.status !== "completed" && intent.conclusion !== null) {
      context.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "non-completed checks cannot have a conclusion",
      });
    }
  });

export type GithubOauthFlow = {
  id: string;
  purpose: z.infer<typeof GithubOauthPurposeSchema>;
  repositoryId: string;
  redirectPath: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type GithubCheckIntent = z.input<typeof GithubCheckIntentSchema>;
export type { GithubRevisionSource };

export type PersistedGithubRevisionSource = {
  revisionId: string;
  headSha: string;
  baseSha: string;
  source: GithubRevisionSource;
  sourceHash: string;
  fetchedAt: Date;
};

export class GithubOauthFlowConflictError extends Error {
  readonly code = "GITHUB_OAUTH_FLOW_CONFLICT" as const;
}

export class GithubCheckIntentConflictError extends Error {
  readonly code = "GITHUB_CHECK_INTENT_CONFLICT" as const;
}

export class StaleGithubCheckIntentError extends Error {
  readonly code = "STALE_GITHUB_CHECK_INTENT" as const;
}

export class GithubRevisionSourceConflictError extends Error {
  readonly code = "GITHUB_REVISION_SOURCE_CONFLICT" as const;
}

export class StaleGithubRevisionSourceError extends Error {
  readonly code = "STALE_GITHUB_REVISION_SOURCE" as const;
}

export class GithubRevisionSourceIntegrityError extends Error {
  readonly code = "GITHUB_REVISION_SOURCE_INTEGRITY" as const;
}

export interface GithubCheckOutbox {
  publish(
    client: PoolClient,
    payload: JobPayload<"github.reconcile-check">,
  ): Promise<string | null>;
}

export class PgBossGithubCheckOutbox implements GithubCheckOutbox {
  constructor(private readonly queue: PgBoss) {}

  publish(
    client: PoolClient,
    payload: JobPayload<"github.reconcile-check">,
  ): Promise<string | null> {
    return expediteJobInPgTransaction(
      this.queue,
      client,
      "github.reconcile-check",
      payload,
    );
  }
}

export async function createGithubOauthFlow(
  pool: Pool,
  rawInput: z.input<typeof GithubOauthFlowInputSchema>,
): Promise<GithubOauthFlow> {
  const input = GithubOauthFlowInputSchema.parse(rawInput);
  try {
    const result = await pool.query<GithubOauthFlowRow>(
      `INSERT INTO github_oauth_flows
         (state_hash, purpose, repository_id, redirect_path, expires_at)
       SELECT $1, $2, $3, $4, $5
       WHERE $5 > now()
       RETURNING id, purpose, repository_id, redirect_path, expires_at, consumed_at`,
      [
        input.stateHash,
        input.purpose,
        input.repositoryId,
        input.redirectPath,
        input.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (!row)
      throw new GithubOauthFlowConflictError("OAuth flow already expired");
    return mapOauthFlow(row);
  } catch (error) {
    if ((error as { code?: unknown }).code === "23505") {
      throw new GithubOauthFlowConflictError(
        "OAuth state was already reserved",
      );
    }
    throw error;
  }
}

/** Atomically consumes one unexpired state. Concurrent callbacks yield one winner. */
export async function consumeGithubOauthFlow(
  pool: Pool,
  stateHash: string,
): Promise<GithubOauthFlow | null> {
  const validatedStateHash = Sha256Schema.parse(stateHash);
  const result = await pool.query<GithubOauthFlowRow>(
    `UPDATE github_oauth_flows
        SET consumed_at = now()
      WHERE state_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, purpose, repository_id, redirect_path, expires_at, consumed_at`,
    [validatedStateHash],
  );
  const row = result.rows[0];
  return row ? mapOauthFlow(row) : null;
}

/** Stores the canonical GitHub snapshot before its analysis job in the caller's transaction. */
export async function persistGithubRevisionSourceInTransaction(
  client: PoolClient,
  rawInput: z.input<typeof GithubRevisionSourceInputSchema>,
): Promise<{ sourceHash: string; replay: boolean }> {
  const input = GithubRevisionSourceInputSchema.parse(rawInput);
  const sourceJson = JSON.stringify(input.source);
  if (Buffer.byteLength(sourceJson, "utf8") > 3 * 1_024 * 1_024) {
    throw new GithubRevisionSourceConflictError(
      "GitHub revision source exceeds 3 MiB",
    );
  }
  const sourceHash = createHash("sha256").update(sourceJson).digest("hex");
  const revision = await client.query<{
    head_sha: string;
    base_sha: string;
    is_current: boolean;
  }>(
    `SELECT head_sha, base_sha, is_current
       FROM pull_request_revisions
      WHERE id = $1
      FOR UPDATE`,
    [input.revisionId],
  );
  const row = revision.rows[0];
  if (
    !row ||
    !row.is_current ||
    row.head_sha !== input.source.headSha ||
    row.base_sha !== input.source.baseSha
  ) {
    throw new StaleGithubRevisionSourceError(
      "GitHub source is not bound to the current exact revision",
    );
  }

  const inserted = await client.query<{ source_hash: string }>(
    `INSERT INTO github_revision_sources
       (revision_id, head_sha, base_sha, source, source_hash, fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (revision_id) DO NOTHING
     RETURNING source_hash`,
    [
      input.revisionId,
      input.source.headSha,
      input.source.baseSha,
      sourceJson,
      sourceHash,
      input.fetchedAt,
    ],
  );
  if (inserted.rowCount === 1) return { sourceHash, replay: false };

  const existing = await client.query<{
    source: unknown;
    source_hash: string;
  }>(
    `SELECT source, source_hash FROM github_revision_sources
      WHERE revision_id = $1`,
    [input.revisionId],
  );
  const existingRow = existing.rows[0];
  if (!existingRow) {
    throw new GithubRevisionSourceConflictError(
      "Revision source replay disappeared",
    );
  }
  const existingSource = GithubRevisionSourceSchema.parse(existingRow.source);
  const existingSourceHash = createHash("sha256")
    .update(JSON.stringify(existingSource))
    .digest("hex");
  if (existingSourceHash !== existingRow.source_hash) {
    throw new GithubRevisionSourceIntegrityError(
      "Stored GitHub revision source failed its content hash",
    );
  }
  if (
    immutableRevisionMaterial(existingSource) !==
    immutableRevisionMaterial(input.source)
  ) {
    throw new GithubRevisionSourceConflictError(
      "Revision already has different immutable GitHub patch material",
    );
  }
  return { sourceHash: existingRow.source_hash, replay: true };
}

export async function loadGithubRevisionSource(
  pool: Pool,
  revisionId: string,
): Promise<PersistedGithubRevisionSource | null> {
  const validatedRevisionId = UuidSchema.parse(revisionId);
  const result = await pool.query<GithubRevisionSourceRow>(
    `SELECT revision_id, head_sha, base_sha, source, source_hash, fetched_at
       FROM github_revision_sources
      WHERE revision_id = $1`,
    [validatedRevisionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const source = GithubRevisionSourceSchema.parse(row.source);
  const computedHash = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  if (
    source.headSha !== row.head_sha ||
    source.baseSha !== row.base_sha ||
    computedHash !== row.source_hash
  ) {
    throw new GithubRevisionSourceIntegrityError(
      "Stored GitHub revision source failed its SHA or hash binding",
    );
  }
  return {
    revisionId: row.revision_id,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    source,
    sourceHash: row.source_hash,
    fetchedAt: row.fetched_at,
  };
}

export async function persistGithubCheckIntent(
  pool: Pool,
  outbox: GithubCheckOutbox,
  rawInput: GithubCheckIntent,
): Promise<{ checkRunId: string; replay: boolean; queueJobId: string | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await persistGithubCheckIntentInTransaction(
      client,
      outbox,
      rawInput,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Persists the intent and pg-boss effect inside the caller's open transaction. */
export async function persistGithubCheckIntentInTransaction(
  client: PoolClient,
  outbox: GithubCheckOutbox,
  rawInput: GithubCheckIntent,
): Promise<{ checkRunId: string; replay: boolean; queueJobId: string | null }> {
  const input = GithubCheckIntentSchema.parse(rawInput);
  const intentHash = hashCheckIntent(input);
  const revision = await client.query<{
    head_sha: string;
    is_current: boolean;
  }>(
    `SELECT head_sha, is_current
       FROM pull_request_revisions
      WHERE id = $1
      FOR UPDATE`,
    [input.revisionId],
  );
  const revisionRow = revision.rows[0];
  const permitsNoncurrentInvalidation =
    input.reason === "revision_invalidated" &&
    input.status === "completed" &&
    input.conclusion === "cancelled";
  if (
    !revisionRow ||
    revisionRow.head_sha !== input.expectedHeadSha ||
    (!revisionRow.is_current && !permitsNoncurrentInvalidation)
  ) {
    throw new StaleGithubCheckIntentError(
      "Check intent is not bound to the current revision",
    );
  }

  const existing = await client.query<{
    id: string;
    intent_idempotency_key: string | null;
    intent_hash: string | null;
    intent_reason: z.infer<typeof CheckReasonSchema> | null;
    sync_status: string;
    last_sync_error_class: string | null;
  }>(
    `SELECT id, intent_idempotency_key, intent_hash, intent_reason,
            sync_status, last_sync_error_class
       FROM check_runs
      WHERE revision_id = $1
      FOR UPDATE`,
    [input.revisionId],
  );
  const existingRow = existing.rows[0];
  if (
    existingRow?.intent_idempotency_key === input.idempotencyKey &&
    existingRow.intent_hash !== intentHash
  ) {
    throw new GithubCheckIntentConflictError(
      "Check idempotency key was reused with a different intent",
    );
  }
  const replay =
    existingRow?.intent_idempotency_key === input.idempotencyKey &&
    existingRow.intent_hash === intentHash;
  const reactivatingInactiveReplay =
    replay &&
    existingRow.sync_status === "permanent_failure" &&
    existingRow.last_sync_error_class === "InactiveGithubBinding";

  if (input.reason === "analysis_ready" && !replay) {
    const progress = await client.query<{ advanced: boolean }>(
      `SELECT EXISTS (
                SELECT 1
                  FROM attempts
                 WHERE revision_id = $1
                   AND status NOT IN ('preparing', 'ready')
              ) OR EXISTS (
                SELECT 1
                  FROM review_decisions decision
                  JOIN attempts attempt ON attempt.id = decision.attempt_id
                 WHERE attempt.revision_id = $1
              ) AS advanced`,
      [input.revisionId],
    );
    const advancedIntent =
      existingRow?.intent_reason !== undefined &&
      existingRow.intent_reason !== null &&
      !["webhook_ingested", "analysis_ready"].includes(
        existingRow.intent_reason,
      );
    if (advancedIntent || progress.rows[0]?.advanced === true) {
      if (!existingRow) {
        throw new StaleGithubCheckIntentError(
          "Analysis Check intent is stale relative to proof progress",
        );
      }
      return {
        checkRunId: existingRow.id,
        replay: true,
        queueJobId: null,
      };
    }
  }

  const persisted = replay
    ? reactivatingInactiveReplay
      ? (
          await client.query<{ id: string }>(
            `UPDATE check_runs
                SET sync_status = 'pending',
                    last_sync_error_class = NULL,
                    next_sync_after = NULL,
                    sync_requested_at = now(),
                    updated_at = now()
              WHERE id = $1
                AND sync_status = 'permanent_failure'
                AND last_sync_error_class = 'InactiveGithubBinding'
              RETURNING id`,
            [existingRow.id],
          )
        ).rows[0]!
      : { id: existingRow.id }
    : (
        await client.query<{ id: string }>(
          `INSERT INTO check_runs
             (revision_id, name, status, conclusion, public_summary,
              details_url, sync_status, sync_requested_at,
              intent_idempotency_key, intent_hash, intent_reason)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', now(), $7, $8, $9)
           ON CONFLICT (revision_id) DO UPDATE SET
             name = EXCLUDED.name,
             status = EXCLUDED.status,
             conclusion = EXCLUDED.conclusion,
             public_summary = EXCLUDED.public_summary,
             details_url = EXCLUDED.details_url,
             sync_status = 'pending',
             last_sync_error_class = NULL,
             last_synchronized_at = NULL,
             next_sync_after = NULL,
             sync_requested_at = now(),
             intent_idempotency_key = EXCLUDED.intent_idempotency_key,
             intent_hash = EXCLUDED.intent_hash,
             intent_reason = EXCLUDED.intent_reason,
             updated_at = now()
           RETURNING id`,
          [
            input.revisionId,
            input.name,
            input.status,
            input.conclusion,
            input.publicSummary,
            input.detailsUrl,
            input.idempotencyKey,
            intentHash,
            input.reason,
          ],
        )
      ).rows[0]!;

  const queueJobId = await outbox.publish(client, {
    schemaVersion: "1",
    idempotencyKey: input.idempotencyKey,
    revisionId: input.revisionId,
    expectedHeadSha: input.expectedHeadSha,
    reason: input.reason,
  });
  return { checkRunId: persisted.id, replay, queueJobId };
}

/** Replays the unchanged advanced intent after a verified lifecycle reactivation. */
export async function reactivateInactiveGithubCheckIntentInTransaction(
  client: PoolClient,
  outbox: GithubCheckOutbox,
  revisionId: string,
  expectedHeadSha: string,
): Promise<boolean> {
  const checkedRevisionId = UuidSchema.parse(revisionId);
  const checkedHeadSha = GitShaSchema.parse(expectedHeadSha);
  const existing = await client.query<{
    id: string;
    intent_idempotency_key: string;
    intent_reason: z.infer<typeof CheckReasonSchema>;
  }>(
    `UPDATE check_runs check_run
        SET sync_status = 'pending',
            last_sync_error_class = NULL,
            next_sync_after = NULL,
            sync_requested_at = now(),
            updated_at = now()
       FROM pull_request_revisions revision
      WHERE check_run.revision_id = revision.id
        AND revision.id = $1 AND revision.head_sha = $2
        AND revision.is_current = true
        AND check_run.sync_status = 'permanent_failure'
        AND check_run.last_sync_error_class = 'InactiveGithubBinding'
        AND check_run.intent_idempotency_key IS NOT NULL
        AND check_run.intent_reason IS NOT NULL
      RETURNING check_run.id, check_run.intent_idempotency_key,
                check_run.intent_reason`,
    [checkedRevisionId, checkedHeadSha],
  );
  const row = existing.rows[0];
  if (!row) return false;
  await outbox.publish(client, {
    schemaVersion: "1",
    idempotencyKey: row.intent_idempotency_key,
    revisionId: checkedRevisionId,
    expectedHeadSha: checkedHeadSha,
    reason: row.intent_reason,
  });
  return true;
}

export type ClaimedGithubCheckSync = {
  checkRunId: string;
  attempt: number;
  githubCheckRunId: string | null;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "action_required" | "success" | "neutral" | "cancelled" | null;
  publicSummary: string;
  detailsUrl: string;
  intentReason: z.infer<typeof CheckReasonSchema>;
};

export async function claimGithubCheckSync(
  pool: Pool,
  input: {
    revisionId: string;
    expectedHeadSha: string;
    reason: z.infer<typeof CheckReasonSchema>;
  },
): Promise<ClaimedGithubCheckSync | null> {
  const revisionId = UuidSchema.parse(input.revisionId);
  const expectedHeadSha = GitShaSchema.parse(input.expectedHeadSha);
  const reason = CheckReasonSchema.parse(input.reason);
  const result = await pool.query<ClaimedGithubCheckSyncRow>(
    `UPDATE check_runs check_run
        SET sync_status = 'syncing',
            sync_attempts = sync_attempts + 1,
            last_sync_error_class = NULL,
            next_sync_after = NULL,
            updated_at = now()
       FROM pull_request_revisions revision
      WHERE check_run.revision_id = revision.id
        AND revision.id = $1
        AND revision.head_sha = $2
        AND check_run.intent_reason = $3
        AND (check_run.next_sync_after IS NULL OR check_run.next_sync_after <= now())
        AND (
          revision.is_current = true
          OR (
            check_run.intent_reason = 'revision_invalidated'
            AND check_run.status = 'completed'
            AND check_run.conclusion = 'cancelled'
          )
        )
        AND (
          check_run.sync_status IN ('pending', 'retry_required')
          OR (
            check_run.sync_status = 'syncing'
            AND check_run.updated_at < now() - interval '2 minutes'
          )
        )
      RETURNING check_run.id, check_run.sync_attempts,
                check_run.github_check_run_id, check_run.name,
                check_run.status, check_run.conclusion,
                check_run.public_summary, check_run.details_url,
                check_run.intent_reason`,
    [revisionId, expectedHeadSha, reason],
  );
  const row = result.rows[0];
  return row ? mapClaimedCheck(row) : null;
}

export async function completeGithubCheckSync(
  pool: Pool,
  rawInput: {
    checkRunId: string;
    attempt: number;
    githubCheckRunId: string;
  },
): Promise<boolean> {
  const input = z
    .object({
      checkRunId: UuidSchema,
      attempt: z.number().int().positive(),
      githubCheckRunId: GithubRemoteIdSchema,
    })
    .strict()
    .parse(rawInput);
  const result = await pool.query(
    `UPDATE check_runs
        SET github_check_run_id = $3,
            sync_status = 'synchronized',
            last_sync_error_class = NULL,
            next_sync_after = NULL,
            last_synchronized_at = now(),
            updated_at = now()
      WHERE id = $1 AND sync_attempts = $2 AND sync_status = 'syncing'`,
    [input.checkRunId, input.attempt, input.githubCheckRunId],
  );
  return result.rowCount === 1;
}

/**
 * Marks an old-SHA invalidation intent handled without touching GitHub. GitHub
 * requires a current ref before every Check write, so mutating the old remote
 * run after a push would violate the SHA invariant.
 */
export async function completeSkippedGithubInvalidationSync(
  pool: Pool,
  rawInput: { checkRunId: string; attempt: number },
): Promise<boolean> {
  const input = z
    .object({
      checkRunId: UuidSchema,
      attempt: z.number().int().positive(),
    })
    .strict()
    .parse(rawInput);
  const result = await pool.query(
    `UPDATE check_runs
        SET sync_status = 'synchronized',
            last_sync_error_class = NULL,
            next_sync_after = NULL,
            last_synchronized_at = now(),
            updated_at = now()
      WHERE id = $1 AND sync_attempts = $2 AND sync_status = 'syncing'
        AND intent_reason = 'revision_invalidated'
        AND status = 'completed' AND conclusion = 'cancelled'`,
    [input.checkRunId, input.attempt],
  );
  return result.rowCount === 1;
}

/** Terminally acknowledges a Check intent whose GitHub binding is inactive. */
export async function completeInactiveGithubCheckSync(
  pool: Pool,
  rawInput: { checkRunId: string; attempt: number },
): Promise<boolean> {
  const input = z
    .object({
      checkRunId: UuidSchema,
      attempt: z.number().int().positive(),
    })
    .strict()
    .parse(rawInput);
  const result = await pool.query(
    `UPDATE check_runs
        SET sync_status = 'permanent_failure',
            last_sync_error_class = 'InactiveGithubBinding',
            next_sync_after = NULL,
            updated_at = now()
      WHERE id = $1 AND sync_attempts = $2 AND sync_status = 'syncing'
        AND EXISTS (
          SELECT 1
            FROM pull_request_revisions revision
            JOIN pull_requests pull_request
              ON pull_request.id = revision.pull_request_id
            JOIN repositories repository
              ON repository.id = pull_request.repository_id
            JOIN installations installation
              ON installation.id = repository.installation_id
           WHERE revision.id = check_runs.revision_id
             AND (repository.status <> 'active'
                  OR installation.status <> 'active')
        )`,
    [input.checkRunId, input.attempt],
  );
  return result.rowCount === 1;
}

export async function failGithubCheckSync(
  pool: Pool,
  rawInput: {
    checkRunId: string;
    attempt: number;
    errorClass: string;
    retryable: boolean;
    nextSyncAfter?: Date;
  },
): Promise<boolean> {
  const input = z
    .object({
      checkRunId: UuidSchema,
      attempt: z.number().int().positive(),
      errorClass: ErrorClassSchema,
      retryable: z.boolean(),
      nextSyncAfter: z.date().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.retryable && value.nextSyncAfter === undefined) {
        context.addIssue({
          code: "custom",
          path: ["nextSyncAfter"],
          message: "a retryable failure requires a durable retry schedule",
        });
      }
      if (!value.retryable && value.nextSyncAfter !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["nextSyncAfter"],
          message: "a permanent failure cannot have a retry schedule",
        });
      }
    })
    .parse(rawInput);
  const result = await pool.query(
    `UPDATE check_runs
        SET sync_status = CASE
              WHEN $4 THEN 'retry_required'::github_check_sync_status
              ELSE 'permanent_failure'::github_check_sync_status
            END,
            last_sync_error_class = $3,
            next_sync_after = CASE WHEN $4 THEN $5::timestamptz ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND sync_attempts = $2 AND sync_status = 'syncing'`,
    [
      input.checkRunId,
      input.attempt,
      input.errorClass,
      input.retryable,
      input.nextSyncAfter ?? null,
    ],
  );
  return result.rowCount === 1;
}

export type GithubCheckRetryReplayResult = {
  examined: number;
  published: number;
};

/**
 * Replays due, explicitly delayed Check syncs through the transactional
 * pg-boss outbox. A row stays due when a strict-FIFO singleton is still
 * active, so the next sweep cannot lose the retry during that race.
 */
export async function replayDueGithubCheckSyncs(
  pool: Pool,
  outbox: GithubCheckOutbox,
  rawInput: { limit?: number } = {},
): Promise<GithubCheckRetryReplayResult> {
  const input = z
    .object({ limit: z.number().int().min(1).max(100).default(25) })
    .strict()
    .parse(rawInput);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE check_runs
          SET sync_status = 'retry_required',
              last_sync_error_class = COALESCE(last_sync_error_class,
                                               'AbandonedSyncLease'),
              next_sync_after = COALESCE(next_sync_after, now()),
              updated_at = now()
        WHERE sync_status = 'syncing'
          AND updated_at < now() - interval '2 minutes'`,
    );
    const due = await client.query<DueGithubCheckSyncRow>(
      `SELECT check_run.id, check_run.revision_id,
              check_run.intent_idempotency_key,
              check_run.intent_reason, revision.head_sha
         FROM check_runs check_run
         JOIN pull_request_revisions revision
           ON revision.id = check_run.revision_id
        WHERE check_run.sync_status = 'retry_required'
          AND (
            check_run.next_sync_after IS NULL
            OR check_run.next_sync_after <= now()
          )
          AND check_run.intent_idempotency_key IS NOT NULL
          AND check_run.intent_reason IS NOT NULL
        ORDER BY COALESCE(check_run.next_sync_after,
                          check_run.sync_requested_at),
                 check_run.id
        LIMIT $1
        FOR UPDATE OF check_run SKIP LOCKED`,
      [input.limit],
    );
    let published = 0;
    for (const row of due.rows) {
      const queueJobId = await outbox.publish(client, {
        schemaVersion: "1",
        idempotencyKey: row.intent_idempotency_key,
        revisionId: row.revision_id,
        expectedHeadSha: row.head_sha,
        reason: row.intent_reason,
      });
      if (queueJobId === null) continue;
      const released = await client.query(
        `UPDATE check_runs
            SET next_sync_after = NULL,
                sync_requested_at = now(),
                updated_at = now()
          WHERE id = $1
            AND sync_status = 'retry_required'
            AND (next_sync_after IS NULL OR next_sync_after <= now())`,
        [row.id],
      );
      if (released.rowCount === 1) published += 1;
    }
    await client.query("COMMIT");
    return { examined: due.rowCount ?? due.rows.length, published };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type GithubOauthFlowRow = {
  id: string;
  purpose: GithubOauthFlow["purpose"];
  repository_id: string;
  redirect_path: string;
  expires_at: Date;
  consumed_at: Date | null;
};

type GithubRevisionSourceRow = {
  revision_id: string;
  head_sha: string;
  base_sha: string;
  source: unknown;
  source_hash: string;
  fetched_at: Date;
};

type ClaimedGithubCheckSyncRow = {
  id: string;
  sync_attempts: number;
  github_check_run_id: string | null;
  name: string;
  status: ClaimedGithubCheckSync["status"];
  conclusion: ClaimedGithubCheckSync["conclusion"];
  public_summary: string;
  details_url: string;
  intent_reason: ClaimedGithubCheckSync["intentReason"];
};

type DueGithubCheckSyncRow = {
  id: string;
  revision_id: string;
  intent_idempotency_key: string;
  intent_reason: z.infer<typeof CheckReasonSchema>;
  head_sha: string;
};

function mapOauthFlow(row: GithubOauthFlowRow): GithubOauthFlow {
  return {
    id: row.id,
    purpose: row.purpose,
    repositoryId: row.repository_id,
    redirectPath: row.redirect_path,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function mapClaimedCheck(
  row: ClaimedGithubCheckSyncRow,
): ClaimedGithubCheckSync {
  return {
    checkRunId: row.id,
    attempt: row.sync_attempts,
    githubCheckRunId: row.github_check_run_id,
    name: row.name,
    status: row.status,
    conclusion: row.conclusion,
    publicSummary: row.public_summary,
    detailsUrl: row.details_url,
    intentReason: row.intent_reason,
  };
}

function hashCheckIntent(
  input: z.output<typeof GithubCheckIntentSchema>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "slopproof-github-check-intent",
        1,
        input.revisionId,
        input.expectedHeadSha,
        input.reason,
        input.name,
        input.status,
        input.conclusion,
        input.publicSummary,
        input.detailsUrl,
      ]),
    )
    .digest("hex");
}
