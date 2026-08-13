import {
  MAX_ENCRYPTED_BUFFER_BYTES,
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
  ManifestPartSchema,
} from "@slopproof/media";
import {
  RepositoryPolicyV1Schema,
  resolveEffectiveRecordingLimits,
} from "@slopproof/policy";
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
import { storedUploadPartMatches } from "../../../../lib/upload-part-ledger";

const InputSchema = z
  .object({
    uploadSessionId: z.string().uuid(),
    part: ManifestPartSchema.refine(
      (part) => part.byteLength <= MAX_ENCRYPTED_BUFFER_BYTES,
      "Part exceeds the encrypted buffer bound",
    ),
    etag: z.string().min(1).max(512),
  })
  .strict();
const MAX_BODY_BYTES = 3 * 1_024;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const input = await readBoundedJson(request, MAX_BODY_BYTES, InputSchema);
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "upload_part_complete",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "upload_part_complete",
        [session.actorId, session.repositoryId ?? "repository-unbound"],
      ),
    });
    const upload = await app.database.pool.query<{
      object_key: string;
      provider_upload_id: string;
      next_part_number: number;
      upload_state: string;
      upload_expires_at: Date;
      author_id: string;
      repository_id: string;
      attempt_status: string;
      is_current: boolean;
    }>(
      `SELECT upload.object_key, upload.provider_upload_id,
              upload.next_part_number, upload.state AS upload_state,
              upload.expires_at AS upload_expires_at,
              attempt.author_id, attempt.repository_id,
              attempt.status AS attempt_status, revision.is_current
       FROM upload_sessions upload
       JOIN attempts attempt ON attempt.id = upload.attempt_id
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       WHERE upload.id = $1`,
      [input.uploadSessionId],
    );
    const row = upload.rows[0];
    if (
      !row ||
      session.actorRole !== "author" ||
      session.actorId !== row.author_id ||
      session.repositoryId !== row.repository_id ||
      row.upload_state !== "active" ||
      row.attempt_status !== "uploading" ||
      !row.is_current ||
      row.upload_expires_at <= new Date()
    ) {
      return NextResponse.json({ error: "part_rejected" }, { status: 409 });
    }
    const existing = await app.database.pool.query<{
      part_number: number;
      first_chunk_index: number;
      last_chunk_index: number;
      byte_length: string;
      sha256: string;
      etag: string;
    }>(
      `SELECT part_number, first_chunk_index, last_chunk_index, byte_length,
              sha256, etag
       FROM recording_parts WHERE upload_session_id = $1 AND part_number = $2`,
      [input.uploadSessionId, input.part.partNumber],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      const duplicate = storedUploadPartMatches(
        existingRow,
        input.part,
        input.etag,
      );
      return duplicate
        ? NextResponse.json({ accepted: true, duplicate: true })
        : NextResponse.json({ error: "part_conflict" }, { status: 409 });
    }
    if (row.next_part_number !== input.part.partNumber) {
      return NextResponse.json({ error: "part_out_of_order" }, { status: 409 });
    }
    const providerParts = await app.storage.listParts(
      row.object_key,
      row.provider_upload_id,
    );
    const providerPart = providerParts.find(
      (part) => part.partNumber === input.part.partNumber,
    );
    if (
      !providerPart ||
      providerPart.byteLength !== input.part.byteLength ||
      providerPart.etag !== input.etag
    ) {
      return NextResponse.json(
        { error: "provider_part_mismatch" },
        { status: 409 },
      );
    }
    const client = await app.database.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        next_part_number: number;
        upload_state: string;
        upload_expires_at: Date;
        attempt_status: string;
        is_current: boolean;
        acknowledged_bytes: string;
        policy: unknown;
      }>(
        `SELECT upload.next_part_number, upload.state AS upload_state,
                upload.expires_at AS upload_expires_at,
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
         WHERE upload.id = $1 FOR UPDATE OF upload, attempt`,
        [input.uploadSessionId],
      );
      const lockedRow = locked.rows[0];
      const maximumUploadBytes = lockedRow
        ? resolveEffectiveRecordingLimits(
            RepositoryPolicyV1Schema.parse(lockedRow.policy),
            {
              maximumDurationMs: MAX_RECORDING_DURATION_MS,
              maximumUploadBytes: MAX_RECORDING_OBJECT_BYTES,
            },
          ).maximumUploadBytes
        : 0;
      if (
        !lockedRow ||
        lockedRow.next_part_number !== input.part.partNumber ||
        lockedRow.upload_state !== "active" ||
        lockedRow.attempt_status !== "uploading" ||
        !lockedRow.is_current ||
        lockedRow.upload_expires_at <= new Date() ||
        Number(lockedRow.acknowledged_bytes) + input.part.byteLength >
          maximumUploadBytes
      ) {
        throw new Error("Part allocation changed while acknowledging upload");
      }
      await client.query(
        `INSERT INTO recording_parts
          (upload_session_id, part_number, first_chunk_index, last_chunk_index,
           byte_length, sha256, etag)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.uploadSessionId,
          input.part.partNumber,
          input.part.firstChunkIndex,
          input.part.lastChunkIndex,
          input.part.byteLength,
          input.part.sha256,
          input.etag,
        ],
      );
      await client.query(
        "UPDATE upload_sessions SET next_part_number = next_part_number + 1, updated_at = now() WHERE id = $1",
        [input.uploadSessionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return NextResponse.json({ accepted: true, duplicate: false });
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
