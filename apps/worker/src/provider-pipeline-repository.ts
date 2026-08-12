import { createHash } from "node:crypto";
import type { DatabaseConnection, JobPayload } from "@slopproof/db";
import type { RepositoryPolicyV1 } from "@slopproof/policy";
import {
  EncryptedEvaluationBundleV1Schema,
  EncryptedTranscriptBundleV1Schema,
  EvaluationPolicyContextV1Schema,
  EvaluationRunContextV1Schema,
  FrameSelectionContextV1Schema,
  FrameSelectionStageBundleV1Schema,
  TranscriptExtractionContextV1Schema,
  type EncryptedEvaluationBundleV1,
  type EncryptedTranscriptBundleV1,
  type EvaluationPolicyContextV1,
  type EvaluationRunContextV1,
  type FrameSelectionContextV1,
  type FrameSelectionStageBundleV1,
  type ProviderPipelineRepository,
  type StoredProofQuestionV1,
  type TranscriptExtractionContextV1,
} from "./provider-pipeline-contracts";
import type { CheckIntentWriter } from "./revision-preparation";

type AttemptRow = {
  attempt_id: string;
  revision_id: string;
  repository_id: string;
  head_sha: string;
  status: string;
  is_current: boolean;
};

type RecordingRow = AttemptRow & {
  recording_object_id: string;
  duration_ms: number;
  manifest_hash: string;
  delete_after: Date;
};

type TranscriptRow = RecordingRow & {
  transcript_id: string;
  transcript_provider: string;
  transcript_schema_version: string;
  encrypted_transcript: string;
  transcript_delete_after: Date;
};

type EvaluationRow = AttemptRow & {
  evaluation_id: string;
  evaluation_provider: string;
  evaluation_model: string;
  prompt_version: string;
  evaluation_schema_version: string;
  rubric_version: string;
  recommendation: "pass" | "review_required" | "retry";
  encrypted_evaluation: string;
  evaluation_delete_after: Date;
  policy: RepositoryPolicyV1;
};

type ProofQuestionRow = {
  id: string;
  ordinal: number;
  prompt: string;
  diff_anchor: unknown;
  rubric: unknown;
};

type FrameRow = {
  id: string;
  timestamp_ms: number;
  reason_code: string;
  object_key: string;
};

function question(row: ProofQuestionRow): StoredProofQuestionV1 {
  return {
    id: row.id,
    ordinal: row.ordinal,
    prompt: row.prompt,
    diffAnchor: row.diff_anchor,
    rubric: row.rubric,
  };
}

function binding(row: AttemptRow, deleteAfter: Date) {
  return {
    attemptId: row.attempt_id,
    revisionId: row.revision_id,
    repositoryId: row.repository_id,
    headSha: row.head_sha,
    status: row.status,
    isCurrent: row.is_current,
    deleteAfter,
  };
}

function transcriptBundle(row: TranscriptRow): EncryptedTranscriptBundleV1 {
  return EncryptedTranscriptBundleV1Schema.parse({
    schemaVersion: "1",
    payloadKind: "transcript",
    transcriptId: row.transcript_id,
    attemptId: row.attempt_id,
    provider: row.transcript_provider,
    transcriptSchemaVersion: row.transcript_schema_version,
    encryptedPayload: row.encrypted_transcript,
    deleteAfter: row.transcript_delete_after,
  });
}

function decodeFrameObjectKey(row: FrameRow) {
  const match =
    /^provider-frame\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(\d+)x(\d+)$/.exec(
      row.object_key,
    );
  if (match === null) {
    throw new Error("stored provider frame metadata has an invalid object key");
  }
  const [, encryptedDerivativeRef, ciphertextSha256, width, height] = match;
  return {
    id: row.id,
    timestampMs: row.timestamp_ms,
    reasonCode: row.reason_code,
    reason: "Versioned frame metadata selected by the worker pipeline.",
    encryptedDerivativeRef,
    ciphertextSha256,
    width: Number(width),
    height: Number(height),
  };
}

export class PostgresProviderPipelineRepository implements ProviderPipelineRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly checkIntents: CheckIntentWriter,
  ) {}

  private async loadQuestions(
    attemptId: string,
  ): Promise<StoredProofQuestionV1[]> {
    const result = await this.database.pool.query<ProofQuestionRow>(
      `SELECT question.id, question.ordinal, question.prompt,
              question.diff_anchor, question.rubric
         FROM attempts attempt
         JOIN proof_questions question
           ON question.proof_plan_id = attempt.proof_plan_id
        WHERE attempt.id = $1 AND question.required = true
        ORDER BY question.ordinal ASC`,
      [attemptId],
    );
    return result.rows.map(question);
  }

  async loadTranscriptExtraction(
    job: JobPayload<"media.extract-transcript">,
  ): Promise<TranscriptExtractionContextV1> {
    const result = await this.database.pool.query<RecordingRow>(
      `SELECT attempt.id AS attempt_id, attempt.revision_id,
              attempt.repository_id, attempt.head_sha, attempt.status,
              revision.is_current, recording.id AS recording_object_id,
              recording.duration_ms, recording.manifest_hash,
              recording.delete_after
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
        WHERE attempt.id = $1 AND recording.id = $2`,
      [job.attemptId, job.recordingObjectId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("transcript extraction context not found");
    return TranscriptExtractionContextV1Schema.parse({
      schemaVersion: "1",
      ...binding(row, row.delete_after),
      recordingObjectId: row.recording_object_id,
      recordingDurationMs: row.duration_ms,
      recordingManifestHash: row.manifest_hash,
      questions: await this.loadQuestions(job.attemptId),
    });
  }

  async persistTranscript(
    rawBundle: EncryptedTranscriptBundleV1,
  ): Promise<"created" | "replayed"> {
    const bundle = EncryptedTranscriptBundleV1Schema.parse(rawBundle);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`provider-transcript:${bundle.attemptId}`],
      );
      const existing = await client.query(
        `SELECT id FROM transcripts
          WHERE attempt_id = $1 AND provider = $2 AND schema_version = $3
          LIMIT 1`,
        [bundle.attemptId, bundle.provider, bundle.transcriptSchemaVersion],
      );
      if ((existing.rowCount ?? 0) > 0) {
        await client.query("COMMIT");
        return "replayed";
      }
      const inserted = await client.query(
        `INSERT INTO transcripts
           (id, attempt_id, provider, schema_version, encrypted_payload, delete_after)
         SELECT $1, $2, $3, $4, $5, recording.delete_after
           FROM recording_objects recording
          WHERE recording.attempt_id = $2
            AND recording.delete_after = $6`,
        [
          bundle.transcriptId,
          bundle.attemptId,
          bundle.provider,
          bundle.transcriptSchemaVersion,
          bundle.encryptedPayload,
          bundle.deleteAfter,
        ],
      );
      if (inserted.rowCount !== 1) {
        throw new Error("transcript deadline does not match accepted evidence");
      }
      await client.query("COMMIT");
      return "created";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadFrameSelection(
    job: JobPayload<"media.select-frames">,
  ): Promise<FrameSelectionContextV1> {
    const result = await this.database.pool.query<TranscriptRow>(
      `SELECT attempt.id AS attempt_id, attempt.revision_id,
              attempt.repository_id, attempt.head_sha, attempt.status,
              revision.is_current, recording.id AS recording_object_id,
              recording.duration_ms, recording.manifest_hash,
              recording.delete_after, transcript.id AS transcript_id,
              transcript.provider AS transcript_provider,
              transcript.schema_version AS transcript_schema_version,
              transcript.encrypted_payload AS encrypted_transcript,
              transcript.delete_after AS transcript_delete_after
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
         JOIN transcripts transcript ON transcript.attempt_id = attempt.id
        WHERE attempt.id = $1 AND recording.id = $2 AND transcript.id = $3`,
      [job.attemptId, job.recordingObjectId, job.transcriptId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("frame selection context not found");
    return FrameSelectionContextV1Schema.parse({
      schemaVersion: "1",
      ...binding(row, row.transcript_delete_after),
      recordingObjectId: row.recording_object_id,
      recordingDurationMs: row.duration_ms,
      transcript: transcriptBundle(row),
    });
  }

  async persistFrameSelection(
    rawBundle: FrameSelectionStageBundleV1,
  ): Promise<"created" | "replayed"> {
    const bundle = FrameSelectionStageBundleV1Schema.parse(rawBundle);
    let created = 0;
    for (const frame of bundle.metadata.frames) {
      const objectKey = [
        "provider-frame",
        frame.encryptedDerivativeRef,
        frame.ciphertextSha256,
        `${String(frame.width)}x${String(frame.height)}`,
      ].join("/");
      const result = await this.database.pool.query(
        `INSERT INTO frame_selections
           (id, attempt_id, timestamp_ms, reason_code, object_key, delete_after)
         SELECT $1, $2, $3, $4, $5, recording.delete_after
           FROM recording_objects recording
          WHERE recording.attempt_id = $2
         ON CONFLICT (id) DO NOTHING`,
        [
          frame.id,
          bundle.attemptId,
          frame.timestampMs,
          frame.reasonCode,
          objectKey,
        ],
      );
      created += result.rowCount ?? 0;
    }
    return created > 0 ? "created" : "replayed";
  }

  async loadEvaluationRun(
    job: JobPayload<"evaluation.run">,
  ): Promise<EvaluationRunContextV1> {
    const result = await this.database.pool.query<TranscriptRow>(
      `SELECT attempt.id AS attempt_id, attempt.revision_id,
              attempt.repository_id, attempt.head_sha, attempt.status,
              revision.is_current, recording.id AS recording_object_id,
              recording.duration_ms, recording.manifest_hash,
              recording.delete_after, transcript.id AS transcript_id,
              transcript.provider AS transcript_provider,
              transcript.schema_version AS transcript_schema_version,
              transcript.encrypted_payload AS encrypted_transcript,
              transcript.delete_after AS transcript_delete_after
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
         JOIN transcripts transcript ON transcript.attempt_id = attempt.id
        WHERE attempt.id = $1 AND transcript.id = $2`,
      [job.attemptId, job.transcriptId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("evaluation run context not found");
    const frames = await this.database.pool.query<FrameRow>(
      `SELECT id, timestamp_ms, reason_code, object_key
         FROM frame_selections WHERE attempt_id = $1
        ORDER BY timestamp_ms ASC, id ASC`,
      [job.attemptId],
    );
    return EvaluationRunContextV1Schema.parse({
      schemaVersion: "1",
      ...binding(row, row.transcript_delete_after),
      transcript: transcriptBundle(row),
      questions: await this.loadQuestions(job.attemptId),
      frameSelection: {
        schemaVersion: "1",
        selectionVersion: "frame-selection-v1",
        attemptId: job.attemptId,
        recordingDurationMs: row.duration_ms,
        frames: frames.rows.map(decodeFrameObjectKey),
      },
    });
  }

  async persistEvaluation(
    rawBundle: EncryptedEvaluationBundleV1,
  ): Promise<"created" | "replayed"> {
    const bundle = EncryptedEvaluationBundleV1Schema.parse(rawBundle);
    const result = await this.database.pool.query(
      `INSERT INTO evaluations
         (id, attempt_id, provider, model, prompt_version, schema_version,
          rubric_version, encrypted_payload, recommendation, delete_after)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, recording.delete_after
         FROM recording_objects recording
        WHERE recording.attempt_id = $2
          AND recording.delete_after = $10
       ON CONFLICT
         (attempt_id, provider, model, prompt_version, schema_version, rubric_version)
       DO NOTHING`,
      [
        bundle.evaluationId,
        bundle.attemptId,
        bundle.provider,
        bundle.model,
        bundle.promptVersion,
        bundle.evaluationSchemaVersion,
        bundle.rubricVersion,
        bundle.encryptedPayload,
        bundle.recommendation,
        bundle.deleteAfter,
      ],
    );
    if (result.rowCount === 1) return "created";
    const existing = await this.database.pool.query(
      `SELECT 1 FROM evaluations
        WHERE attempt_id = $1 AND provider = $2 AND model = $3
          AND prompt_version = $4 AND schema_version = $5
          AND rubric_version = $6 AND delete_after = $7`,
      [
        bundle.attemptId,
        bundle.provider,
        bundle.model,
        bundle.promptVersion,
        bundle.evaluationSchemaVersion,
        bundle.rubricVersion,
        bundle.deleteAfter,
      ],
    );
    if ((existing.rowCount ?? 0) === 0) {
      throw new Error("evaluation deadline does not match accepted evidence");
    }
    return "replayed";
  }

  async loadEvaluationPolicy(
    job: JobPayload<"evaluation.apply-policy">,
  ): Promise<EvaluationPolicyContextV1> {
    const result = await this.database.pool.query<EvaluationRow>(
      `SELECT attempt.id AS attempt_id, attempt.revision_id,
              attempt.repository_id, attempt.head_sha, attempt.status,
              revision.is_current, evaluation.id AS evaluation_id,
              evaluation.provider AS evaluation_provider,
              evaluation.model AS evaluation_model,
              evaluation.prompt_version, evaluation.schema_version AS evaluation_schema_version,
              evaluation.rubric_version, evaluation.recommendation,
              evaluation.encrypted_payload AS encrypted_evaluation,
              evaluation.delete_after AS evaluation_delete_after,
              policy.policy
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
         JOIN repository_policies policy
           ON policy.id = proof_plan.repository_policy_id
         JOIN evaluations evaluation ON evaluation.attempt_id = attempt.id
        WHERE attempt.id = $1 AND evaluation.id = $2`,
      [job.attemptId, job.evaluationId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("evaluation policy context not found");
    return EvaluationPolicyContextV1Schema.parse({
      schemaVersion: "1",
      ...binding(row, row.evaluation_delete_after),
      evaluation: {
        schemaVersion: "1",
        payloadKind: "proof_evaluation",
        evaluationId: row.evaluation_id,
        attemptId: row.attempt_id,
        provider: row.evaluation_provider,
        model: row.evaluation_model,
        promptVersion: row.prompt_version,
        evaluationSchemaVersion: row.evaluation_schema_version,
        rubricVersion: row.rubric_version,
        recommendation: row.recommendation,
        encryptedPayload: row.encrypted_evaluation,
        deleteAfter: row.evaluation_delete_after,
      },
      repositoryPolicy: row.policy,
    });
  }

  async transitionToReviewRequired(input: {
    attemptId: string;
    expectedHeadSha: string;
    idempotencyKey: string;
    evaluationId?: string;
    providerRecommendation?: "pass" | "review_required" | "retry";
    reason: "valid_policy" | "provider_manual_review";
  }): Promise<"updated" | "replayed" | "stale"> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        status: string;
        revision_id: string;
        head_sha: string;
        is_current: boolean;
      }>(
        `SELECT attempt.status, attempt.revision_id, attempt.head_sha,
                revision.is_current
           FROM attempts attempt
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
          WHERE attempt.id = $1 FOR UPDATE OF attempt`,
        [input.attemptId],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.head_sha !== input.expectedHeadSha ||
        !row.is_current ||
        !["processing", "review_required"].includes(row.status)
      ) {
        await client.query("ROLLBACK");
        return "stale";
      }
      if (row.status === "review_required") {
        await client.query("COMMIT");
        return "replayed";
      }
      const transition = await client.query(
        `INSERT INTO attempt_transitions
           (attempt_id, idempotency_key, from_status, to_status,
            expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
         VALUES ($1, $2, 'processing', 'review_required', $3, $3,
                 'provider-pipeline', 'system', now())
         ON CONFLICT (attempt_id, idempotency_key) DO NOTHING`,
        [input.attemptId, input.idempotencyKey, input.expectedHeadSha],
      );
      if (transition.rowCount !== 1) {
        await client.query("COMMIT");
        return "replayed";
      }
      await client.query(
        `UPDATE attempts SET status = 'review_required', updated_at = now()
          WHERE id = $1 AND status = 'processing'`,
        [input.attemptId],
      );
      await client.query(
        `INSERT INTO audit_events
           (actor_id, action, object_type, object_id, metadata)
         VALUES ('provider-pipeline', 'attempt.review_required', 'attempt', $1,
                 jsonb_build_object('reason', $2::text,
                                    'evaluationId', $3::text,
                                    'providerRecommendation', $4::text))`,
        [
          input.attemptId,
          input.reason,
          input.evaluationId ?? null,
          input.providerRecommendation ?? null,
        ],
      );
      await this.checkIntents.write(client, {
        revisionId: row.revision_id,
        headSha: row.head_sha,
        status: "in_progress",
        conclusion: null,
        summary: `maintainer review required for head ${row.head_sha}`,
        reason: "review_required",
        idempotencyKey: input.idempotencyKey,
      });
      await client.query("COMMIT");
      return "updated";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionToTechnicalRetry(input: {
    attemptId: string;
    expectedHeadSha: string;
    idempotencyKey: string;
    errorClass: string;
  }): Promise<"updated" | "replayed" | "stale"> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        status: string;
        revision_id: string;
        head_sha: string;
        is_current: boolean;
      }>(
        `SELECT attempt.status, attempt.revision_id, attempt.head_sha,
                revision.is_current
           FROM attempts attempt
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
          WHERE attempt.id = $1 FOR UPDATE OF attempt`,
        [input.attemptId],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.head_sha !== input.expectedHeadSha ||
        !row.is_current ||
        !["processing", "technical_retry"].includes(row.status)
      ) {
        await client.query("ROLLBACK");
        return "stale";
      }
      if (row.status === "technical_retry") {
        await client.query("COMMIT");
        return "replayed";
      }
      const transition = await client.query(
        `INSERT INTO attempt_transitions
           (attempt_id, idempotency_key, from_status, to_status,
            expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
         VALUES ($1, $2, 'processing', 'technical_retry', $3, $3,
                 'provider-pipeline', 'system', now())
         ON CONFLICT (attempt_id, idempotency_key) DO NOTHING`,
        [input.attemptId, input.idempotencyKey, input.expectedHeadSha],
      );
      if (transition.rowCount !== 1) {
        await client.query("COMMIT");
        return "replayed";
      }
      await client.query(
        `UPDATE attempts SET status = 'technical_retry', completed_at = now(),
             updated_at = now() WHERE id = $1 AND status = 'processing'`,
        [input.attemptId],
      );
      await client.query(
        `INSERT INTO audit_events
           (actor_id, action, object_type, object_id, metadata)
         VALUES ('provider-pipeline', 'attempt.technical_retry', 'attempt', $1,
                 jsonb_build_object('errorClass', $2::text))`,
        [input.attemptId, input.errorClass],
      );
      await this.checkIntents.write(client, {
        revisionId: row.revision_id,
        headSha: row.head_sha,
        status: "completed",
        conclusion: "neutral",
        summary: `technical retry required for head ${row.head_sha}`,
        reason: "technical_retry",
        idempotencyKey: input.idempotencyKey,
      });
      await client.query("COMMIT");
      return "updated";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function providerFrameMetadataHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
