import {
  getJobSingletonKey,
  parseJobPayload,
  type JobPayload,
} from "@slopproof/db";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { CheckIntentWriter } from "./revision-preparation";

const EXPIRABLE_STATUSES = ["preparing", "ready", "active", "uploading"];

export interface ExpiryMultipartAbortPort {
  abortMultipartUpload(objectKey: string, uploadId: string): Promise<void>;
}

export type AttemptExpiryDependencies = {
  pool: Pool;
  storage: ExpiryMultipartAbortPort;
  checkIntents: CheckIntentWriter;
  clock?: { now(): Date };
};

type ExpiryAttemptRow = {
  id: string;
  status: string;
  revision_id: string;
  head_sha: string;
  is_current: boolean;
  expires_at: Date;
};

type ExpiryUploadRow = {
  id: string;
  object_key: string;
  provider_upload_id: string;
  state: string;
};

export async function expireAttempt(
  rawPayload: JobPayload<"proof.expire-attempt">,
  dependencies: AttemptExpiryDependencies,
): Promise<{ outcome: "expired" | "replayed" | "stale" }> {
  const payload = parseJobPayload("proof.expire-attempt", rawPayload);
  const now = dependencies.clock?.now() ?? new Date();
  const reserved = await reserveExpiry(dependencies.pool, payload, now);
  if (reserved.outcome) return { outcome: reserved.outcome };
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
    const attempt = await lockAttempt(client, payload.attemptId);
    if (!attempt || attempt.head_sha !== payload.expectedHeadSha) {
      await client.query("ROLLBACK");
      return { outcome: "stale" };
    }
    const upload = await lockUpload(client, attempt.id);
    if (attempt.status === "expired") {
      await client.query("COMMIT");
      return { outcome: "replayed" };
    }
    if (attempt.status === "invalidated" || !attempt.is_current) {
      await destroyIncompleteEvidence(client, attempt.id, upload);
      await writeAuditOnce(client, {
        action: "attempt.expiry_stale_cleanup",
        attemptId: attempt.id,
        metadata: { headSha: attempt.head_sha },
      });
      await client.query("COMMIT");
      return { outcome: "stale" };
    }
    if (
      !EXPIRABLE_STATUSES.includes(attempt.status) ||
      attempt.expires_at > now
    ) {
      await client.query("ROLLBACK");
      return { outcome: "stale" };
    }

    await client.query(
      `INSERT INTO attempt_transitions
        (attempt_id, idempotency_key, from_status, to_status,
         expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
       VALUES ($1, $2, $3, 'expired', $4, $4, 'expiry-worker', 'system', $5)
       ON CONFLICT (attempt_id, idempotency_key) DO NOTHING`,
      [
        attempt.id,
        payload.idempotencyKey,
        attempt.status,
        attempt.head_sha,
        now,
      ],
    );
    await client.query(
      `UPDATE attempts
       SET status = 'expired', completed_at = $2, updated_at = $2
       WHERE id = $1`,
      [attempt.id, now],
    );
    await destroyIncompleteEvidence(client, attempt.id, upload);
    await writeAuditOnce(client, {
      action: "attempt.expired",
      attemptId: attempt.id,
      metadata: {
        headSha: attempt.head_sha,
        multipartAborted: upload !== undefined,
      },
    });
    await dependencies.checkIntents.write(client, {
      revisionId: attempt.revision_id,
      headSha: attempt.head_sha,
      status: "completed",
      conclusion: "neutral",
      summary: `proof attempt expired for head ${attempt.head_sha}`,
      reason: "attempt_expired",
      idempotencyKey: payload.idempotencyKey,
    });
    await client.query("COMMIT");
    return { outcome: "expired" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function scheduleOutstandingAttemptExpirations(
  pool: Pool,
  queue: PgBoss,
  clock: { now(): Date } = { now: () => new Date() },
): Promise<number> {
  const attempts = await pool.query<{
    id: string;
    head_sha: string;
    expires_at: Date;
  }>(
    `SELECT attempt.id, attempt.head_sha, attempt.expires_at
     FROM attempts attempt
     JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
     WHERE revision.is_current = true
       AND attempt.status IN ('preparing','ready','active','uploading')
     ORDER BY attempt.expires_at
     LIMIT 1000`,
  );
  let scheduled = 0;
  for (const attempt of attempts.rows) {
    const payload = parseJobPayload("proof.expire-attempt", {
      schemaVersion: "1",
      idempotencyKey: `attempt-expiry:${attempt.id}:${attempt.head_sha}`,
      attemptId: attempt.id,
      expectedHeadSha: attempt.head_sha,
    });
    const result = await queue.upsert("proof.expire-attempt", payload, {
      singletonKey: getJobSingletonKey("proof.expire-attempt", payload),
      match: "oldest",
      startAfter:
        attempt.expires_at > clock.now() ? attempt.expires_at : clock.now(),
    });
    if (result.jobs.length > 0) scheduled += 1;
  }
  return scheduled;
}

async function reserveExpiry(
  pool: Pool,
  payload: JobPayload<"proof.expire-attempt">,
  now: Date,
): Promise<{
  outcome?: "replayed" | "stale";
  upload?: ExpiryUploadRow;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attempt = await lockAttempt(client, payload.attemptId);
    if (!attempt || attempt.head_sha !== payload.expectedHeadSha) {
      await client.query("COMMIT");
      return { outcome: "stale" };
    }
    if (attempt.status === "expired") {
      await client.query("COMMIT");
      return { outcome: "replayed" };
    }
    if (attempt.status === "invalidated" || !attempt.is_current) {
      const upload = await lockUpload(client, attempt.id);
      if (upload && !["active", "aborting"].includes(upload.state)) {
        await client.query("COMMIT");
        return {};
      }
      if (upload?.state === "active") {
        await client.query(
          `UPDATE upload_sessions SET state = 'aborting', updated_at = $2
           WHERE id = $1`,
          [upload.id, now],
        );
      }
      await client.query("COMMIT");
      return upload ? { upload } : {};
    }
    if (
      !EXPIRABLE_STATUSES.includes(attempt.status) ||
      attempt.expires_at > now
    ) {
      await client.query("COMMIT");
      return { outcome: "stale" };
    }
    const upload = await lockUpload(client, attempt.id);
    if (upload && !["active", "aborting"].includes(upload.state)) {
      await client.query("COMMIT");
      return { outcome: "stale" };
    }
    if (upload?.state === "active") {
      await client.query(
        `UPDATE upload_sessions SET state = 'aborting', updated_at = $2
         WHERE id = $1`,
        [upload.id, now],
      );
    }
    await client.query("COMMIT");
    return upload ? { upload } : {};
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
): Promise<ExpiryAttemptRow | undefined> {
  const result = await client.query<ExpiryAttemptRow>(
    `SELECT attempt.id, attempt.status, attempt.revision_id,
            attempt.head_sha, attempt.expires_at, revision.is_current
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
): Promise<ExpiryUploadRow | undefined> {
  const result = await client.query<ExpiryUploadRow>(
    `SELECT id, object_key, provider_upload_id, state
     FROM upload_sessions WHERE attempt_id = $1 FOR UPDATE`,
    [attemptId],
  );
  return result.rows[0];
}

async function destroyIncompleteEvidence(
  client: PoolClient,
  attemptId: string,
  upload: ExpiryUploadRow | undefined,
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

async function writeAuditOnce(
  client: PoolClient,
  input: {
    action: string;
    attemptId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (actor_id, action, object_type, object_id, metadata)
     SELECT 'expiry-worker', $1, 'attempt', $2, $3::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_events
       WHERE action = $1 AND object_type = 'attempt' AND object_id = $2
     )`,
    [input.action, input.attemptId, JSON.stringify(input.metadata)],
  );
}

async function abortMultipartIdempotently(
  storage: ExpiryMultipartAbortPort,
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
