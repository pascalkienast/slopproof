import { createHmac, randomUUID } from "node:crypto";
import type { AuthenticatedSession } from "@slopproof/auth";
import {
  connectDatabase,
  enqueueJobInPgTransaction,
  expediteJobInPgTransaction,
  migrateDatabase,
  persistValidatedRecording,
  registerJobWorker,
  startJobQueue,
  type DatabaseConnection,
} from "@slopproof/db";
import {
  FakeGithubCheckAdapter,
  PgBossPullRequestQueue,
  ingestPullRequestWebhook,
  processPullRequestJob,
} from "@slopproof/github";
import {
  abortAttemptForTechnicalRetry,
  createReplacementAttempt,
  type CheckIntentWriter,
  type CheckIntentWriterInput,
  type MultipartAbortPort,
} from "../../apps/web/lib/attempt-lifecycle";
import { expireAttempt } from "../../apps/worker/src/attempt-expiry";
import {
  createWorkerCheckIntentWriter,
  LocalFakeRevisionPatchSource,
  prepareRevisionFailClosed,
  type CheckIntentWriter as WorkerCheckIntentWriter,
} from "../../apps/worker/src/revision-preparation";
import { persistGenerationContextV1InTransaction } from "../../apps/worker/src/generation-context-repository";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const webhookSecret = "product-flow-webhook-secret";

class FakeAbortStorage implements MultipartAbortPort {
  readonly calls: { objectKey: string; uploadId: string }[] = [];

  async abortMultipartUpload(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    this.calls.push({ objectKey, uploadId });
  }
}

class RecordingCheckIntentWriter implements CheckIntentWriter {
  readonly calls: CheckIntentWriterInput[] = [];

  async write(
    _client: PoolClient,
    input: CheckIntentWriterInput,
  ): Promise<void> {
    this.calls.push(input);
  }
}

databaseDescribe("complete current-SHA product flow", () => {
  let connection: DatabaseConnection;
  let jobQueue: Awaited<ReturnType<typeof startJobQueue>>;
  let githubQueue: PgBossPullRequestQueue;
  let checks: FakeGithubCheckAdapter;
  let checkIntents: RecordingCheckIntentWriter;
  let workerCheckIntents: WorkerCheckIntentWriter;
  let storage: FakeAbortStorage;
  let failGenerationContextPersistence = false;

  beforeAll(async () => {
    connection = connectDatabase(databaseUrl!);
    await migrateDatabase(connection.pool);
    jobQueue = await startJobQueue(databaseUrl!);
    workerCheckIntents = createWorkerCheckIntentWriter(
      jobQueue,
      "https://slopproof.test",
    );
    githubQueue = new PgBossPullRequestQueue(databaseUrl!);
    checks = new FakeGithubCheckAdapter(
      connection.pool,
      "https://slopproof.test",
    );
    checkIntents = new RecordingCheckIntentWriter();
    storage = new FakeAbortStorage();
    await registerJobWorker(
      jobQueue,
      "analysis.prepare-revision",
      async (job) => {
        await prepareRevisionFailClosed(job.data, {
          pool: connection.pool,
          queue: jobQueue,
          checkIntents: workerCheckIntents,
          patchSource: new LocalFakeRevisionPatchSource(),
          generationContexts: {
            persist: async (client, context) => {
              if (failGenerationContextPersistence) {
                throw new Error("private simulated planner invariant");
              }
              return persistGenerationContextV1InTransaction(client, context);
            },
          },
        });
      },
    );
    await registerJobWorker(jobQueue, "proof.expire-attempt", async (job) => {
      await expireAttempt(job.data, {
        pool: connection.pool,
        storage,
        checkIntents: workerCheckIntents,
      });
    });
    await githubQueue.start();
    await githubQueue.work(async (payload) => {
      await processPullRequestJob(connection.pool, checks, payload, {
        publish: (client, analysisPayload) =>
          enqueueJobInPgTransaction(
            jobQueue,
            client,
            "analysis.prepare-revision",
            analysisPayload,
          ),
        publishAttemptExpiry: (client, expiryPayload) =>
          expediteJobInPgTransaction(
            jobQueue,
            client,
            "proof.expire-attempt",
            expiryPayload,
          ),
      });
    });
  });

  afterAll(async () => {
    if (githubQueue) await githubQueue.stop();
    if (jobQueue) await jobQueue.stop({ graceful: true, timeout: 5_000 });
    if (connection) await connection.close();
  });

  beforeEach(async () => {
    storage.calls.length = 0;
    checkIntents.calls.length = 0;
    failGenerationContextPersistence = false;
    await connection.pool.query(`
      TRUNCATE TABLE
        audit_events, deletion_jobs, check_runs, review_decisions, evaluations,
        frame_selections, transcripts, recording_objects, recording_parts,
        upload_sessions, wrapping_materials, handoff_tokens, auth_sessions,
        attempt_transitions, attempts, proof_questions, proof_plans,
        practice_sessions, generation_contexts, analysis_snapshots,
        github_revision_sources, webhook_deliveries,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations
      RESTART IDENTITY CASCADE
    `);
  });

  it("builds one analysis, frozen plan and attempt, then invalidates it for a new SHA", async () => {
    const first = webhook({
      deliveryId: "71000000-0000-4000-8000-000000000001",
      action: "opened",
      headSha: "a".repeat(40),
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue: githubQueue,
      secret: webhookSecret,
      ...first,
    });
    const firstAttempt = await waitForReadyAttempt(connection, "a".repeat(40));

    const product = await connection.pool.query<{
      analysis_count: number;
      source_count: number;
      context_count: number;
      plan_count: number;
      question_count: number;
      policy_id: string;
      check_status: string;
      public_summary: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM analysis_snapshots WHERE revision_id = $1) AS analysis_count,
         (SELECT count(*)::int FROM github_revision_sources WHERE revision_id = $1) AS source_count,
         (SELECT count(*)::int FROM generation_contexts WHERE revision_id = $1) AS context_count,
         (SELECT count(*)::int FROM proof_plans WHERE revision_id = $1) AS plan_count,
         (SELECT count(*)::int FROM proof_questions question
          JOIN proof_plans plan ON plan.id = question.proof_plan_id
          WHERE plan.revision_id = $1) AS question_count,
         plan.repository_policy_id AS policy_id,
         check_run.status AS check_status, check_run.public_summary
       FROM proof_plans plan
       JOIN check_runs check_run ON check_run.revision_id = plan.revision_id
       WHERE plan.revision_id = $1`,
      [firstAttempt.revision_id],
    );
    expect(product.rows[0]).toMatchObject({
      analysis_count: 1,
      source_count: 1,
      context_count: 1,
      plan_count: 1,
      check_status: "in_progress",
      public_summary: `proof ready for head ${"a".repeat(40)}`,
    });
    expect(product.rows[0]?.question_count).toBeGreaterThan(0);
    expect(product.rows[0]?.policy_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await expect(
      ingestPullRequestWebhook({
        pool: connection.pool,
        queue: githubQueue,
        secret: webhookSecret,
        ...first,
      }),
    ).resolves.toMatchObject({ duplicate: true });
    expect(await count(connection, "attempts")).toBe(1);
    expect(await count(connection, "proof_plans")).toBe(1);
    expect(await count(connection, "generation_contexts")).toBe(1);

    const synchronized = webhook({
      deliveryId: "71000000-0000-4000-8000-000000000002",
      action: "synchronize",
      headSha: "c".repeat(40),
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue: githubQueue,
      secret: webhookSecret,
      ...synchronized,
    });
    const secondAttempt = await waitForReadyAttempt(connection, "c".repeat(40));
    expect(secondAttempt.id).not.toBe(firstAttempt.id);
    const old = await connection.pool.query<{
      status: string;
      is_current: boolean;
    }>(
      `SELECT attempt.status, revision.is_current
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       WHERE attempt.id = $1`,
      [firstAttempt.id],
    );
    expect(old.rows[0]).toMatchObject({
      status: "invalidated",
      is_current: false,
    });
    await waitForAudit(
      connection,
      firstAttempt.id,
      "attempt.expiry_stale_cleanup",
    );
  });

  it("completes a deterministic preparation failure once without a 404-shaped state", async () => {
    failGenerationContextPersistence = true;
    const request = webhook({
      deliveryId: "71000000-0000-4000-8000-000000000003",
      action: "opened",
      headSha: "8".repeat(40),
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue: githubQueue,
      secret: webhookSecret,
      ...request,
    });

    const failed = await waitForPreparationFailure(connection, "8".repeat(40));
    expect(failed).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      intent_reason: "preparation_failed",
      attempt_count: 0,
      failure_audit_count: 1,
    });
    expect(failed.public_summary).toContain("Maintainer action is required");
    expect(failed.public_summary).not.toContain("simulated");
  });

  it("aborts ciphertext upload once, appends technical retry and creates one replacement", async () => {
    const attempt = await createReadyFlow(
      connection,
      githubQueue,
      "71000000-0000-4000-8000-000000000011",
      "d".repeat(40),
    );
    const session = authorSession(attempt);
    const upload = await makeUploading(
      connection,
      attempt.id,
      attempt.head_sha,
    );
    const dependencies = {
      pool: connection.pool,
      queue: jobQueue,
      storage,
      checkIntents,
    };
    const abortInput = {
      attemptId: attempt.id,
      expectedHeadSha: attempt.head_sha,
      reason: "media_track_ended" as const,
      idempotencyKey: `technical-abort:${attempt.id}`,
      session,
    };
    await expect(
      abortAttemptForTechnicalRetry(dependencies, abortInput),
    ).resolves.toMatchObject({ status: "technical_retry", replay: false });
    await expect(
      abortAttemptForTechnicalRetry(dependencies, abortInput),
    ).resolves.toMatchObject({ status: "technical_retry", replay: true });
    expect(storage.calls).toEqual([
      { objectKey: upload.objectKey, uploadId: upload.providerUploadId },
    ]);
    const cleaned = await connection.pool.query<{
      status: string;
      upload_state: string;
      destroyed_at: Date | null;
      transition_count: number;
      audit_count: number;
    }>(
      `SELECT attempt.status, upload.state AS upload_state,
              material.destroyed_at,
              (SELECT count(*)::int FROM attempt_transitions transition
               WHERE transition.attempt_id = attempt.id
                 AND transition.to_status = 'technical_retry') AS transition_count,
              (SELECT count(*)::int FROM audit_events audit
               WHERE audit.object_id = attempt.id::text
                 AND audit.action = 'attempt.technical_retry') AS audit_count
       FROM attempts attempt
       JOIN upload_sessions upload ON upload.attempt_id = attempt.id
       JOIN wrapping_materials material ON material.attempt_id = attempt.id
       WHERE attempt.id = $1`,
      [attempt.id],
    );
    expect(cleaned.rows[0]).toMatchObject({
      status: "technical_retry",
      upload_state: "failed",
      transition_count: 1,
      audit_count: 1,
    });
    expect(cleaned.rows[0]?.destroyed_at).toBeInstanceOf(Date);

    const retryInput = {
      sourceAttemptId: attempt.id,
      expectedHeadSha: attempt.head_sha,
      idempotencyKey: `replacement:${attempt.id}`,
      session,
    };
    const replacement = await createReplacementAttempt(
      dependencies,
      retryInput,
    );
    const replay = await createReplacementAttempt(dependencies, retryInput);
    expect(replacement).toMatchObject({ status: "ready", replay: false });
    expect(replay).toMatchObject({
      attemptId: replacement.attemptId,
      replay: true,
    });
    expect(await count(connection, "attempts")).toBe(2);
    expect(checkIntents.calls).toMatchObject([
      {
        revisionId: attempt.revision_id,
        headSha: attempt.head_sha,
        status: "completed",
        conclusion: "action_required",
        reason: "technical_retry",
        idempotencyKey: abortInput.idempotencyKey,
      },
      {
        revisionId: attempt.revision_id,
        headSha: attempt.head_sha,
        status: "in_progress",
        conclusion: null,
        reason: "contributor_retry",
        idempotencyKey: retryInput.idempotencyKey,
      },
    ]);
  });

  it("rolls back a lifecycle transition when its check intent cannot be persisted", async () => {
    const attempt = await createReadyFlow(
      connection,
      githubQueue,
      "71000000-0000-4000-8000-000000000012",
      "9".repeat(40),
    );
    const failingCheckIntents: CheckIntentWriter = {
      async write() {
        throw new Error("simulated check-intent persistence failure");
      },
    };

    await expect(
      abortAttemptForTechnicalRetry(
        {
          pool: connection.pool,
          queue: jobQueue,
          storage,
          checkIntents: failingCheckIntents,
        },
        {
          attemptId: attempt.id,
          expectedHeadSha: attempt.head_sha,
          reason: "recorder_error",
          idempotencyKey: `technical-abort:${attempt.id}`,
          session: authorSession(attempt),
        },
      ),
    ).rejects.toThrow("simulated check-intent persistence failure");

    const persisted = await connection.pool.query<{
      status: string;
      transition_count: number;
    }>(
      `SELECT attempt.status,
              (SELECT count(*)::int FROM attempt_transitions transition
                WHERE transition.attempt_id = attempt.id
                  AND transition.to_status = 'technical_retry') AS transition_count
         FROM attempts attempt WHERE attempt.id = $1`,
      [attempt.id],
    );
    expect(persisted.rows[0]).toEqual({
      status: "ready",
      transition_count: 0,
    });
  });

  it("does not abort a finalization that already advanced to processing, and expires due uploads", async () => {
    const processing = await createReadyFlow(
      connection,
      githubQueue,
      "71000000-0000-4000-8000-000000000021",
      "e".repeat(40),
    );
    const processingSession = authorSession(processing);
    await makeUploading(connection, processing.id, processing.head_sha);
    await connection.pool.query(
      "UPDATE upload_sessions SET state = 'pending_finalization' WHERE attempt_id = $1",
      [processing.id],
    );
    await connection.pool.query(
      "UPDATE attempts SET status = 'processing', updated_at = now() WHERE id = $1",
      [processing.id],
    );
    await expect(
      abortAttemptForTechnicalRetry(
        { pool: connection.pool, queue: jobQueue, storage, checkIntents },
        {
          attemptId: processing.id,
          expectedHeadSha: processing.head_sha,
          reason: "encryption_or_upload_failed",
          idempotencyKey: `technical-abort:${processing.id}`,
          session: processingSession,
        },
      ),
    ).resolves.toMatchObject({ status: "already_progressed", replay: true });
    expect(storage.calls).toHaveLength(0);

    await connection.pool.query(`
      TRUNCATE TABLE
        audit_events, check_runs, review_decisions, evaluations,
        frame_selections, transcripts, recording_objects, recording_parts,
        upload_sessions, wrapping_materials, handoff_tokens, auth_sessions,
        attempt_transitions, attempts, proof_questions, proof_plans,
        practice_sessions, generation_contexts, analysis_snapshots,
        github_revision_sources, webhook_deliveries,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations
      RESTART IDENTITY CASCADE
    `);
    const expiring = await createReadyFlow(
      connection,
      githubQueue,
      "71000000-0000-4000-8000-000000000022",
      "f".repeat(40),
    );
    const expiryUpload = await makeUploading(
      connection,
      expiring.id,
      expiring.head_sha,
    );
    const expiresAt = await connection.pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM attempts WHERE id = $1",
      [expiring.id],
    );
    await expect(
      expireAttempt(
        {
          schemaVersion: "1",
          idempotencyKey: `expiry-test:${expiring.id}`,
          attemptId: expiring.id,
          expectedHeadSha: expiring.head_sha,
        },
        {
          pool: connection.pool,
          storage,
          checkIntents: workerCheckIntents,
          clock: {
            now: () =>
              new Date(expiresAt.rows[0]!.expires_at.getTime() + 1_000),
          },
        },
      ),
    ).resolves.toMatchObject({ outcome: "expired" });
    expect(storage.calls).toContainEqual({
      objectKey: expiryUpload.objectKey,
      uploadId: expiryUpload.providerUploadId,
    });
    const expiredCheck = await connection.pool.query<{
      status: string;
      conclusion: string | null;
      intent_reason: string | null;
    }>(
      `SELECT status, conclusion, intent_reason
         FROM check_runs
        WHERE revision_id = $1`,
      [expiring.revision_id],
    );
    expect(expiredCheck.rows[0]).toEqual({
      status: "completed",
      conclusion: "action_required",
      intent_reason: "attempt_expired",
    });
  });

  it("persists validated media and queues transcription in the real transaction adapter", async () => {
    const attempt = await createReadyFlow(
      connection,
      githubQueue,
      "71000000-0000-4000-8000-000000000023",
      "d".repeat(40),
    );
    const upload = await makeUploading(
      connection,
      attempt.id,
      attempt.head_sha,
    );
    const manifestHash = "e".repeat(64);
    await connection.pool.query(
      `UPDATE upload_sessions
          SET state = 'pending_finalization', manifest_digest = $2,
              finalize_envelope = '{}'::jsonb, updated_at = now()
        WHERE id = $1`,
      [upload.uploadId, manifestHash],
    );
    await connection.pool.query(
      `INSERT INTO attempt_transitions
        (attempt_id, idempotency_key, from_status, to_status,
         expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
       VALUES ($1, $2, 'uploading', 'processing', $3, $3,
               'test-author', 'author', now())`,
      [attempt.id, `processing-test:${attempt.id}`, attempt.head_sha],
    );
    await connection.pool.query(
      `UPDATE attempts
          SET status = 'processing', evidence_delete_after = now() + interval '1 hour',
              updated_at = now()
        WHERE id = $1`,
      [attempt.id],
    );

    const recordingObjectId = randomUUID();
    await expect(
      persistValidatedRecording(connection.db, jobQueue, {
        recordingObjectId,
        uploadSessionId: upload.uploadId,
        attemptId: attempt.id,
        expectedHeadSha: attempt.head_sha,
        objectKey: upload.objectKey,
        wrappedDataKey: "wrapped-test-key",
        wrappedKeySha256: "f".repeat(64),
        wrappingMaterialId: upload.materialId,
        protocolVersion: "SP-RC1",
        algorithm: "AES-256-GCM",
        byteLength: 4_861_170,
        durationMs: 24_410,
        codec: "video/webm;codecs=vp8,opus",
        manifestHash,
      }),
    ).resolves.toBe(recordingObjectId);

    const persisted = await connection.pool.query<{
      recording_count: number;
      upload_state: string;
      audit_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM recording_objects
           WHERE attempt_id = $1) AS recording_count,
         (SELECT state FROM upload_sessions WHERE id = $2) AS upload_state,
         (SELECT count(*)::int FROM audit_events
           WHERE object_id = $1::uuid::text
             AND action = 'evidence.validated') AS audit_count`,
      [attempt.id, upload.uploadId],
    );
    expect(persisted.rows[0]).toEqual({
      recording_count: 1,
      upload_state: "completed",
      audit_count: 1,
    });
    await expect(
      jobQueue.findJobs("media.extract-transcript", {
        key: attempt.id,
      }),
    ).resolves.toHaveLength(1);
  });
});

function webhook(input: {
  deliveryId: string;
  action: "opened" | "synchronize";
  headSha: string;
}) {
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      action: input.action,
      installation: { id: 71 },
      repository: {
        id: 72,
        name: "orders",
        full_name: "acme/orders",
        default_branch: "main",
        owner: { id: 73, login: "acme" },
      },
      pull_request: {
        id: 740,
        number: 74,
        state: "open",
        user: { id: 75, login: "contributor" },
        head: { sha: input.headSha },
        base: { sha: "b".repeat(40) },
      },
    }),
  );
  return {
    rawBody,
    headers: {
      deliveryId: input.deliveryId,
      eventName: "pull_request" as const,
      signature: `sha256=${createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex")}`,
    },
  };
}

async function createReadyFlow(
  connection: DatabaseConnection,
  queue: PgBossPullRequestQueue,
  deliveryId: string,
  headSha: string,
) {
  const request = webhook({ deliveryId, action: "opened", headSha });
  await ingestPullRequestWebhook({
    pool: connection.pool,
    queue,
    secret: webhookSecret,
    ...request,
  });
  return waitForReadyAttempt(connection, headSha);
}

async function waitForReadyAttempt(
  connection: DatabaseConnection,
  headSha: string,
): Promise<{
  id: string;
  repository_id: string;
  revision_id: string;
  author_id: string;
  head_sha: string;
  expires_at: Date;
}> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await connection.pool.query<{
      id: string;
      repository_id: string;
      revision_id: string;
      author_id: string;
      head_sha: string;
      expires_at: Date;
    }>(
      `SELECT id, repository_id, revision_id, author_id, head_sha, expires_at
       FROM attempts WHERE head_sha = $1 AND status = 'ready'`,
      [headSha],
    );
    if (result.rows[0]) return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ready attempt for ${headSha} was not created`);
}

async function waitForPreparationFailure(
  connection: DatabaseConnection,
  headSha: string,
): Promise<{
  status: string;
  conclusion: string | null;
  intent_reason: string | null;
  public_summary: string;
  attempt_count: number;
  failure_audit_count: number;
}> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await connection.pool.query<{
      status: string;
      conclusion: string | null;
      intent_reason: string | null;
      public_summary: string;
      attempt_count: number;
      failure_audit_count: number;
    }>(
      `SELECT check_run.status, check_run.conclusion,
              check_run.intent_reason, check_run.public_summary,
              (SELECT count(*)::int FROM attempts attempt
                WHERE attempt.revision_id = revision.id) AS attempt_count,
              (SELECT count(*)::int FROM audit_events audit
                WHERE audit.object_type = 'revision'
                  AND audit.object_id = revision.id::text
                  AND audit.action = 'analysis.preparation_failed')
                AS failure_audit_count
         FROM pull_request_revisions revision
         JOIN check_runs check_run ON check_run.revision_id = revision.id
        WHERE revision.head_sha = $1`,
      [headSha],
    );
    if (result.rows[0]?.intent_reason === "preparation_failed") {
      return result.rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`preparation failure for ${headSha} was not persisted`);
}

function authorSession(attempt: {
  repository_id: string;
  author_id: string;
}): AuthenticatedSession {
  return {
    id: randomUUID(),
    actorId: attempt.author_id,
    actorRole: "author",
    repositoryId: attempt.repository_id,
    csrfHash: "test-csrf",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

async function makeUploading(
  connection: DatabaseConnection,
  attemptId: string,
  headSha: string,
): Promise<{
  materialId: string;
  uploadId: string;
  objectKey: string;
  providerUploadId: string;
}> {
  const materialId = randomUUID();
  const objectId = randomUUID();
  const uploadId = randomUUID();
  const objectKey = `evidence/v1/${randomUUID().replaceAll("-", "")}`;
  const providerUploadId = `upload-${randomUUID()}`;
  await connection.pool.query(
    "UPDATE attempts SET status = 'active', started_at = now(), updated_at = now() WHERE id = $1",
    [attemptId],
  );
  await connection.pool.query(
    `INSERT INTO wrapping_materials
      (id, attempt_id, object_id, key_id, algorithm, spki_sha256, usable_until)
     VALUES ($1, $2, $3, 'test-key', 'RSA-OAEP-256', $4,
             now() + interval '8 hours')`,
    [materialId, attemptId, objectId, "s".repeat(43)],
  );
  await connection.pool.query(
    `INSERT INTO upload_sessions
      (id, attempt_id, object_id, object_key, provider_upload_id,
       state, next_part_number, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'active', 1, now() + interval '8 hours')`,
    [uploadId, attemptId, objectId, objectKey, providerUploadId],
  );
  await connection.pool.query(
    `INSERT INTO attempt_transitions
      (attempt_id, idempotency_key, from_status, to_status,
       expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
     VALUES ($1, $2, 'active', 'uploading', $3, $3, 'test-author', 'author', now())`,
    [attemptId, `upload-test:${attemptId}`, headSha],
  );
  await connection.pool.query(
    "UPDATE attempts SET status = 'uploading', updated_at = now() WHERE id = $1",
    [attemptId],
  );
  return { materialId, uploadId, objectKey, providerUploadId };
}

async function waitForAudit(
  connection: DatabaseConnection,
  attemptId: string,
  action: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await connection.pool.query(
      "SELECT 1 FROM audit_events WHERE object_id = $1 AND action = $2",
      [attemptId, action],
    );
    if (result.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`audit ${action} for ${attemptId} was not written`);
}

async function count(
  connection: DatabaseConnection,
  table: "attempts" | "proof_plans" | "generation_contexts",
): Promise<number> {
  const result = await connection.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return result.rows[0]?.count ?? 0;
}
