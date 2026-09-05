import { randomUUID } from "node:crypto";
import { RECORDING_CODEC } from "@understandproof/media";
import { createOpaqueEvidenceObjectKey } from "@understandproof/storage";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  InvalidRequestBodyError,
  InvalidRequestBodyEncodingError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from "../../../../../lib/bounded-body";
import {
  authErrorResponse,
  requireMutationSession,
} from "../../../../../lib/http-auth";
import { getWebRuntime } from "../../../../../lib/runtime";
import {
  consumeWebRequestRateLimit,
  createWebRequestSubjectHash,
  WebRequestRateLimitExceededError,
  webRequestRateLimitResponse,
} from "../../../../../lib/request-rate-limit";

const InputSchema = z
  .object({
    materialId: z.string().uuid(),
    objectId: z.string().uuid(),
    codec: z.literal(RECORDING_CODEC),
  })
  .strict();
const AttemptIdSchema = z.string().uuid();
const MAX_BODY_BYTES = 512;

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  let createdObject:
    { objectKey: string; providerUploadId: string } | undefined;
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const input = await readBoundedJson(request, MAX_BODY_BYTES, InputSchema);
    const attemptId = AttemptIdSchema.parse((await context.params).attemptId);
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "upload_start",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "upload_start",
        [session.actorId, session.repositoryId ?? "repository-unbound"],
      ),
    });
    const authorized = await app.database.pool.query<{
      author_id: string;
      repository_id: string;
      status: string;
      head_sha: string;
      expires_at: Date;
      is_current: boolean;
      material_id: string;
      material_object_id: string;
      usable_until: Date;
    }>(
      `SELECT attempt.author_id, attempt.repository_id, attempt.status,
              attempt.head_sha, attempt.expires_at, revision.is_current,
              material.id AS material_id,
              material.object_id AS material_object_id,
              material.usable_until
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN wrapping_materials material ON material.attempt_id = attempt.id
       WHERE attempt.id = $1 AND material.id = $2`,
      [attemptId, input.materialId],
    );
    const row = authorized.rows[0];
    const now = new Date();
    if (
      !row ||
      session.actorRole !== "author" ||
      row.author_id !== session.actorId ||
      row.repository_id !== session.repositoryId ||
      !["active", "uploading"].includes(row.status) ||
      !row.is_current ||
      row.expires_at <= now ||
      row.usable_until <= now ||
      row.material_object_id !== input.objectId
    ) {
      return NextResponse.json({ error: "upload_rejected" }, { status: 409 });
    }

    const existing = await app.database.pool.query<{
      id: string;
      object_id: string;
      state: string;
    }>(
      `SELECT id, object_id, state FROM upload_sessions WHERE attempt_id = $1`,
      [attemptId],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      if (
        row.status === "uploading" &&
        existingRow.object_id === input.objectId &&
        existingRow.state === "active"
      ) {
        return NextResponse.json({
          uploadSessionId: existingRow.id,
          objectId: existingRow.object_id,
        });
      }
      return NextResponse.json(
        { error: "upload_already_exists" },
        { status: 409 },
      );
    }
    if (row.status !== "active") {
      return NextResponse.json({ error: "upload_rejected" }, { status: 409 });
    }

    const objectKey = createOpaqueEvidenceObjectKey();
    const providerUploadId = await app.storage.createMultipartUpload(objectKey);
    createdObject = { objectKey, providerUploadId };
    const uploadSessionId = randomUUID();
    const client = await app.database.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        status: string;
        is_current: boolean;
        expires_at: Date;
      }>(
        `SELECT attempt.status, attempt.expires_at, revision.is_current
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         WHERE attempt.id = $1 FOR UPDATE OF attempt`,
        [attemptId],
      );
      const lockedRow = locked.rows[0];
      if (
        !lockedRow ||
        lockedRow.status !== "active" ||
        !lockedRow.is_current ||
        lockedRow.expires_at <= new Date()
      ) {
        throw new Error("Attempt is no longer uploadable");
      }
      await client.query(
        `INSERT INTO upload_sessions
          (id, attempt_id, object_id, object_key, provider_upload_id,
           state, next_part_number, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'active', 1, $6)`,
        [
          uploadSessionId,
          attemptId,
          input.objectId,
          objectKey,
          providerUploadId,
          row.expires_at,
        ],
      );
      await client.query(
        `INSERT INTO attempt_transitions
          (attempt_id, idempotency_key, from_status, to_status,
           expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
         VALUES ($1, $2, 'active', 'uploading', $3, $3, $4, 'author', now())`,
        [
          attemptId,
          `upload-start:${uploadSessionId}`,
          row.head_sha,
          session.actorId,
        ],
      );
      await client.query(
        "UPDATE attempts SET status = 'uploading', updated_at = now() WHERE id = $1",
        [attemptId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return NextResponse.json({
      uploadSessionId,
      objectId: input.objectId,
    });
  } catch (error) {
    if (createdObject) {
      const app = await getWebRuntime();
      await app.storage
        .abortMultipartUpload(
          createdObject.objectKey,
          createdObject.providerUploadId,
        )
        .catch(() => undefined);
    }
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
