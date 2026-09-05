import { createHash } from "node:crypto";
import type { AuthenticatedSession } from "@understandproof/auth";
import { scheduleJobInPgTransaction } from "@understandproof/db";
import {
  GitShaSchema,
  IdempotencyKeySchema,
  UuidSchema,
} from "@understandproof/domain";
import { TECHNICAL_RETRY_GITHUB_CHECK } from "@understandproof/github";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { z } from "zod";

export const TechnicalAbortReasonSchema = z.enum([
  "visibility_lost",
  "media_track_ended",
  "recorder_error",
  "duration_exceeded",
  "encryption_or_upload_failed",
  "user_cancelled",
]);

export const TechnicalAbortRequestSchema = z
  .object({
    expectedHeadSha: GitShaSchema,
    reason: TechnicalAbortReasonSchema,
  })
  .strict();

export const RetryAttemptRequestSchema = z
  .object({ expectedHeadSha: GitShaSchema })
  .strict();

export class AttemptLifecycleConflictError extends Error {
  readonly code = "ATTEMPT_LIFECYCLE_CONFLICT" as const;

  constructor() {
    super("The attempt no longer permits this lifecycle operation");
    this.name = "AttemptLifecycleConflictError";
  }
}

export interface MultipartAbortPort {
  abortMultipartUpload(objectKey: string, uploadId: string): Promise<void>;
}

export type CheckIntentWriterInput = {
  revisionId: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "action_required" | "success" | "cancelled" | null;
  summary: string;
  reason: "technical_retry" | "contributor_retry" | "maintainer_decision";
  idempotencyKey: string;
};

/** A DB/outbox writer only. Implementations must not perform remote calls. */
export interface CheckIntentWriter {
  write(client: PoolClient, input: CheckIntentWriterInput): Promise<void>;
}

export type AttemptLifecycleDependencies = {
  pool: Pool;
  queue: PgBoss;
  storage: MultipartAbortPort;
  checkIntents: CheckIntentWriter;
  clock?: { now(): Date };
};

type AttemptRow = {
  id: string;
  status: string;
  author_id: string;
  repository_id: string;
  revision_id: string;
  proof_plan_id: string;
  head_sha: string;
  is_current: boolean;
};

type UploadRow = {
  id: string;
  object_key: string;
  provider_upload_id: string;
  state: string;
};

const TECHNICALLY_ABORTABLE = ["preparing", "ready", "active", "uploading"];
const RETRYABLE = ["technical_retry", "retry_required", "expired"];

export async function abortAttemptForTechnicalRetry(
  dependencies: AttemptLifecycleDependencies,
  input: {
    attemptId: string;
    expectedHeadSha: string;
    reason: z.infer<typeof TechnicalAbortReasonSchema>;
    idempotencyKey: string;
    session: AuthenticatedSession;
  },
): Promise<{
  attemptId: string;
  status: "technical_retry" | "invalidated" | "already_progressed";
  replay: boolean;
}> {
  const command = {
    attemptId: UuidSchema.parse(input.attemptId),
    expectedHeadSha: GitShaSchema.parse(input.expectedHeadSha),
    reason: TechnicalAbortReasonSchema.parse(input.reason),
    idempotencyKey: IdempotencyKeySchema.parse(input.idempotencyKey),
  };
  if (input.session.actorRole !== "author" || !input.session.repositoryId) {
    throw new AttemptLifecycleConflictError();
  }

  const reserved = await reserveTechnicalAbort(
    dependencies.pool,
    command,
    input.session,
  );
  if (reserved.alreadyProgressed) {
    return {
      attemptId: command.attemptId,
      status: "already_progressed",
      replay: true,
    };
  }
  if (reserved.replay) {
    return {
      attemptId: command.attemptId,
      status: "technical_retry",
      replay: true,
    };
  }
  if (reserved.upload) {
    await abortMultipartIdempotently(
      dependencies.storage,
      reserved.upload.object_key,
      reserved.upload.provider_upload_id,
    );
  }

  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const attempt = await lockAttempt(client, command.attemptId);
    if (!attempt || !isAuthorized(attempt, input.session)) {
      throw new AttemptLifecycleConflictError();
    }
    const upload = await lockUpload(client, command.attemptId);
    if (attempt.status === "technical_retry") {
      await client.query("COMMIT");
      return {
        attemptId: attempt.id,
        status: "technical_retry",
        replay: true,
      };
    }

    if (!attempt.is_current || attempt.head_sha !== command.expectedHeadSha) {
      if (TECHNICALLY_ABORTABLE.includes(attempt.status)) {
        await client.query(
          `INSERT INTO attempt_transitions
            (attempt_id, idempotency_key, from_status, to_status,
             expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
           VALUES ($1, $2, $3, 'invalidated', $4, $5, 'system', 'system', now())
           ON CONFLICT (attempt_id, idempotency_key) DO NOTHING`,
          [
            attempt.id,
            `${command.idempotencyKey}:stale`,
            attempt.status,
            command.expectedHeadSha,
            attempt.head_sha,
          ],
        );
        await client.query(
          `UPDATE attempts
           SET status = 'invalidated', invalidated_at = now(),
               completed_at = now(), updated_at = now()
           WHERE id = $1`,
          [attempt.id],
        );
      }
      await destroyIncompleteEvidence(client, attempt.id, upload);
      await writeAudit(client, {
        actorId: input.session.actorId,
        action: "attempt.technical_abort_stale_cleanup",
        attemptId: attempt.id,
        metadata: {
          reason: command.reason,
          expectedHeadSha: command.expectedHeadSha,
        },
      });
      await client.query("COMMIT");
      return { attemptId: attempt.id, status: "invalidated", replay: false };
    }
    if (!TECHNICALLY_ABORTABLE.includes(attempt.status)) {
      throw new AttemptLifecycleConflictError();
    }

    await client.query(
      `INSERT INTO attempt_transitions
        (attempt_id, idempotency_key, from_status, to_status,
         expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
       VALUES ($1, $2, $3, 'technical_retry', $4, $4, $5, 'author', now())
       ON CONFLICT (attempt_id, idempotency_key) DO NOTHING`,
      [
        attempt.id,
        command.idempotencyKey,
        attempt.status,
        attempt.head_sha,
        input.session.actorId,
      ],
    );
    await client.query(
      `UPDATE attempts
       SET status = 'technical_retry', completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [attempt.id],
    );
    await destroyIncompleteEvidence(client, attempt.id, upload);
    await writeAudit(client, {
      actorId: input.session.actorId,
      action: "attempt.technical_retry",
      attemptId: attempt.id,
      metadata: {
        reason: command.reason,
        headSha: attempt.head_sha,
        multipartAborted: upload !== undefined,
      },
    });
    await dependencies.checkIntents.write(client, {
      revisionId: attempt.revision_id,
      headSha: attempt.head_sha,
      ...TECHNICAL_RETRY_GITHUB_CHECK,
      summary: `technical retry required for head ${attempt.head_sha}`,
      reason: "technical_retry",
      idempotencyKey: command.idempotencyKey,
    });
    await client.query("COMMIT");
    return {
      attemptId: attempt.id,
      status: "technical_retry",
      replay: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createReplacementAttempt(
  dependencies: AttemptLifecycleDependencies,
  input: {
    sourceAttemptId: string;
    expectedHeadSha: string;
    idempotencyKey: string;
    session: AuthenticatedSession;
  },
): Promise<{
  sourceAttemptId: string;
  attemptId: string;
  revisionId: string;
  headSha: string;
  status: "ready";
  expiresAt: Date;
  replay: boolean;
}> {
  const sourceAttemptId = UuidSchema.parse(input.sourceAttemptId);
  const expectedHeadSha = GitShaSchema.parse(input.expectedHeadSha);
  const idempotencyKey = IdempotencyKeySchema.parse(input.idempotencyKey);
  if (input.session.actorRole !== "author" || !input.session.repositoryId) {
    throw new AttemptLifecycleConflictError();
  }
  const now = dependencies.clock?.now() ?? new Date();
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const source = await lockAttempt(client, sourceAttemptId);
    if (
      !source ||
      !isAuthorized(source, input.session) ||
      !source.is_current ||
      source.head_sha !== expectedHeadSha ||
      !RETRYABLE.includes(source.status)
    ) {
      throw new AttemptLifecycleConflictError();
    }
    const active = await client.query<{
      id: string;
      expires_at: Date;
      head_sha: string;
      revision_id: string;
    }>(
      `SELECT id, expires_at, head_sha, revision_id
       FROM attempts
       WHERE revision_id = $1 AND author_id = $2
         AND status IN ('preparing','ready','active','uploading','processing','review_required')
       ORDER BY created_at DESC LIMIT 1`,
      [source.revision_id, source.author_id],
    );
    const existing = active.rows[0];
    if (existing) {
      await client.query("COMMIT");
      return {
        sourceAttemptId,
        attemptId: existing.id,
        revisionId: existing.revision_id,
        headSha: existing.head_sha,
        status: "ready",
        expiresAt: existing.expires_at,
        replay: true,
      };
    }

    const attemptId = deterministicUuid(
      `replacement:${sourceAttemptId}:${idempotencyKey}:${expectedHeadSha}`,
    );
    const expiresAt = new Date(now.getTime() + 8 * 60 * 60_000);
    const inserted = await client.query(
      `INSERT INTO attempts
        (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
         status, nonce_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        attemptId,
        source.repository_id,
        source.revision_id,
        source.author_id,
        source.proof_plan_id,
        source.head_sha,
        sha256(`attempt-nonce:${attemptId}`),
        expiresAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      const replay = await client.query<{
        expires_at: Date;
        status: string;
        head_sha: string;
      }>("SELECT expires_at, status, head_sha FROM attempts WHERE id = $1", [
        attemptId,
      ]);
      if (
        replay.rows[0]?.status !== "ready" ||
        replay.rows[0].head_sha !== source.head_sha
      ) {
        throw new AttemptLifecycleConflictError();
      }
      await client.query("COMMIT");
      return {
        sourceAttemptId,
        attemptId,
        revisionId: source.revision_id,
        headSha: source.head_sha,
        status: "ready",
        expiresAt: replay.rows[0].expires_at,
        replay: true,
      };
    }

    await scheduleJobInPgTransaction(
      dependencies.queue,
      client,
      "proof.expire-attempt",
      {
        schemaVersion: "1",
        idempotencyKey: `attempt-expiry:${attemptId}:${source.head_sha}`,
        attemptId,
        expectedHeadSha: source.head_sha,
      },
      expiresAt,
    );
    await writeAudit(client, {
      actorId: input.session.actorId,
      action: "attempt.retry_created",
      attemptId,
      metadata: {
        sourceAttemptId,
        revisionId: source.revision_id,
        headSha: source.head_sha,
      },
    });
    await dependencies.checkIntents.write(client, {
      revisionId: source.revision_id,
      headSha: source.head_sha,
      status: "in_progress",
      conclusion: null,
      summary: `proof ready for head ${source.head_sha}`,
      reason: "contributor_retry",
      idempotencyKey,
    });
    await client.query("COMMIT");
    return {
      sourceAttemptId,
      attemptId,
      revisionId: source.revision_id,
      headSha: source.head_sha,
      status: "ready",
      expiresAt,
      replay: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function reserveTechnicalAbort(
  pool: Pool,
  input: {
    attemptId: string;
    expectedHeadSha: string;
    reason: z.infer<typeof TechnicalAbortReasonSchema>;
    idempotencyKey: string;
  },
  session: AuthenticatedSession,
): Promise<{
  replay: boolean;
  alreadyProgressed?: boolean;
  upload?: UploadRow;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attempt = await lockAttempt(client, input.attemptId);
    if (
      !attempt ||
      !isAuthorized(attempt, session) ||
      attempt.head_sha !== input.expectedHeadSha
    ) {
      throw new AttemptLifecycleConflictError();
    }
    const replay = await client.query<{ to_status: string }>(
      `SELECT to_status FROM attempt_transitions
       WHERE attempt_id = $1 AND idempotency_key = $2`,
      [attempt.id, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (
        replay.rows[0].to_status !== "technical_retry" ||
        attempt.status !== "technical_retry"
      ) {
        throw new AttemptLifecycleConflictError();
      }
      await client.query("COMMIT");
      return { replay: true };
    }
    if (attempt.status === "technical_retry") {
      await client.query("COMMIT");
      return { replay: true };
    }
    if (["processing", "review_required", "passed"].includes(attempt.status)) {
      await client.query("COMMIT");
      return { replay: false, alreadyProgressed: true };
    }
    if (
      !attempt.is_current ||
      !TECHNICALLY_ABORTABLE.includes(attempt.status)
    ) {
      throw new AttemptLifecycleConflictError();
    }
    const upload = await lockUpload(client, attempt.id);
    if (upload && !["active", "aborting"].includes(upload.state)) {
      throw new AttemptLifecycleConflictError();
    }
    if (upload?.state === "active") {
      await client.query(
        `UPDATE upload_sessions SET state = 'aborting', updated_at = now()
         WHERE id = $1`,
        [upload.id],
      );
    }
    await client.query("COMMIT");
    return upload ? { replay: false, upload } : { replay: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<AttemptRow | undefined> {
  const result = await client.query<AttemptRow>(
    `SELECT attempt.id, attempt.status, attempt.author_id,
            attempt.repository_id, attempt.revision_id, attempt.proof_plan_id,
            attempt.head_sha, revision.is_current
     FROM attempts attempt
     JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
     WHERE attempt.id = $1
     FOR UPDATE OF attempt, revision`,
    [attemptId],
  );
  return result.rows[0];
}

async function lockUpload(
  client: PoolClient,
  attemptId: string,
): Promise<UploadRow | undefined> {
  const result = await client.query<UploadRow>(
    `SELECT id, object_key, provider_upload_id, state
     FROM upload_sessions WHERE attempt_id = $1 FOR UPDATE`,
    [attemptId],
  );
  return result.rows[0];
}

function isAuthorized(
  attempt: AttemptRow,
  session: AuthenticatedSession,
): boolean {
  return (
    session.actorRole === "author" &&
    session.actorId === attempt.author_id &&
    session.repositoryId === attempt.repository_id
  );
}

async function destroyIncompleteEvidence(
  client: PoolClient,
  attemptId: string,
  upload: UploadRow | undefined,
): Promise<void> {
  if (upload) {
    await client.query(
      `UPDATE upload_sessions SET state = 'failed', updated_at = now()
       WHERE id = $1`,
      [upload.id],
    );
  }
  await client.query(
    `UPDATE wrapping_materials
     SET destroyed_at = COALESCE(destroyed_at, now())
     WHERE attempt_id = $1 AND destroyed_at IS NULL`,
    [attemptId],
  );
}

async function writeAudit(
  client: PoolClient,
  input: {
    actorId: string;
    action: string;
    attemptId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (actor_id, action, object_type, object_id, metadata)
     VALUES ($1, $2, 'attempt', $3, $4::jsonb)`,
    [
      input.actorId,
      input.action,
      input.attemptId,
      JSON.stringify(input.metadata),
    ],
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function abortMultipartIdempotently(
  storage: MultipartAbortPort,
  objectKey: string,
  uploadId: string,
): Promise<void> {
  try {
    await storage.abortMultipartUpload(objectKey, uploadId);
  } catch (error) {
    if (!isMissingMultipartUpload(error)) throw error;
  }
}

function isMissingMultipartUpload(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as {
      name?: unknown;
      cause?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    if (
      record.name === "NoSuchUpload" ||
      record.$metadata?.httpStatusCode === 404
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
