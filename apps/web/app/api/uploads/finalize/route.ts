import {
  FinalizeRecordingSchema,
  MAX_FINALIZE_JSON_BYTES,
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
  validateProofQuestionIntervalsV1,
  verifyProviderPartList,
} from "@slopproof/media";
import {
  RepositoryPolicyV1Schema,
  calculateEvidenceDeleteAfter,
  resolveEffectiveRecordingLimits,
} from "@slopproof/policy";
import {
  persistPendingUploadFinalization,
  UploadFinalizationConflictError,
} from "@slopproof/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  requireMutationSession,
} from "../../../../lib/http-auth";
import {
  InvalidRequestBodyError,
  InvalidRequestBodyEncodingError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from "../../../../lib/bounded-body";
import { getWebRuntime } from "../../../../lib/runtime";
import {
  storedUploadPartMatches,
  type StoredUploadPart,
} from "../../../../lib/upload-part-ledger";
import { classifyUploadFinalization } from "./finalization-state";
import {
  consumeWebRequestRateLimit,
  createWebRequestSubjectHash,
  WebRequestRateLimitExceededError,
  webRequestRateLimitResponse,
} from "../../../../lib/request-rate-limit";

const RequestSchema = z
  .object({
    uploadSessionId: z.string().uuid(),
    finalization: FinalizeRecordingSchema,
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const input = await readBoundedJson(
      request,
      MAX_FINALIZE_JSON_BYTES,
      RequestSchema,
    );
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "upload_finalize",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "upload_finalize",
        [session.actorId, session.repositoryId ?? "repository-unbound"],
      ),
    });
    const finalization = input.finalization;
    const upload = await app.database.pool.query<{
      object_key: string;
      provider_upload_id: string;
      object_id: string;
      upload_state: string;
      upload_expires_at: Date;
      author_id: string;
      repository_id: string;
      pull_request_state: string;
      repository_status: string;
      installation_status: string;
      proof_plan_id: string;
      attempt_id: string;
      attempt_status: string;
      head_sha: string;
      is_current: boolean;
      material_id: string;
      key_id: string;
      algorithm: string;
      manifest_digest: string | null;
      evidence_delete_after: Date | null;
      policy: unknown;
    }>(
      `SELECT upload.object_key, upload.provider_upload_id, upload.object_id,
              upload.state AS upload_state, upload.manifest_digest,
              upload.expires_at AS upload_expires_at, attempt.author_id,
              attempt.repository_id, attempt.proof_plan_id,
              pull_request.state AS pull_request_state,
              repository.status AS repository_status,
              installation.status AS installation_status,
              attempt.id AS attempt_id,
              attempt.status AS attempt_status, attempt.head_sha,
              attempt.evidence_delete_after,
              revision.is_current, material.id AS material_id,
              material.key_id, material.algorithm, repository_policy.policy
       FROM upload_sessions upload
       JOIN attempts attempt ON attempt.id = upload.attempt_id
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
         AND pull_request.repository_id = attempt.repository_id
       JOIN repositories repository ON repository.id = attempt.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
       JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
       JOIN repository_policies repository_policy
         ON repository_policy.id = proof_plan.repository_policy_id
       JOIN wrapping_materials material
         ON material.attempt_id = attempt.id AND material.object_id = upload.object_id
       WHERE upload.id = $1`,
      [input.uploadSessionId],
    );
    const row = upload.rows[0];
    const manifest = finalization.manifest;
    const limits = row
      ? resolveEffectiveRecordingLimits(
          RepositoryPolicyV1Schema.parse(row.policy),
          {
            maximumDurationMs: MAX_RECORDING_DURATION_MS,
            maximumUploadBytes: MAX_RECORDING_OBJECT_BYTES,
          },
        )
      : undefined;
    const disposition = row
      ? classifyUploadFinalization(
          {
            uploadState: row.upload_state,
            attemptStatus: row.attempt_status,
            uploadExpiresAt: row.upload_expires_at,
            storedManifestDigest: row.manifest_digest,
          },
          finalization.manifestDigest,
          new Date(),
        )
      : "reject";
    if (
      !row ||
      session.actorRole !== "author" ||
      session.actorId !== row.author_id ||
      session.repositoryId !== row.repository_id ||
      disposition === "reject" ||
      !row.is_current ||
      row.pull_request_state !== "open" ||
      row.repository_status !== "active" ||
      row.installation_status !== "active" ||
      manifest.attemptId !== row.attempt_id ||
      manifest.headSha !== row.head_sha ||
      manifest.objectId !== row.object_id ||
      manifest.wrapping.materialId !== row.material_id ||
      manifest.wrapping.keyId !== row.key_id ||
      manifest.wrapping.algorithm !== row.algorithm ||
      !limits ||
      manifest.durationMs > limits.maximumDurationMs ||
      manifest.totalObjectBytes > limits.maximumUploadBytes
    ) {
      return NextResponse.json(
        { error: "finalization_rejected" },
        { status: 409 },
      );
    }
    let questionIntervals;
    if (manifest.questionIntervals !== undefined) {
      const storedQuestions = await app.database.pool.query<{ id: string }>(
        `SELECT id FROM proof_questions
          WHERE proof_plan_id = $1 AND required = true
          ORDER BY ordinal ASC`,
        [row.proof_plan_id],
      );
      try {
        questionIntervals = validateProofQuestionIntervalsV1({
          intervals: manifest.questionIntervals,
          expectedQuestionIds: storedQuestions.rows.map(
            (question) => question.id,
          ),
          recordingDurationMs: manifest.durationMs,
        });
      } catch {
        return NextResponse.json(
          { error: "question_intervals_rejected" },
          { status: 409 },
        );
      }
    } else if (disposition === "fresh") {
      return NextResponse.json(
        { error: "question_intervals_rejected" },
        { status: 409 },
      );
    }
    if (disposition === "fresh") {
      const providerParts = await app.storage.listParts(
        row.object_key,
        row.provider_upload_id,
      );
      verifyProviderPartList(
        manifest.parts,
        finalization.uploadedParts,
        providerParts,
      );
      const stored = await app.database.pool.query<StoredUploadPart>(
        `SELECT part_number, first_chunk_index, last_chunk_index, byte_length,
                sha256, etag
         FROM recording_parts WHERE upload_session_id = $1 ORDER BY part_number`,
        [input.uploadSessionId],
      );
      if (
        stored.rows.length !== manifest.parts.length ||
        stored.rows.some((part, index) => {
          const expected = manifest.parts[index];
          const receipt = finalization.uploadedParts[index];
          return (
            !expected ||
            !receipt ||
            !storedUploadPartMatches(part, expected, receipt.etag)
          );
        })
      ) {
        return NextResponse.json(
          { error: "part_ledger_mismatch" },
          { status: 409 },
        );
      }
    }
    const envelope = JSON.parse(JSON.stringify(finalization)) as Record<
      string,
      unknown
    >;
    const persisted = await persistPendingUploadFinalization(
      app.database.db,
      app.jobQueue,
      {
        uploadSessionId: input.uploadSessionId,
        attemptId: row.attempt_id,
        expectedHeadSha: row.head_sha,
        manifestDigest: finalization.manifestDigest,
        finalizeEnvelope: envelope,
        actorId: session.actorId,
        idempotencyKey: `upload-finalize:${finalization.manifestDigest}`,
        evidenceDeleteAfter:
          row.evidence_delete_after ??
          calculateEvidenceDeleteAfter(new Date(), limits.retentionHours),
        ...(questionIntervals === undefined
          ? {}
          : {
              questionIntervals,
              recordingDurationMs: manifest.durationMs,
            }),
      },
    );
    return NextResponse.json({ accepted: true, replay: persisted.replay });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    if (error instanceof UploadFinalizationConflictError) {
      return NextResponse.json(
        { error: "finalization_conflict" },
        { status: 409 },
      );
    }
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof InvalidRequestBodyEncodingError
    ) {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid_finalization" },
        { status: 400 },
      );
    }
    if (error instanceof WebRequestRateLimitExceededError) {
      return webRequestRateLimitResponse(error);
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
