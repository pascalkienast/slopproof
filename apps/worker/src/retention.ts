import {
  EvidenceAuditRetentionJobSchema,
  EvidenceDeleteJobSchema,
  type DatabaseConnection,
  type JobPayload,
} from "@slopproof/db";
import { type Db as PgBossDatabase, type PgBoss } from "pg-boss";

const DEFAULT_SWEEP_LIMIT = 100;
const DEFAULT_STALE_CLAIM_MS = 60 * 60_000;
const DEFAULT_ORPHAN_MULTIPART_AGE_MS = 24 * 60 * 60_000;

export type RetentionClock = {
  now(): Date;
};

export type EvidenceDeletionStorage = {
  abortMultipartUpload(objectKey: string, uploadId: string): Promise<void>;
  deleteObject(objectKey: string): Promise<void>;
  abortIncompleteMultipartUploadsOlderThan?(cutoff: Date): Promise<number>;
};

export type MultipartDeletionTarget = {
  objectKey: string;
  uploadId: string;
};

export type EvidenceDeletionPlan = {
  deletionJobId: string;
  attemptId: string;
  objectKeys: readonly string[];
  multipartUploads: readonly MultipartDeletionTarget[];
};

export type RetentionPersistence = {
  enqueueDueDeletions(input: {
    now: Date;
    staleBefore: Date;
    limit: number;
  }): Promise<readonly string[]>;
  claimDeletion(
    deletionJobId: string,
    now: Date,
  ): Promise<EvidenceDeletionPlan | null>;
  completeDeletion(plan: EvidenceDeletionPlan, now: Date): Promise<void>;
  failDeletion(
    plan: EvidenceDeletionPlan,
    errorClass: string,
    now: Date,
  ): Promise<void>;
};

export type RetentionServiceDependencies = {
  persistence: RetentionPersistence;
  storage: EvidenceDeletionStorage;
  clock?: RetentionClock;
  staleClaimMs?: number;
  orphanMultipartAgeMs?: number;
};

export type PostgresRetentionDependencies = {
  database: DatabaseConnection;
  queue: PgBoss;
  storage: EvidenceDeletionStorage;
  clock?: RetentionClock;
  staleClaimMs?: number;
  orphanMultipartAgeMs?: number;
};

export class RetentionRetryableError extends Error {
  readonly code = "RETENTION_RETRYABLE" as const;

  constructor(
    readonly errorClass: string,
    options?: ErrorOptions,
  ) {
    super(`Evidence deletion failed with ${errorClass}`, options);
    this.name = "RetentionRetryableError";
  }
}

export class RetentionContractError extends Error {
  readonly code = "RETENTION_CONTRACT_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "RetentionContractError";
  }
}

const systemClock: RetentionClock = {
  now: () => new Date(),
};

export function createRetentionService(
  dependencies: RetentionServiceDependencies,
): {
  sweep(limit?: number): Promise<readonly string[]>;
  deleteEvidence(job: JobPayload<"evidence.delete">): Promise<void>;
  auditRetention(
    job: JobPayload<"evidence.audit-retention">,
  ): Promise<readonly string[]>;
} {
  const clock = dependencies.clock ?? systemClock;
  const staleClaimMs = dependencies.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const orphanMultipartAgeMs =
    dependencies.orphanMultipartAgeMs ?? DEFAULT_ORPHAN_MULTIPART_AGE_MS;
  if (!Number.isSafeInteger(staleClaimMs) || staleClaimMs < 1) {
    throw new RetentionContractError("staleClaimMs must be a positive integer");
  }
  if (!Number.isSafeInteger(orphanMultipartAgeMs) || orphanMultipartAgeMs < 1) {
    throw new RetentionContractError(
      "orphanMultipartAgeMs must be a positive integer",
    );
  }

  return {
    sweep: (limit = DEFAULT_SWEEP_LIMIT) =>
      sweepOverdueEvidence(
        dependencies.persistence,
        clock,
        limit,
        staleClaimMs,
      ),
    deleteEvidence: (job) =>
      deleteEvidenceJob(job, {
        persistence: dependencies.persistence,
        storage: dependencies.storage,
        clock,
      }),
    auditRetention: async (job) => {
      EvidenceAuditRetentionJobSchema.parse(job);
      const now = copyDate(clock.now());
      const orphanSweep =
        dependencies.storage.abortIncompleteMultipartUploadsOlderThan?.(
          new Date(now.getTime() - orphanMultipartAgeMs),
        ) ?? Promise.resolve(0);
      const dueDeletions = dependencies.persistence.enqueueDueDeletions({
        now,
        staleBefore: new Date(now.getTime() - staleClaimMs),
        limit: DEFAULT_SWEEP_LIMIT,
      });
      const [, queued] = await Promise.all([orphanSweep, dueDeletions]);
      return queued;
    },
  };
}

export function createPostgresRetentionService(
  dependencies: PostgresRetentionDependencies,
): ReturnType<typeof createRetentionService> {
  return createRetentionService({
    persistence: new PostgresRetentionPersistence(
      dependencies.database,
      dependencies.queue,
    ),
    storage: dependencies.storage,
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    ...(dependencies.staleClaimMs !== undefined
      ? { staleClaimMs: dependencies.staleClaimMs }
      : {}),
    ...(dependencies.orphanMultipartAgeMs !== undefined
      ? { orphanMultipartAgeMs: dependencies.orphanMultipartAgeMs }
      : {}),
  });
}

export async function sweepOverdueEvidence(
  persistence: RetentionPersistence,
  clock: RetentionClock = systemClock,
  limit = DEFAULT_SWEEP_LIMIT,
  staleClaimMs = DEFAULT_STALE_CLAIM_MS,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RetentionContractError(
      "Retention sweep limit must be between 1 and 1000",
    );
  }
  if (!Number.isSafeInteger(staleClaimMs) || staleClaimMs < 1) {
    throw new RetentionContractError("staleClaimMs must be a positive integer");
  }
  const now = copyDate(clock.now());
  return persistence.enqueueDueDeletions({
    now,
    staleBefore: new Date(now.getTime() - staleClaimMs),
    limit,
  });
}

export async function deleteEvidenceJob(
  rawJob: JobPayload<"evidence.delete">,
  dependencies: {
    persistence: RetentionPersistence;
    storage: EvidenceDeletionStorage;
    clock?: RetentionClock;
  },
): Promise<void> {
  const job = EvidenceDeleteJobSchema.parse(rawJob);
  const clock = dependencies.clock ?? systemClock;
  const plan = await dependencies.persistence.claimDeletion(
    job.deletionJobId,
    copyDate(clock.now()),
  );
  if (plan === null) return;

  try {
    for (const upload of uniqueMultipartTargets(plan.multipartUploads)) {
      try {
        await dependencies.storage.abortMultipartUpload(
          upload.objectKey,
          upload.uploadId,
        );
      } catch (error) {
        if (!isMissingStorageTarget(error)) throw error;
      }
    }

    for (const objectKey of new Set(plan.objectKeys)) {
      try {
        await dependencies.storage.deleteObject(objectKey);
      } catch (error) {
        if (!isMissingStorageTarget(error)) throw error;
      }
    }

    await dependencies.persistence.completeDeletion(
      plan,
      copyDate(clock.now()),
    );
  } catch (error) {
    const errorClass = classifyError(error);
    try {
      await dependencies.persistence.failDeletion(
        plan,
        errorClass,
        copyDate(clock.now()),
      );
    } catch (persistenceError) {
      throw new RetentionRetryableError(classifyError(persistenceError), {
        cause: persistenceError,
      });
    }
    throw new RetentionRetryableError(errorClass, { cause: error });
  }
}

/** PostgreSQL implementation using the existing schema and pg-boss transaction adapter. */
export class PostgresRetentionPersistence implements RetentionPersistence {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly queue: PgBoss,
  ) {}

  async enqueueDueDeletions(input: {
    now: Date;
    staleBefore: Date;
    limit: number;
  }): Promise<readonly string[]> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `WITH evidence_deadlines AS (
           SELECT id AS attempt_id, evidence_delete_after AS deadline
           FROM attempts
           WHERE evidence_delete_after IS NOT NULL
           UNION ALL
           SELECT upload.attempt_id, max(upload.expires_at) AS deadline
           FROM upload_sessions upload
           JOIN attempts attempt ON attempt.id = upload.attempt_id
           WHERE attempt.evidence_delete_after IS NULL
             AND upload.state <> 'deleted'
           GROUP BY upload.attempt_id
           UNION ALL
           SELECT material.attempt_id, max(material.usable_until) AS deadline
           FROM wrapping_materials material
           JOIN attempts attempt ON attempt.id = material.attempt_id
           WHERE attempt.evidence_delete_after IS NULL
             AND material.destroyed_at IS NULL
           GROUP BY material.attempt_id
         ), due_attempts AS (
           SELECT attempt_id, max(deadline) AS deadline
           FROM evidence_deadlines
           GROUP BY attempt_id
           HAVING max(deadline) <= $1
         )
         INSERT INTO deletion_jobs (object_class, object_id, deadline)
         SELECT 'attempt_evidence', attempt_id::text, deadline FROM due_attempts
         ON CONFLICT (object_class, object_id) DO UPDATE
         SET deadline = GREATEST(deletion_jobs.deadline, EXCLUDED.deadline)`,
        [input.now],
      );
      const result = await client.query<{
        id: string;
        attempts: number;
      }>(
        `SELECT id, attempts
         FROM deletion_jobs
         WHERE object_class = 'attempt_evidence'
           AND deadline <= $1
           AND (
             state = 'pending'
             OR (state IN ('running', 'failed') AND updated_at <= $2)
           )
         ORDER BY deadline, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [input.now, input.staleBefore, input.limit],
      );

      const queueDatabase: PgBossDatabase = {
        async executeSql(text, values = []) {
          const queryResult = await client.query(text, values);
          return { rows: queryResult.rows };
        },
      };
      for (const row of result.rows) {
        const generation = `${String(row.attempts)}:${String(input.now.getTime())}`;
        await client.query(
          `UPDATE deletion_jobs
           SET state = 'running', updated_at = $2
           WHERE id = $1`,
          [row.id, input.now],
        );
        const payload = EvidenceDeleteJobSchema.parse({
          schemaVersion: "1",
          idempotencyKey: `evidence-delete:${row.id}:${generation}`,
          deletionJobId: row.id,
        });
        const queueJobId = await this.queue.send("evidence.delete", payload, {
          // A terminal pg-boss `failed` row keeps its strict-FIFO singleton key.
          // A new lease timestamp creates a queue generation even if a job
          // expired before its handler advanced the business attempt count.
          // Physical deletion and completion are independently idempotent.
          singletonKey: `${row.id}:${generation}`,
          db: queueDatabase,
        });
        if (queueJobId === null) {
          throw new Error("pg-boss rejected the evidence deletion job");
        }
      }
      await client.query("COMMIT");
      return result.rows.map((row) => row.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDeletion(
    deletionJobId: string,
    now: Date,
  ): Promise<EvidenceDeletionPlan | null> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const deletion = await client.query<{
        id: string;
        object_class: string;
        object_id: string;
        deadline: Date;
        state: string;
      }>(
        `SELECT id, object_class, object_id, deadline, state
         FROM deletion_jobs WHERE id = $1 FOR UPDATE`,
        [deletionJobId],
      );
      const row = deletion.rows[0];
      if (!row || row.state === "completed") {
        await client.query("COMMIT");
        return null;
      }
      if (row.object_class !== "attempt_evidence") {
        throw new RetentionContractError(
          "Unsupported deletion-job object class",
        );
      }
      if (row.deadline.getTime() > now.getTime()) {
        await client.query(
          `UPDATE deletion_jobs SET state = 'pending', updated_at = $2 WHERE id = $1`,
          [row.id, now],
        );
        await client.query("COMMIT");
        return null;
      }

      await client.query(
        `UPDATE deletion_jobs
         SET state = 'running', attempts = attempts + 1, updated_at = $2
         WHERE id = $1`,
        [row.id, now],
      );
      const objects = await client.query<{ object_key: string }>(
        `SELECT object_key FROM recording_objects
         WHERE attempt_id = $1 AND deleted_at IS NULL
         UNION
         SELECT object_key FROM frame_selections
         WHERE attempt_id = $1 AND deleted_at IS NULL
         UNION
         SELECT object_key FROM upload_sessions
         WHERE attempt_id = $1 AND state <> 'deleted'`,
        [row.object_id],
      );
      const uploads = await client.query<{
        object_key: string;
        provider_upload_id: string;
      }>(
        `SELECT object_key, provider_upload_id
         FROM upload_sessions
         WHERE attempt_id = $1
           AND state NOT IN ('completed', 'deleted')`,
        [row.object_id],
      );
      await client.query("COMMIT");
      return {
        deletionJobId: row.id,
        attemptId: row.object_id,
        objectKeys: objects.rows.map((object) => object.object_key),
        multipartUploads: uploads.rows.map((upload) => ({
          objectKey: upload.object_key,
          uploadId: upload.provider_upload_id,
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeDeletion(plan: EvidenceDeletionPlan, now: Date): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const deletion = await client.query<{ object_id: string; state: string }>(
        `SELECT object_id, state FROM deletion_jobs WHERE id = $1 FOR UPDATE`,
        [plan.deletionJobId],
      );
      const row = deletion.rows[0];
      if (!row || row.state === "completed") {
        await client.query("COMMIT");
        return;
      }
      if (row.object_id !== plan.attemptId) {
        throw new RetentionContractError(
          "Deletion plan no longer matches its job",
        );
      }

      await client.query(
        `UPDATE recording_objects
         SET object_key = 'deleted/' || id::text,
             wrapped_data_key = '',
             wrapped_key_sha256 = 'deleted:' || id::text,
             deleted_at = COALESCE(deleted_at, $2)
         WHERE attempt_id = $1 AND deleted_at IS NULL`,
        [plan.attemptId, now],
      );
      await client.query(
        `UPDATE transcripts
         SET provider = 'deleted', schema_version = 'deleted',
             encrypted_payload = '', deleted_at = COALESCE(deleted_at, $2)
         WHERE attempt_id = $1 AND deleted_at IS NULL`,
        [plan.attemptId, now],
      );
      await client.query(
        `UPDATE frame_selections
         SET timestamp_ms = 0, reason_code = 'deleted',
             object_key = 'deleted/' || id::text,
             deleted_at = COALESCE(deleted_at, $2)
         WHERE attempt_id = $1 AND deleted_at IS NULL`,
        [plan.attemptId, now],
      );
      await client.query(
        `UPDATE evaluations
         SET provider = 'deleted:' || id::text, model = 'deleted',
             prompt_version = 'deleted', schema_version = 'deleted',
             rubric_version = 'deleted', encrypted_payload = '',
             recommendation = 'deleted', deleted_at = COALESCE(deleted_at, $2)
         WHERE attempt_id = $1 AND deleted_at IS NULL`,
        [plan.attemptId, now],
      );
      await client.query(
        `DELETE FROM recording_parts
         WHERE upload_session_id IN (
           SELECT id FROM upload_sessions WHERE attempt_id = $1
         )`,
        [plan.attemptId],
      );
      await client.query(
        `UPDATE upload_sessions
         SET object_key = 'deleted/' || id::text,
             provider_upload_id = 'deleted:' || id::text,
             state = 'deleted', next_part_number = 1,
             manifest_digest = NULL, finalize_envelope = NULL,
             updated_at = $2
         WHERE attempt_id = $1 AND state <> 'deleted'`,
        [plan.attemptId, now],
      );
      await client.query(
        `UPDATE wrapping_materials
         SET key_id = 'destroyed:' || id::text,
             algorithm = 'destroyed', spki_sha256 = 'destroyed:' || id::text,
             usable_until = LEAST(usable_until, $2),
             destroyed_at = COALESCE(destroyed_at, $2)
         WHERE attempt_id = $1 AND destroyed_at IS NULL`,
        [plan.attemptId, now],
      );
      await client.query(
        `UPDATE deletion_jobs
         SET state = 'completed', last_error_class = NULL,
             completed_at = $2, updated_at = $2
         WHERE id = $1`,
        [plan.deletionJobId, now],
      );
      await client.query(
        `INSERT INTO audit_events
           (actor_id, action, object_type, object_id, metadata, occurred_at)
         VALUES ('worker', 'evidence.deleted', 'attempt', $1,
                 jsonb_build_object('deletionJobId', $2::text), $3)`,
        [plan.attemptId, plan.deletionJobId, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failDeletion(
    plan: EvidenceDeletionPlan,
    errorClass: string,
    now: Date,
  ): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE deletion_jobs
         SET state = 'failed', last_error_class = $2, updated_at = $3
         WHERE id = $1 AND state <> 'completed'`,
        [plan.deletionJobId, errorClass, now],
      );
      if (updated.rowCount === 1) {
        await client.query(
          `INSERT INTO audit_events
             (actor_id, action, object_type, object_id, metadata, occurred_at)
           VALUES ('worker', 'evidence.deletion_failed', 'attempt', $1,
                   jsonb_build_object(
                     'deletionJobId', $2::text,
                     'errorClass', $3::text
                   ), $4)`,
          [plan.attemptId, plan.deletionJobId, errorClass, now],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function uniqueMultipartTargets(
  targets: readonly MultipartDeletionTarget[],
): readonly MultipartDeletionTarget[] {
  const unique = new Map<string, MultipartDeletionTarget>();
  for (const target of targets) {
    unique.set(`${target.objectKey}\0${target.uploadId}`, target);
  }
  return [...unique.values()];
}

function copyDate(date: Date): Date {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RetentionContractError(
      "Retention clock returned an invalid date",
    );
  }
  return new Date(date.getTime());
}

function classifyError(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(candidate)
    ? candidate
    : "UnknownError";
}

function isMissingStorageTarget(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const record = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    if (
      record.name === "NoSuchKey" ||
      record.name === "NoSuchUpload" ||
      record.name === "NotFound" ||
      record.code === "NoSuchKey" ||
      record.code === "NoSuchUpload" ||
      record.$metadata?.httpStatusCode === 404
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
