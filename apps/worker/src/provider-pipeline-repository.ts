import { createHash } from "node:crypto";
import {
  expediteJobInPgTransaction,
  type DatabaseConnection,
  type JobPayload,
} from "@understandproof/db";
import {
  REVIEW_REQUIRED_GITHUB_CHECK,
  TECHNICAL_RETRY_GITHUB_CHECK,
} from "@understandproof/github";
import { FinalizeRecordingSchema } from "@understandproof/media";
import type { RepositoryPolicyV1 } from "@understandproof/policy";
import type {
  ProviderErrorCode,
  ProviderFailureTelemetry,
} from "@understandproof/providers";
import {
  EncryptedEvaluationBundleV1Schema,
  EncryptedTranscriptBundleV1Schema,
  EvaluationPolicyContextV1Schema,
  EvaluationRunContextV1Schema,
  FrameSelectionContextV1Schema,
  FrameSelectionStageBundleV1Schema,
  PrivateProviderStageUnavailableError,
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
import { RecordingAudioTranscriptionSourceV1Schema } from "./audio-transcription";
import type { PgBoss } from "pg-boss";
import type { CheckIntentWriter } from "./revision-preparation";

type AttemptRow = {
  attempt_id: string;
  revision_id: string;
  repository_id: string;
  head_sha: string;
  status: string;
  is_current: boolean;
  pull_request_state: string;
  repository_status: string;
  installation_status: string;
  retention_active: boolean;
};

type RecordingRow = AttemptRow & {
  recording_object_id: string;
  duration_ms: number;
  manifest_hash: string;
  delete_after: Date;
  byte_length: number;
  codec: string;
  object_key: string | null;
  finalize_envelope: unknown | null;
  material_id: string | null;
  material_key_id: string | null;
  question_intervals: unknown | null;
  interval_manifest_digest: string | null;
  interval_recorded_duration_ms: number | null;
  recording_deleted_at: Date | null;
};

type TranscriptRow = RecordingRow & {
  transcript_id: string;
  transcript_provider: string;
  transcript_schema_version: string;
  encrypted_transcript: string;
  transcript_delete_after: Date;
  transcript_deleted_at: Date | null;
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
  evaluation_deleted_at: Date | null;
  policy: RepositoryPolicyV1;
};

type StoredEvaluationRow = {
  evaluation_id: string;
  attempt_id: string;
  evaluation_provider: string;
  evaluation_model: string;
  prompt_version: string;
  evaluation_schema_version: string;
  rubric_version: string;
  recommendation: "pass" | "review_required" | "retry";
  encrypted_evaluation: string;
  evaluation_delete_after: Date;
  evaluation_active?: boolean;
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

function sha256Id(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

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
    privateAccessEligible:
      row.pull_request_state === "open" &&
      row.repository_status === "active" &&
      row.installation_status === "active" &&
      row.retention_active,
    deleteAfter,
  };
}

type StoredTranscriptRow = {
  transcript_id: string;
  attempt_id: string;
  transcript_provider: string;
  transcript_schema_version: string;
  encrypted_transcript: string;
  transcript_delete_after: Date;
  transcript_active?: boolean;
};

function storedTranscriptBundle(
  row: StoredTranscriptRow,
): EncryptedTranscriptBundleV1 {
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

function transcriptBundle(row: TranscriptRow): EncryptedTranscriptBundleV1 {
  return storedTranscriptBundle(row);
}

function storedEvaluationBundle(
  row: StoredEvaluationRow,
): EncryptedEvaluationBundleV1 {
  return EncryptedEvaluationBundleV1Schema.parse({
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
    private readonly queue?: PgBoss,
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
              revision.is_current, pull_request.state AS pull_request_state,
              repository.status AS repository_status,
              installation.status AS installation_status,
              (recording.delete_after > clock_timestamp()
               AND recording.deleted_at IS NULL) AS retention_active,
              recording.id AS recording_object_id,
              recording.duration_ms, recording.byte_length, recording.codec,
              recording.manifest_hash,
              recording.delete_after, recording.deleted_at AS recording_deleted_at,
              upload.object_key,
              upload.finalize_envelope, material.id AS material_id,
              material.key_id AS material_key_id,
              interval_set.intervals AS question_intervals,
              interval_set.manifest_digest AS interval_manifest_digest,
              interval_set.recorded_duration_ms AS interval_recorded_duration_ms
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           AND pull_request.repository_id = attempt.repository_id
         JOIN repositories repository ON repository.id = attempt.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
         LEFT JOIN upload_sessions upload
           ON upload.attempt_id = attempt.id
          AND upload.object_key = recording.object_key
          AND upload.state = 'completed'
         LEFT JOIN wrapping_materials material
           ON material.id = recording.wrapping_material_id
         LEFT JOIN proof_question_interval_sets interval_set
           ON interval_set.attempt_id = attempt.id
          AND interval_set.upload_session_id = upload.id
        WHERE attempt.id = $1 AND recording.id = $2`,
      [job.attemptId, job.recordingObjectId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("transcript extraction context not found");
    const questions = await this.loadQuestions(job.attemptId);
    const currentBinding = binding(row, row.delete_after);
    const existing = await this.database.pool.query<StoredTranscriptRow>(
      `SELECT id AS transcript_id, attempt_id,
              provider AS transcript_provider,
              schema_version AS transcript_schema_version,
              encrypted_payload AS encrypted_transcript,
              delete_after AS transcript_delete_after,
              (deleted_at IS NULL AND delete_after > clock_timestamp())
                AS transcript_active
         FROM transcripts
        WHERE attempt_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT 2`,
      [job.attemptId],
    );
    if (existing.rows.length > 1) {
      throw new Error("multiple transcripts exist for one attempt");
    }
    const existingRow = existing.rows[0];
    if (existingRow !== undefined && !existingRow.transcript_active) {
      throw new PrivateProviderStageUnavailableError();
    }
    const existingTranscript = existingRow
      ? storedTranscriptBundle(existingRow)
      : undefined;
    let recordingAudio;
    if (
      currentBinding.privateAccessEligible &&
      row.recording_deleted_at === null &&
      row.object_key !== null &&
      row.finalize_envelope !== null &&
      row.material_id !== null &&
      row.material_key_id !== null &&
      row.question_intervals !== null &&
      row.interval_manifest_digest !== null &&
      row.interval_recorded_duration_ms !== null
    ) {
      const finalization = FinalizeRecordingSchema.parse(row.finalize_envelope);
      if (
        finalization.manifestDigest !== row.interval_manifest_digest ||
        finalization.manifest.durationMs !==
          row.interval_recorded_duration_ms ||
        finalization.manifestDigest !== row.manifest_hash ||
        finalization.manifest.totalObjectBytes !== Number(row.byte_length) ||
        finalization.manifest.codec !== row.codec
      ) {
        throw new Error("stored transcription source binding is inconsistent");
      }
      recordingAudio = {
        objectKey: row.object_key,
        source: RecordingAudioTranscriptionSourceV1Schema.parse({
          schemaVersion: "1",
          sourceVersion: "recording-audio-source-v1",
          attemptId: row.attempt_id,
          recordingObjectId: row.recording_object_id,
          headSha: row.head_sha,
          sourceSha256: finalization.manifestDigest,
          recordingDurationMs: finalization.manifest.durationMs,
          recordingCiphertextBytes: finalization.manifest.totalObjectBytes,
          recordingCodec: finalization.manifest.codec,
          materialId: row.material_id,
          materialKeyId: row.material_key_id,
          finalization,
          proofQuestionIds: questions.map((question) => question.id),
          questionIntervals: row.question_intervals,
          languagePolicy: { mode: "detect" },
        }),
      };
    }
    return TranscriptExtractionContextV1Schema.parse({
      schemaVersion: "1",
      ...currentBinding,
      recordingObjectId: row.recording_object_id,
      recordingDurationMs:
        recordingAudio?.source.recordingDurationMs ?? row.duration_ms,
      recordingManifestHash: row.manifest_hash,
      questions,
      ...(existingTranscript === undefined ? {} : { existingTranscript }),
      ...(recordingAudio === undefined ? {} : { recordingAudio }),
    });
  }

  async persistTranscript(rawBundle: EncryptedTranscriptBundleV1): Promise<{
    status: "created" | "replayed";
    transcript: EncryptedTranscriptBundleV1;
  }> {
    const bundle = EncryptedTranscriptBundleV1Schema.parse(rawBundle);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`provider-transcript:${bundle.attemptId}`],
      );
      const existing = await client.query<StoredTranscriptRow>(
        `SELECT transcript.id AS transcript_id, transcript.attempt_id,
                transcript.provider AS transcript_provider,
                transcript.schema_version AS transcript_schema_version,
                transcript.encrypted_payload AS encrypted_transcript,
                transcript.delete_after AS transcript_delete_after,
                (transcript.deleted_at IS NULL
                 AND transcript.delete_after > clock_timestamp())
                  AS transcript_active
           FROM transcripts transcript
           JOIN attempts attempt ON attempt.id = transcript.attempt_id
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE transcript.attempt_id = $1
            AND attempt.status = 'processing' AND revision.is_current = true
            AND pull_request.state = 'open' AND repository.status = 'active'
            AND installation.status = 'active'
            AND EXISTS (
              SELECT 1 FROM recording_objects recording
               WHERE recording.attempt_id = attempt.id
                 AND recording.deleted_at IS NULL
                 AND recording.delete_after > clock_timestamp()
            )
          ORDER BY transcript.created_at ASC, transcript.id ASC
          LIMIT 2`,
        [bundle.attemptId],
      );
      if (existing.rows.length > 1) {
        throw new Error("multiple transcripts exist for one attempt");
      }
      let status: "created" | "replayed";
      let transcript: EncryptedTranscriptBundleV1;
      if (existing.rows[0]) {
        if (!existing.rows[0].transcript_active) {
          throw new PrivateProviderStageUnavailableError();
        }
        status = "replayed";
        transcript = storedTranscriptBundle(existing.rows[0]);
      } else {
        const inserted = await client.query(
          `INSERT INTO transcripts
             (id, attempt_id, provider, schema_version, encrypted_payload, delete_after)
           SELECT $1, $2, $3, $4, $5, recording.delete_after
             FROM attempts attempt
             JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
             JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
               AND pull_request.repository_id = attempt.repository_id
             JOIN repositories repository ON repository.id = attempt.repository_id
             JOIN installations installation ON installation.id = repository.installation_id
             JOIN recording_objects recording ON recording.attempt_id = attempt.id
            WHERE attempt.id = $2 AND attempt.status = 'processing'
              AND revision.is_current = true AND pull_request.state = 'open'
              AND repository.status = 'active' AND installation.status = 'active'
              AND recording.deleted_at IS NULL
              AND recording.delete_after > clock_timestamp()
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
          throw new PrivateProviderStageUnavailableError();
        }
        status = "created";
        transcript = bundle;
      }
      await client.query("COMMIT");
      return { status, transcript };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async schedulePersistedTranscript(
    rawTranscript: EncryptedTranscriptBundleV1,
    downstreamJob: JobPayload<"media.select-frames">,
  ): Promise<boolean> {
    if (this.queue === undefined) return false;
    const transcript = EncryptedTranscriptBundleV1Schema.parse(rawTranscript);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const eligible = await client.query(
        `SELECT transcript.id
           FROM transcripts transcript
           JOIN attempts attempt ON attempt.id = transcript.attempt_id
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE transcript.id = $1 AND transcript.attempt_id = $2
            AND transcript.deleted_at IS NULL
            AND transcript.delete_after > clock_timestamp()
            AND attempt.status = 'processing' AND revision.is_current = true
            AND attempt.head_sha = $3 AND pull_request.state = 'open'
            AND repository.status = 'active' AND installation.status = 'active'
            AND EXISTS (
              SELECT 1 FROM recording_objects recording
               WHERE recording.id = $4 AND recording.attempt_id = attempt.id
                 AND recording.deleted_at IS NULL
                 AND recording.delete_after > clock_timestamp()
            )
          FOR UPDATE OF transcript, attempt, revision, pull_request,
                        repository, installation`,
        [
          transcript.transcriptId,
          transcript.attemptId,
          downstreamJob.expectedHeadSha,
          downstreamJob.recordingObjectId,
        ],
      );
      if ((eligible.rowCount ?? 0) === 0) {
        throw new PrivateProviderStageUnavailableError();
      }
      await expediteJobInPgTransaction(
        this.queue,
        client,
        "media.select-frames",
        { ...downstreamJob, transcriptId: transcript.transcriptId },
      );
      await client.query("COMMIT");
      return true;
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
              revision.is_current, pull_request.state AS pull_request_state,
              repository.status AS repository_status,
              installation.status AS installation_status,
              (recording.delete_after > clock_timestamp()
               AND recording.deleted_at IS NULL
               AND transcript.delete_after > clock_timestamp()
               AND transcript.deleted_at IS NULL) AS retention_active,
              recording.id AS recording_object_id,
              recording.duration_ms, recording.manifest_hash,
              recording.delete_after, recording.deleted_at AS recording_deleted_at,
              transcript.id AS transcript_id,
              transcript.provider AS transcript_provider,
              transcript.schema_version AS transcript_schema_version,
              transcript.encrypted_payload AS encrypted_transcript,
              transcript.delete_after AS transcript_delete_after,
              transcript.deleted_at AS transcript_deleted_at,
              recording.byte_length, recording.codec,
              NULL::text AS object_key, NULL::jsonb AS finalize_envelope,
              NULL::uuid AS material_id, NULL::text AS material_key_id,
              NULL::jsonb AS question_intervals,
              NULL::text AS interval_manifest_digest,
              NULL::integer AS interval_recorded_duration_ms
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           AND pull_request.repository_id = attempt.repository_id
         JOIN repositories repository ON repository.id = attempt.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
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
           FROM attempts attempt
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
           JOIN recording_objects recording ON recording.attempt_id = attempt.id
          WHERE attempt.id = $2 AND attempt.status = 'processing'
            AND revision.is_current = true AND pull_request.state = 'open'
            AND repository.status = 'active' AND installation.status = 'active'
            AND recording.deleted_at IS NULL
            AND recording.delete_after > clock_timestamp()
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
    if (bundle.metadata.frames.length > 0 && created === 0) {
      const exact = await this.database.pool.query(
        `SELECT count(*)::int AS count
           FROM frame_selections frame
           JOIN attempts attempt ON attempt.id = frame.attempt_id
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
           JOIN recording_objects recording ON recording.attempt_id = attempt.id
          WHERE frame.attempt_id = $1 AND frame.deleted_at IS NULL
            AND attempt.status = 'processing' AND revision.is_current = true
            AND pull_request.state = 'open' AND repository.status = 'active'
            AND installation.status = 'active' AND recording.deleted_at IS NULL
            AND recording.delete_after > clock_timestamp()`,
        [bundle.attemptId],
      );
      if (Number(exact.rows[0]?.count ?? 0) === 0) {
        throw new PrivateProviderStageUnavailableError();
      }
    }
    return created > 0 ? "created" : "replayed";
  }

  async loadEvaluationRun(
    job: JobPayload<"evaluation.run">,
  ): Promise<EvaluationRunContextV1> {
    const result = await this.database.pool.query<TranscriptRow>(
      `SELECT attempt.id AS attempt_id, attempt.revision_id,
              attempt.repository_id, attempt.head_sha, attempt.status,
              revision.is_current, pull_request.state AS pull_request_state,
              repository.status AS repository_status,
              installation.status AS installation_status,
              (recording.delete_after > clock_timestamp()
               AND recording.deleted_at IS NULL
               AND transcript.delete_after > clock_timestamp()
               AND transcript.deleted_at IS NULL) AS retention_active,
              recording.id AS recording_object_id,
              recording.duration_ms, recording.manifest_hash,
              recording.delete_after, recording.deleted_at AS recording_deleted_at,
              transcript.id AS transcript_id,
              transcript.provider AS transcript_provider,
              transcript.schema_version AS transcript_schema_version,
              transcript.encrypted_payload AS encrypted_transcript,
              transcript.delete_after AS transcript_delete_after,
              transcript.deleted_at AS transcript_deleted_at,
              recording.byte_length, recording.codec,
              NULL::text AS object_key, NULL::jsonb AS finalize_envelope,
              NULL::uuid AS material_id, NULL::text AS material_key_id,
              NULL::jsonb AS question_intervals,
              NULL::text AS interval_manifest_digest,
              NULL::integer AS interval_recorded_duration_ms
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           AND pull_request.repository_id = attempt.repository_id
         JOIN repositories repository ON repository.id = attempt.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
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
    const existing = await this.database.pool.query<StoredEvaluationRow>(
      `SELECT id AS evaluation_id, attempt_id,
              provider AS evaluation_provider, model AS evaluation_model,
              prompt_version,
              schema_version AS evaluation_schema_version,
              rubric_version, recommendation,
              encrypted_payload AS encrypted_evaluation,
              delete_after AS evaluation_delete_after,
              (deleted_at IS NULL AND delete_after > clock_timestamp())
                AS evaluation_active
         FROM evaluations
        WHERE attempt_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT 2`,
      [job.attemptId],
    );
    if (existing.rows.length > 1) {
      throw new Error("multiple evaluations exist for one attempt");
    }
    const existingRow = existing.rows[0];
    if (existingRow !== undefined && !existingRow.evaluation_active) {
      throw new PrivateProviderStageUnavailableError();
    }
    const existingEvaluation = existingRow
      ? storedEvaluationBundle(existingRow)
      : undefined;
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
      ...(existingEvaluation === undefined ? {} : { existingEvaluation }),
    });
  }

  async persistEvaluation(rawBundle: EncryptedEvaluationBundleV1): Promise<{
    status: "created" | "replayed";
    evaluation: EncryptedEvaluationBundleV1;
  }> {
    const bundle = EncryptedEvaluationBundleV1Schema.parse(rawBundle);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`provider-evaluation:${bundle.attemptId}`],
      );
      const existing = await client.query<StoredEvaluationRow>(
        `SELECT evaluation.id AS evaluation_id, evaluation.attempt_id,
                evaluation.provider AS evaluation_provider,
                evaluation.model AS evaluation_model,
                evaluation.prompt_version,
                evaluation.schema_version AS evaluation_schema_version,
                evaluation.rubric_version, evaluation.recommendation,
                evaluation.encrypted_payload AS encrypted_evaluation,
                evaluation.delete_after AS evaluation_delete_after,
                (evaluation.deleted_at IS NULL
                 AND evaluation.delete_after > clock_timestamp())
                  AS evaluation_active
           FROM evaluations evaluation
           JOIN attempts attempt ON attempt.id = evaluation.attempt_id
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE evaluation.attempt_id = $1
            AND attempt.status = 'processing' AND revision.is_current = true
            AND pull_request.state = 'open' AND repository.status = 'active'
            AND installation.status = 'active'
            AND EXISTS (
              SELECT 1 FROM recording_objects recording
               WHERE recording.attempt_id = attempt.id
                 AND recording.deleted_at IS NULL
                 AND recording.delete_after > clock_timestamp()
            )
          ORDER BY evaluation.created_at ASC, evaluation.id ASC
          LIMIT 2`,
        [bundle.attemptId],
      );
      if (existing.rows.length > 1) {
        throw new Error("multiple evaluations exist for one attempt");
      }
      let status: "created" | "replayed";
      let evaluation: EncryptedEvaluationBundleV1;
      if (existing.rows[0]) {
        if (!existing.rows[0].evaluation_active) {
          throw new PrivateProviderStageUnavailableError();
        }
        status = "replayed";
        evaluation = storedEvaluationBundle(existing.rows[0]);
      } else {
        const inserted = await client.query(
          `INSERT INTO evaluations
             (id, attempt_id, provider, model, prompt_version, schema_version,
              rubric_version, encrypted_payload, recommendation, delete_after)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, recording.delete_after
             FROM attempts attempt
             JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
             JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
               AND pull_request.repository_id = attempt.repository_id
             JOIN repositories repository ON repository.id = attempt.repository_id
             JOIN installations installation ON installation.id = repository.installation_id
             JOIN recording_objects recording ON recording.attempt_id = attempt.id
            WHERE attempt.id = $2 AND attempt.status = 'processing'
              AND revision.is_current = true AND pull_request.state = 'open'
              AND repository.status = 'active' AND installation.status = 'active'
              AND recording.deleted_at IS NULL
              AND recording.delete_after > clock_timestamp()
              AND recording.delete_after = $10`,
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
        if (inserted.rowCount !== 1) {
          throw new PrivateProviderStageUnavailableError();
        }
        status = "created";
        evaluation = bundle;
      }
      await client.query("COMMIT");
      return { status, evaluation };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async schedulePersistedEvaluation(
    rawEvaluation: EncryptedEvaluationBundleV1,
    downstreamJob: JobPayload<"evaluation.apply-policy">,
  ): Promise<boolean> {
    if (this.queue === undefined) return false;
    const evaluation = EncryptedEvaluationBundleV1Schema.parse(rawEvaluation);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const eligible = await client.query(
        `SELECT evaluation.id
           FROM evaluations evaluation
           JOIN attempts attempt ON attempt.id = evaluation.attempt_id
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE evaluation.id = $1 AND evaluation.attempt_id = $2
            AND evaluation.deleted_at IS NULL
            AND evaluation.delete_after > clock_timestamp()
            AND attempt.status = 'processing' AND revision.is_current = true
            AND attempt.head_sha = $3 AND pull_request.state = 'open'
            AND repository.status = 'active' AND installation.status = 'active'
            AND EXISTS (
              SELECT 1 FROM recording_objects recording
               WHERE recording.attempt_id = attempt.id
                 AND recording.deleted_at IS NULL
                 AND recording.delete_after > clock_timestamp()
            )
          FOR UPDATE OF evaluation, attempt, revision, pull_request,
                        repository, installation`,
        [
          evaluation.evaluationId,
          evaluation.attemptId,
          downstreamJob.expectedHeadSha,
        ],
      );
      if ((eligible.rowCount ?? 0) === 0) {
        throw new PrivateProviderStageUnavailableError();
      }
      await expediteJobInPgTransaction(
        this.queue,
        client,
        "evaluation.apply-policy",
        { ...downstreamJob, evaluationId: evaluation.evaluationId },
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Rebuilds the next durable job directly from committed stage state. This is
   * intentionally independent of the finite retry count of the job that first
   * produced an artifact, so a periodic startup/runtime sweep can recover a
   * pipeline whose original pg-boss job has already exhausted its retries.
   */
  async sweepPendingProviderStages(limit = 100): Promise<number> {
    if (this.queue === undefined) return 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("provider pipeline recovery limit must be 1..1000");
    }
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<{
        attempt_id: string;
        recording_object_id: string;
        head_sha: string;
        transcript_ids: string[];
        evaluation_ids: string[];
      }>(
        `SELECT attempt.id AS attempt_id,
                recording.id AS recording_object_id,
                attempt.head_sha,
                ARRAY(
                  SELECT transcript.id
                    FROM transcripts transcript
                   WHERE transcript.attempt_id = attempt.id
                     AND transcript.deleted_at IS NULL
                     AND transcript.delete_after > clock_timestamp()
                   ORDER BY transcript.created_at, transcript.id
                ) AS transcript_ids,
                ARRAY(
                  SELECT evaluation.id
                    FROM evaluations evaluation
                   WHERE evaluation.attempt_id = attempt.id
                     AND evaluation.deleted_at IS NULL
                     AND evaluation.delete_after > clock_timestamp()
                   ORDER BY evaluation.created_at, evaluation.id
                ) AS evaluation_ids
           FROM attempts attempt
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
           JOIN recording_objects recording ON recording.attempt_id = attempt.id
          WHERE attempt.status = 'processing' AND revision.is_current = true
            AND pull_request.state = 'open' AND repository.status = 'active'
            AND installation.status = 'active' AND recording.deleted_at IS NULL
            AND recording.delete_after > clock_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM transcripts transcript
               WHERE transcript.attempt_id = attempt.id
                 AND (transcript.deleted_at IS NOT NULL
                      OR transcript.delete_after <= clock_timestamp())
            )
            AND NOT EXISTS (
              SELECT 1 FROM evaluations evaluation
               WHERE evaluation.attempt_id = attempt.id
                 AND (evaluation.deleted_at IS NOT NULL
                      OR evaluation.delete_after <= clock_timestamp())
            )
          ORDER BY attempt.updated_at, attempt.id
          LIMIT $1
          FOR UPDATE OF attempt SKIP LOCKED`,
        [limit],
      );
      for (const candidate of candidates.rows) {
        if (candidate.transcript_ids.length > 1) {
          throw new Error("multiple active transcripts exist for one attempt");
        }
        if (candidate.evaluation_ids.length > 1) {
          throw new Error("multiple active evaluations exist for one attempt");
        }
        const transcriptId = candidate.transcript_ids[0];
        const evaluationId = candidate.evaluation_ids[0];
        if (evaluationId !== undefined) {
          await expediteJobInPgTransaction(
            this.queue,
            client,
            "evaluation.apply-policy",
            {
              schemaVersion: "1",
              idempotencyKey: `provider-recovery:policy:${sha256Id(candidate.attempt_id, evaluationId)}`,
              attemptId: candidate.attempt_id,
              evaluationId,
              expectedHeadSha: candidate.head_sha,
            },
          );
        } else if (transcriptId !== undefined) {
          await expediteJobInPgTransaction(
            this.queue,
            client,
            "media.select-frames",
            {
              schemaVersion: "1",
              idempotencyKey: `provider-recovery:frames:${sha256Id(candidate.attempt_id, transcriptId)}`,
              attemptId: candidate.attempt_id,
              recordingObjectId: candidate.recording_object_id,
              transcriptId,
              expectedHeadSha: candidate.head_sha,
            },
          );
        } else {
          await expediteJobInPgTransaction(
            this.queue,
            client,
            "media.extract-transcript",
            {
              schemaVersion: "1",
              idempotencyKey: `provider-recovery:transcript:${sha256Id(candidate.attempt_id, candidate.recording_object_id)}`,
              attemptId: candidate.attempt_id,
              recordingObjectId: candidate.recording_object_id,
              expectedHeadSha: candidate.head_sha,
            },
          );
        }
      }
      await client.query("COMMIT");
      return candidates.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadEvaluationPolicy(
    job: JobPayload<"evaluation.apply-policy">,
  ): Promise<EvaluationPolicyContextV1> {
    const result = await this.database.pool.query<EvaluationRow>(
      `SELECT attempt.id AS attempt_id, attempt.revision_id,
              attempt.repository_id, attempt.head_sha, attempt.status,
              revision.is_current, pull_request.state AS pull_request_state,
              repository.status AS repository_status,
              installation.status AS installation_status,
              (evaluation.delete_after > clock_timestamp()
               AND evaluation.deleted_at IS NULL) AS retention_active,
              evaluation.id AS evaluation_id,
              evaluation.provider AS evaluation_provider,
              evaluation.model AS evaluation_model,
              evaluation.prompt_version, evaluation.schema_version AS evaluation_schema_version,
              evaluation.rubric_version, evaluation.recommendation,
              evaluation.encrypted_payload AS encrypted_evaluation,
              evaluation.delete_after AS evaluation_delete_after,
              evaluation.deleted_at AS evaluation_deleted_at,
              policy.policy
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           AND pull_request.repository_id = attempt.repository_id
         JOIN repositories repository ON repository.id = attempt.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
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
    providerErrorCode?: ProviderErrorCode;
    providerFailureTelemetry?: ProviderFailureTelemetry;
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
        pull_request_state: string;
        repository_status: string;
        installation_status: string;
      }>(
        `SELECT attempt.status, attempt.revision_id, attempt.head_sha,
                revision.is_current, pull_request.state AS pull_request_state,
                repository.status AS repository_status,
                installation.status AS installation_status
           FROM attempts attempt
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE attempt.id = $1
          FOR UPDATE OF attempt, revision, pull_request, repository, installation`,
        [input.attemptId],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.head_sha !== input.expectedHeadSha ||
        !row.is_current ||
        row.pull_request_state !== "open" ||
        row.repository_status !== "active" ||
        row.installation_status !== "active" ||
        !["processing", "review_required"].includes(row.status)
      ) {
        await client.query("ROLLBACK");
        return "stale";
      }
      if (row.status === "review_required") {
        await client.query("COMMIT");
        return "replayed";
      }
      if (input.reason === "valid_policy") {
        if (input.evaluationId === undefined) {
          throw new Error("valid policy transition requires an evaluation ID");
        }
        const evidence = await client.query(
          `SELECT evaluation.id
             FROM evaluations evaluation
             JOIN recording_objects recording
               ON recording.attempt_id = evaluation.attempt_id
            WHERE evaluation.id = $1 AND evaluation.attempt_id = $2
              AND evaluation.deleted_at IS NULL
              AND evaluation.delete_after > clock_timestamp()
              AND recording.deleted_at IS NULL
              AND recording.delete_after > clock_timestamp()
            FOR UPDATE OF evaluation, recording`,
          [input.evaluationId, input.attemptId],
        );
        if ((evidence.rowCount ?? 0) === 0) {
          await client.query("ROLLBACK");
          return "stale";
        }
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
                                    'providerRecommendation', $4::text) ||
                 CASE WHEN $5::text IS NULL THEN '{}'::jsonb ELSE
                   jsonb_build_object(
                     'providerErrorCode', $5::text,
                     'providerFailureKind', $6::text,
                     'providerHttpStatusClass', $7::text,
                     'providerTransportAttemptCount', $8::integer)
                 END)`,
        [
          input.attemptId,
          input.reason,
          input.evaluationId ?? null,
          input.providerRecommendation ?? null,
          input.providerErrorCode ?? null,
          input.providerFailureTelemetry?.lastFailureKind ?? null,
          input.providerFailureTelemetry?.httpStatusClass ?? null,
          input.providerFailureTelemetry?.transportAttemptCount ?? null,
        ],
      );
      await this.checkIntents.write(client, {
        revisionId: row.revision_id,
        headSha: row.head_sha,
        ...REVIEW_REQUIRED_GITHUB_CHECK,
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
        pull_request_state: string;
        repository_status: string;
        installation_status: string;
      }>(
        `SELECT attempt.status, attempt.revision_id, attempt.head_sha,
                revision.is_current, pull_request.state AS pull_request_state,
                repository.status AS repository_status,
                installation.status AS installation_status
           FROM attempts attempt
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE attempt.id = $1
          FOR UPDATE OF attempt, revision, pull_request, repository, installation`,
        [input.attemptId],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.head_sha !== input.expectedHeadSha ||
        !row.is_current ||
        row.pull_request_state !== "open" ||
        row.repository_status !== "active" ||
        row.installation_status !== "active" ||
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
        ...TECHNICAL_RETRY_GITHUB_CHECK,
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
