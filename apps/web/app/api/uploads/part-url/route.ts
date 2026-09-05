import {
  MAX_ENCRYPTED_BUFFER_BYTES,
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
  ManifestPartSchema,
} from "@understandproof/media";
import {
  RepositoryPolicyV1Schema,
  resolveEffectiveRecordingLimits,
} from "@understandproof/policy";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  InvalidRequestBodyError,
  InvalidRequestBodyEncodingError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from "../../../../lib/bounded-body";
import {
  authErrorResponse,
  requireMutationSession,
} from "../../../../lib/http-auth";
import { getWebRuntime } from "../../../../lib/runtime";
import {
  consumeWebRequestRateLimit,
  createWebRequestSubjectHash,
  WebRequestRateLimitExceededError,
  webRequestRateLimitResponse,
} from "../../../../lib/request-rate-limit";

const InputSchema = z
  .object({
    uploadSessionId: z.string().uuid(),
    part: ManifestPartSchema.refine(
      (part) => part.byteLength <= MAX_ENCRYPTED_BUFFER_BYTES,
      "Part exceeds the encrypted buffer bound",
    ),
  })
  .strict();
const MAX_BODY_BYTES = 2 * 1_024;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const input = await readBoundedJson(request, MAX_BODY_BYTES, InputSchema);
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "upload_part_url",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "upload_part_url",
        [session.actorId, session.repositoryId ?? "repository-unbound"],
      ),
    });
    const result = await app.database.pool.query<{
      object_key: string;
      provider_upload_id: string;
      next_part_number: number;
      upload_state: string;
      upload_expires_at: Date;
      author_id: string;
      repository_id: string;
      attempt_status: string;
      is_current: boolean;
      acknowledged_bytes: string;
      policy: unknown;
    }>(
      `SELECT upload.object_key, upload.provider_upload_id,
              upload.next_part_number, upload.state AS upload_state,
              upload.expires_at AS upload_expires_at,
              attempt.author_id, attempt.repository_id,
              attempt.status AS attempt_status, revision.is_current,
              repository_policy.policy,
              COALESCE((
                SELECT sum(part.byte_length) FROM recording_parts part
                WHERE part.upload_session_id = upload.id
              ), 0)::text AS acknowledged_bytes
       FROM upload_sessions upload
       JOIN attempts attempt ON attempt.id = upload.attempt_id
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
       JOIN repository_policies repository_policy
         ON repository_policy.id = proof_plan.repository_policy_id
       WHERE upload.id = $1`,
      [input.uploadSessionId],
    );
    const row = result.rows[0];
    const maximumUploadBytes = row
      ? resolveEffectiveRecordingLimits(
          RepositoryPolicyV1Schema.parse(row.policy),
          {
            maximumDurationMs: MAX_RECORDING_DURATION_MS,
            maximumUploadBytes: MAX_RECORDING_OBJECT_BYTES,
          },
        ).maximumUploadBytes
      : 0;
    if (
      !row ||
      session.actorRole !== "author" ||
      session.actorId !== row.author_id ||
      session.repositoryId !== row.repository_id ||
      row.upload_state !== "active" ||
      row.attempt_status !== "uploading" ||
      !row.is_current ||
      row.upload_expires_at <= new Date() ||
      row.next_part_number !== input.part.partNumber ||
      Number(row.acknowledged_bytes) + input.part.byteLength >
        maximumUploadBytes
    ) {
      return NextResponse.json({ error: "part_rejected" }, { status: 409 });
    }
    const expiresInSeconds = Math.min(
      5 * 60,
      Math.floor((row.upload_expires_at.getTime() - Date.now()) / 1_000),
    );
    if (expiresInSeconds < 1) {
      return NextResponse.json({ error: "part_rejected" }, { status: 409 });
    }
    const uploadUrl = await app.storage.presignUploadPart({
      objectKey: row.object_key,
      uploadId: row.provider_upload_id,
      partNumber: input.part.partNumber,
      byteLength: input.part.byteLength,
      sha256: input.part.sha256,
      expiresInSeconds,
    });
    return NextResponse.json({
      uploadUrl,
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
    });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof InvalidRequestBodyEncodingError ||
      error instanceof z.ZodError
    ) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
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
