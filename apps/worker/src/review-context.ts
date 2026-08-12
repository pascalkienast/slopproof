import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseConnection } from "@slopproof/db";
import {
  PrivateReviewContextV1Schema,
  ProofEvaluationV1Schema,
  TranscriptV1Schema,
  type PayloadCipher,
} from "@slopproof/providers";
import type { S3EvidenceStore } from "@slopproof/storage";
import {
  WorkerEvidenceCapabilityError,
  verifyWorkerEvidenceCapability,
} from "./evidence-capability";
import { framePayloadAad } from "./frame-selection";
import { decryptVersionedProviderPayload } from "./provider-pipeline";

const REVIEW_CONTEXT_PATH = /^\/internal\/review\/context\/([0-9a-f-]{36})$/;
const FRAME_KEY_PATTERN =
  /^provider-frame\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(\d+)x(\d+)$/;
const MAX_ENCRYPTED_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_RESPONSE_BYTES = 8 * 1024 * 1024;

type ReviewContextRow = {
  attempt_id: string;
  repository_id: string;
  attempt_status: string;
  is_current: boolean;
  recording_deleted_at: Date | null;
  delete_after: Date;
  transcript_id: string;
  encrypted_transcript: string;
  evaluation_id: string;
  encrypted_evaluation: string;
};

type ReviewFrameRow = {
  id: string;
  timestamp_ms: number;
  reason_code:
    | "question_transition"
    | "answer_midpoint"
    | "transcript_alignment"
    | "quality_check";
  object_key: string;
};

export type ReviewContextDependencies = {
  database: DatabaseConnection;
  storage: Pick<S3EvidenceStore, "getObjectStream">;
  payloadCipher: PayloadCipher;
  capabilitySecret: string;
  now?: () => Date;
};

export async function handleReviewContextRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ReviewContextDependencies,
): Promise<boolean> {
  const path = request.url
    ? new URL(request.url, "http://worker").pathname
    : "";
  const match = REVIEW_CONTEXT_PATH.exec(path);
  if (!match) return false;
  if (request.method !== "GET") {
    jsonError(response, 405, "method_not_allowed");
    return true;
  }
  const bearer = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice("Bearer ".length)
    : undefined;
  if (!bearer) {
    jsonError(response, 401, "capability_required");
    return true;
  }

  try {
    const now = dependencies.now?.() ?? new Date();
    const capability = verifyWorkerEvidenceCapability(
      bearer,
      dependencies.capabilitySecret,
      now,
    );
    if (capability.attemptId !== match[1]) {
      throw new WorkerEvidenceCapabilityError(
        "Capability belongs to another attempt",
      );
    }
    const authorized = await authorizeAndConsumeContextCapability(
      capability,
      now,
      dependencies.database,
    );
    const transcript = decryptVersionedProviderPayload(
      dependencies.payloadCipher,
      authorized.row.encrypted_transcript,
      transcriptPayloadAad(
        authorized.row.attempt_id,
        authorized.row.transcript_id,
      ),
      TranscriptV1Schema,
    );
    const evaluation = decryptVersionedProviderPayload(
      dependencies.payloadCipher,
      authorized.row.encrypted_evaluation,
      evaluationPayloadAad(
        authorized.row.attempt_id,
        authorized.row.evaluation_id,
      ),
      ProofEvaluationV1Schema,
    );
    const frames = [];
    for (const frame of authorized.frames) {
      const parsed = parseFrameKey(frame.object_key);
      const encryptedBytes = await readBoundedStream(
        await dependencies.storage.getObjectStream(frame.object_key),
        MAX_ENCRYPTED_FRAME_BYTES,
      );
      const actualHash = createHash("sha256")
        .update(encryptedBytes)
        .digest("hex");
      if (actualHash !== parsed.ciphertextSha256) {
        throw new Error(
          "Encrypted review frame hash no longer matches metadata",
        );
      }
      const jpeg = dependencies.payloadCipher.decrypt(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(encryptedBytes),
        ),
        framePayloadAad(authorized.row.attempt_id, parsed.reference),
      );
      try {
        assertJpeg(jpeg);
        frames.push({
          id: frame.id,
          timestampMs: frame.timestamp_ms,
          reasonCode: frame.reason_code,
          width: parsed.width,
          height: parsed.height,
          mediaType: "image/jpeg" as const,
          imageBase64: Buffer.from(jpeg).toString("base64"),
        });
      } finally {
        jpeg.fill(0);
        encryptedBytes.fill(0);
      }
    }
    const context = PrivateReviewContextV1Schema.parse({
      schemaVersion: "1",
      attemptId: authorized.row.attempt_id,
      transcript: {
        ...transcript,
        createdAt: transcript.createdAt.toISOString(),
      },
      evaluation: {
        ...evaluation,
        createdAt: evaluation.createdAt.toISOString(),
      },
      frames,
    });
    const body = JSON.stringify(context);
    if (Buffer.byteLength(body, "utf8") > MAX_CONTEXT_RESPONSE_BYTES) {
      throw new Error("Private review context exceeded its response limit");
    }
    response.writeHead(200, {
      "cache-control": "private, no-store, max-age=0",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
      "x-content-type-options": "nosniff",
    });
    response.end(body);
    await dependencies.database.pool.query(
      `INSERT INTO audit_events
        (actor_id, action, object_type, object_id, metadata)
       VALUES ('worker', 'evidence.context.completed', 'attempt', $1,
               jsonb_build_object('capabilityJti', $2::text))`,
      [authorized.row.attempt_id, capability.jti],
    );
  } catch (error) {
    const status = error instanceof WorkerEvidenceCapabilityError ? 401 : 403;
    jsonError(
      response,
      status,
      status === 401 ? "invalid_capability" : "forbidden",
    );
  }
  return true;
}

async function authorizeAndConsumeContextCapability(
  capability: ReturnType<typeof verifyWorkerEvidenceCapability>,
  now: Date,
  database: DatabaseConnection,
): Promise<{ row: ReviewContextRow; frames: ReviewFrameRow[] }> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ReviewContextRow>(
      `SELECT attempt.id AS attempt_id, attempt.repository_id,
              attempt.status AS attempt_status, revision.is_current,
              recording.deleted_at AS recording_deleted_at,
              recording.delete_after, transcript.id AS transcript_id,
              transcript.encrypted_payload AS encrypted_transcript,
              evaluation.id AS evaluation_id,
              evaluation.encrypted_payload AS encrypted_evaluation
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
         JOIN LATERAL (
           SELECT candidate.id, candidate.encrypted_payload
             FROM transcripts candidate
            WHERE candidate.attempt_id = attempt.id
              AND candidate.deleted_at IS NULL
            ORDER BY candidate.created_at DESC LIMIT 1
         ) transcript ON true
         JOIN LATERAL (
           SELECT candidate.id, candidate.encrypted_payload
             FROM evaluations candidate
            WHERE candidate.attempt_id = attempt.id
              AND candidate.deleted_at IS NULL
            ORDER BY candidate.created_at DESC LIMIT 1
         ) evaluation ON true
        WHERE attempt.id = $1
        FOR UPDATE OF attempt`,
      [capability.attemptId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.repository_id !== capability.repositoryId ||
      row.attempt_status !== "review_required" ||
      !row.is_current ||
      row.recording_deleted_at !== null ||
      row.delete_after <= now
    ) {
      throw new Error("Private review context is not currently available");
    }
    const replay = await client.query(
      `SELECT 1 FROM audit_events
        WHERE action = 'evidence.context.started'
          AND metadata ->> 'capabilityJti' = $1
        LIMIT 1`,
      [capability.jti],
    );
    if ((replay.rowCount ?? 0) !== 0) {
      throw new WorkerEvidenceCapabilityError(
        "Context capability has already been consumed",
      );
    }
    const frames = await client.query<ReviewFrameRow>(
      `SELECT id, timestamp_ms, reason_code, object_key
         FROM frame_selections
        WHERE attempt_id = $1 AND deleted_at IS NULL
        ORDER BY timestamp_ms ASC, id ASC
        LIMIT 3`,
      [capability.attemptId],
    );
    await client.query(
      `INSERT INTO audit_events
        (actor_id, action, object_type, object_id, metadata)
       VALUES ($1, 'evidence.context.started', 'attempt', $2,
               jsonb_build_object('capabilityJti', $3::text))`,
      [capability.actorId, row.attempt_id, capability.jti],
    );
    await client.query("COMMIT");
    return { row, frames: frames.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function transcriptPayloadAad(attemptId: string, transcriptId: string): string {
  return `slopproof:transcript:v1:${attemptId}:${transcriptId}`;
}

function evaluationPayloadAad(attemptId: string, evaluationId: string): string {
  return `slopproof:evaluation:v1:${attemptId}:${evaluationId}`;
}

function parseFrameKey(objectKey: string): {
  reference: string;
  ciphertextSha256: string;
  width: number;
  height: number;
} {
  const match = FRAME_KEY_PATTERN.exec(objectKey);
  if (!match) throw new Error("Stored private frame key is invalid");
  return {
    reference: match[1]!,
    ciphertextSha256: match[2]!,
    width: Number(match[3]),
    height: Number(match[4]),
  };
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new Error("Encrypted review frame is too large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function assertJpeg(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 4 ||
    bytes.byteLength > 1024 * 1024 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.byteLength - 2] !== 0xff ||
    bytes[bytes.byteLength - 1] !== 0xd9
  ) {
    throw new Error("Decrypted review frame is not a bounded JPEG");
  }
}

function jsonError(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: code }));
}
