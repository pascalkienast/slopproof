import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseConnection } from "@slopproof/db";
import {
  AuthoritativeMultimodalEvaluationV1Schema,
  PrivateReviewContextV2Schema,
  ProofEvaluationV1Schema,
  TranscriptV1Schema,
  multimodalJudgeCandidateHashV1,
  type PayloadCipher,
} from "@slopproof/providers";
import type { S3EvidenceStore } from "@slopproof/storage";
import type { PoolClient } from "pg";
import type { ZodType } from "zod";
import {
  WorkerEvidenceCapabilityError,
  verifyWorkerEvidenceCapability,
} from "./evidence-capability";
import { framePayloadAad } from "./frame-selection";
import { decryptMultimodalEvaluationSidecarV1 } from "./multimodal-evaluation-repository";

const REVIEW_CONTEXT_PATH = /^\/internal\/review\/context\/([0-9a-f-]{36})$/;
const FRAME_KEY_PATTERN =
  /^provider-frame\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(\d+)x(\d+)$/;
const MAX_ENCRYPTED_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_RESPONSE_BYTES = 8 * 1024 * 1024;
const deadlineMarker = Symbol("review-context-deadline");

type ReviewContextRow = {
  attempt_id: string;
  repository_id: string;
  revision_id: string;
  head_sha: string;
  delete_after: Date;
  transcript_id: string;
  encrypted_transcript: string;
  evaluation_id: string;
  encrypted_evaluation: string;
};

type ReviewSidecarRow = {
  sidecar_id: string;
  attempt_id: string;
  revision_id: string;
  head_sha: string;
  evaluation_id: string;
  transcript_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  evaluation_version: string;
  output_schema_version: string;
  input_hash: string;
  output_hash: string;
  encrypted_payload: unknown | null;
  provider_completed_at: Date;
  delete_after: Date;
  deleted_at: Date | null;
  created_at: Date;
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

type ReviewContextLease = {
  client: PoolClient;
  row: ReviewContextRow;
  sidecar: ReviewSidecarRow | null;
  frames: ReviewFrameRow[];
  closed: boolean;
};

type AcquiredReviewFrame = {
  frame: ReviewFrameRow;
  stream: ReadableStream<Uint8Array>;
  consumed: boolean;
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

  let lease: ReviewContextLease | undefined;
  const acquiredFrames: AcquiredReviewFrame[] = [];
  try {
    const now = dependencies.now ?? (() => new Date());
    const requestedAt = now();
    const capability = verifyWorkerEvidenceCapability(
      bearer,
      dependencies.capabilitySecret,
      requestedAt,
    );
    if (capability.attemptId !== match[1]) {
      throw new WorkerEvidenceCapabilityError(
        "Capability belongs to another attempt",
      );
    }
    lease = await authorizeAndConsumeContextCapability(
      capability,
      dependencies.database,
    );
    const accessDeadline = new Date(
      Math.min(
        lease.row.delete_after.getTime(),
        Date.parse(capability.expiresAt),
      ),
    );
    assertBeforeEvidenceDeadline(accessDeadline, now());
    for (const frame of lease.frames) {
      acquiredFrames.push({
        frame,
        stream: await acquireStreamBeforeDeadline(
          () => dependencies.storage.getObjectStream(frame.object_key),
          accessDeadline,
          now,
        ),
        consumed: false,
      });
    }
    const transcript = decryptBoundReviewPayload(
      dependencies.payloadCipher,
      lease.row.encrypted_transcript,
      transcriptPayloadAad(lease.row.attempt_id, lease.row.transcript_id),
      TranscriptV1Schema,
    );
    const compatibilityEvaluation = decryptBoundReviewPayload(
      dependencies.payloadCipher,
      lease.row.encrypted_evaluation,
      evaluationPayloadAad(lease.row.attempt_id, lease.row.evaluation_id),
      ProofEvaluationV1Schema,
    );
    const authoritativeEvaluation =
      lease.sidecar === null
        ? null
        : decryptAndValidateAuthoritativeSidecar(
            dependencies.payloadCipher,
            lease.row,
            lease.sidecar,
          );
    const frames = [];
    for (const acquired of acquiredFrames) {
      const { frame } = acquired;
      let encryptedBytes: Uint8Array | undefined;
      let jpeg: Uint8Array | undefined;
      try {
        assertBeforeEvidenceDeadline(accessDeadline, now());
        const parsed = parseFrameKey(frame.object_key);
        acquired.consumed = true;
        encryptedBytes = await readBoundedStream(
          acquired.stream,
          MAX_ENCRYPTED_FRAME_BYTES,
          accessDeadline,
          now,
        );
        const actualHash = createHash("sha256")
          .update(encryptedBytes)
          .digest("hex");
        if (actualHash !== parsed.ciphertextSha256) {
          throw new Error(
            "Encrypted review frame hash no longer matches metadata",
          );
        }
        jpeg = dependencies.payloadCipher.decrypt(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(encryptedBytes),
          ),
          framePayloadAad(lease.row.attempt_id, parsed.reference),
        );
        assertBeforeEvidenceDeadline(accessDeadline, now());
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
        jpeg?.fill(0);
        encryptedBytes?.fill(0);
      }
    }
    const context = PrivateReviewContextV2Schema.parse({
      schemaVersion: "2",
      attemptId: lease.row.attempt_id,
      transcript: {
        ...transcript,
        createdAt: transcript.createdAt.toISOString(),
      },
      compatibilityEvaluation: {
        ...compatibilityEvaluation,
        createdAt: compatibilityEvaluation.createdAt.toISOString(),
      },
      authoritativeEvaluation,
      frames,
    });
    const body = JSON.stringify(context);
    if (Buffer.byteLength(body, "utf8") > MAX_CONTEXT_RESPONSE_BYTES) {
      throw new Error("Private review context exceeded its response limit");
    }
    await assertLeaseStillActive(
      lease.client,
      lease.row.delete_after,
      capability.expiresAt,
    );
    await closeReviewContextLease(lease, true);
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
      [lease.row.attempt_id, capability.jti],
    );
  } catch (error) {
    for (const acquired of acquiredFrames) {
      if (!acquired.consumed) {
        cancelWithoutBlocking(() => acquired.stream.cancel());
      }
    }
    if (lease !== undefined && !lease.closed) {
      await closeReviewContextLease(lease, false).catch(() => undefined);
    }
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
  database: DatabaseConnection,
): Promise<ReviewContextLease> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`review-context-capability:${capability.jti}`],
    );
    const result = await client.query<ReviewContextRow>(
      `SELECT attempt.id AS attempt_id, attempt.repository_id,
              attempt.revision_id, attempt.head_sha,
              recording.delete_after, transcript.id AS transcript_id,
              transcript.encrypted_payload AS encrypted_transcript,
              evaluation.id AS evaluation_id,
              evaluation.encrypted_payload AS encrypted_evaluation
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           AND pull_request.repository_id = attempt.repository_id
         JOIN repositories repository ON repository.id = attempt.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
         JOIN transcripts transcript ON transcript.attempt_id = attempt.id
         JOIN evaluations evaluation ON evaluation.attempt_id = attempt.id
        WHERE attempt.id = $1 AND attempt.repository_id = $2
          AND attempt.status = 'review_required'
          AND revision.is_current = true
          AND revision.head_sha = attempt.head_sha
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
          AND recording.deleted_at IS NULL
          AND transcript.deleted_at IS NULL
          AND evaluation.deleted_at IS NULL
          AND attempt.evidence_delete_after = recording.delete_after
          AND transcript.delete_after = recording.delete_after
          AND evaluation.delete_after = recording.delete_after
          AND recording.delete_after > clock_timestamp()
          AND transcript.delete_after > clock_timestamp()
          AND evaluation.delete_after > clock_timestamp()
        LIMIT 2
        FOR UPDATE OF attempt, revision, pull_request, repository, installation,
                      recording, transcript, evaluation`,
      [capability.attemptId, capability.repositoryId],
    );
    if (result.rows.length !== 1) {
      throw new Error("Private review context is not currently available");
    }
    const row = result.rows[0]!;
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
    const sidecars = await client.query<ReviewSidecarRow>(
      `SELECT id AS sidecar_id, attempt_id, revision_id, head_sha,
              evaluation_id, transcript_id, provider, model, prompt_version,
              evaluation_version, output_schema_version, input_hash,
              output_hash, encrypted_payload, provider_completed_at,
              delete_after, deleted_at, created_at
         FROM multimodal_evaluation_sidecars_v1
        WHERE attempt_id = $1
        ORDER BY created_at, id
        LIMIT 2
        FOR UPDATE`,
      [capability.attemptId],
    );
    if (sidecars.rows.length > 1) {
      throw new Error(
        "Private authoritative evaluation cardinality is invalid",
      );
    }
    const sidecar = sidecars.rows[0] ?? null;
    if (sidecar !== null) assertStoredSidecarAvailability(row, sidecar);
    const frames = await client.query<ReviewFrameRow>(
      `SELECT id, timestamp_ms, reason_code, object_key
         FROM frame_selections
        WHERE attempt_id = $1 AND deleted_at IS NULL
          AND delete_after = $2 AND delete_after > clock_timestamp()
        ORDER BY timestamp_ms ASC, id ASC
        LIMIT 3
        FOR UPDATE`,
      [capability.attemptId, row.delete_after],
    );
    await client.query(
      `INSERT INTO audit_events
        (actor_id, action, object_type, object_id, metadata)
       VALUES ($1, 'evidence.context.started', 'attempt', $2,
               jsonb_build_object('capabilityJti', $3::text))`,
      [capability.actorId, row.attempt_id, capability.jti],
    );
    return {
      client,
      row,
      sidecar,
      frames: frames.rows,
      closed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    throw error;
  }
}

function transcriptPayloadAad(attemptId: string, transcriptId: string): string {
  return `slopproof:transcript:v1:${attemptId}:${transcriptId}`;
}

function evaluationPayloadAad(attemptId: string, evaluationId: string): string {
  return `slopproof:evaluation:v1:${attemptId}:${evaluationId}`;
}

function decryptBoundReviewPayload<T>(
  cipher: Pick<PayloadCipher, "decrypt">,
  encryptedPayload: string,
  associatedData: string,
  schema: ZodType<T>,
): T {
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = cipher.decrypt(JSON.parse(encryptedPayload), associatedData);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      typeof parsed.createdAt === "string"
    ) {
      return schema.parse({
        ...parsed,
        createdAt: exactIsoDate(parsed.createdAt),
      });
    }
    return schema.parse(parsed);
  } finally {
    plaintext?.fill(0);
  }
}

function decryptAndValidateAuthoritativeSidecar(
  cipher: PayloadCipher,
  row: ReviewContextRow,
  sidecar: ReviewSidecarRow,
) {
  if (sidecar.encrypted_payload === null) {
    throw new Error("Private authoritative evaluation is unavailable");
  }
  const evaluation = decryptMultimodalEvaluationSidecarV1(
    cipher,
    sidecar.encrypted_payload,
    {
      attemptId: sidecar.attempt_id,
      revisionId: sidecar.revision_id,
      headSha: sidecar.head_sha,
      evaluationId: sidecar.evaluation_id,
      transcriptId: sidecar.transcript_id,
      inputHash: sidecar.input_hash,
    },
  );
  const expectedSidecarId = deterministicUuid(
    `multimodal-sidecar-v1:${sidecar.attempt_id}:${sidecar.revision_id}:${sidecar.head_sha}:${sidecar.evaluation_id}:${sidecar.transcript_id}:${sidecar.input_hash}`,
  );
  if (
    sidecar.sidecar_id !== expectedSidecarId ||
    evaluation.attemptId !== row.attempt_id ||
    evaluation.revisionId !== row.revision_id ||
    evaluation.headSha !== row.head_sha ||
    evaluation.evaluationVersion !== sidecar.evaluation_version ||
    evaluation.invocationMetadata.provider !== sidecar.provider ||
    evaluation.invocationMetadata.model !== sidecar.model ||
    evaluation.invocationMetadata.promptVersion !== sidecar.prompt_version ||
    evaluation.invocationMetadata.outputSchemaVersion !==
      sidecar.output_schema_version ||
    evaluation.invocationMetadata.inputHash !== sidecar.input_hash ||
    evaluation.invocationMetadata.outputHash !== sidecar.output_hash ||
    evaluation.invocationMetadata.outputHash !==
      multimodalJudgeCandidateHashV1(evaluation.candidate) ||
    evaluation.invocationMetadata.completedAt.getTime() !==
      sidecar.provider_completed_at.getTime() ||
    evaluation.invocationMetadata.completedAt.getTime() >
      evaluation.createdAt.getTime() ||
    evaluation.createdAt.getTime() > sidecar.created_at.getTime() ||
    evaluation.createdAt.getTime() >= sidecar.delete_after.getTime()
  ) {
    throw new Error(
      "Private authoritative evaluation metadata is inconsistent",
    );
  }
  return AuthoritativeMultimodalEvaluationV1Schema.parse(evaluation);
}

function assertStoredSidecarAvailability(
  row: ReviewContextRow,
  sidecar: ReviewSidecarRow,
): void {
  if (
    sidecar.attempt_id !== row.attempt_id ||
    sidecar.revision_id !== row.revision_id ||
    sidecar.head_sha !== row.head_sha ||
    sidecar.evaluation_id !== row.evaluation_id ||
    sidecar.transcript_id !== row.transcript_id ||
    sidecar.delete_after.getTime() !== row.delete_after.getTime() ||
    sidecar.encrypted_payload === null ||
    sidecar.deleted_at !== null ||
    sidecar.provider_completed_at.getTime() > sidecar.created_at.getTime() ||
    sidecar.created_at.getTime() >= sidecar.delete_after.getTime()
  ) {
    throw new Error("Private authoritative evaluation is unavailable");
  }
}

async function acquireStreamBeforeDeadline(
  acquire: () => Promise<ReadableStream<Uint8Array>>,
  deadlineAt: Date,
  now: () => Date,
): Promise<ReadableStream<Uint8Array>> {
  assertBeforeEvidenceDeadline(deadlineAt, now());
  const remaining = deadlineAt.getTime() - now().getTime();
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operation = acquire().then((stream) => {
    if (expired) {
      cancelWithoutBlocking(() => stream.cancel());
      throw deadlineMarker;
    }
    return stream;
  });
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => {
            expired = true;
            reject(deadlineMarker);
          },
          Math.max(1, remaining),
        );
      }),
    ]);
  } catch (error) {
    if (error === deadlineMarker) {
      throw new Error("Private review frame acquisition exceeded its deadline");
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function assertLeaseStillActive(
  client: PoolClient,
  deleteAfter: Date,
  capabilityExpiresAt: string,
): Promise<void> {
  const result = await client.query<{ active: boolean }>(
    `SELECT ($1::timestamptz > clock_timestamp()
             AND $2::timestamptz > clock_timestamp()) AS active`,
    [deleteAfter, capabilityExpiresAt],
  );
  if (result.rows[0]?.active !== true) {
    throw new Error("Private review context expired during access");
  }
}

async function closeReviewContextLease(
  lease: ReviewContextLease,
  commit: boolean,
): Promise<void> {
  try {
    await lease.client.query(commit ? "COMMIT" : "ROLLBACK");
  } finally {
    lease.closed = true;
    lease.client.release();
  }
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
  deadlineAt: Date,
  now: () => Date,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      assertBeforeEvidenceDeadline(deadlineAt, now());
      const remaining = deadlineAt.getTime() - now().getTime();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(deadlineMarker),
              Math.max(1, remaining),
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      if (next.done) break;
      assertBeforeEvidenceDeadline(deadlineAt, now());
      total += next.value.byteLength;
      if (total > limit) throw new Error("Encrypted review frame is too large");
      chunks.push(next.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    cancelWithoutBlocking(() => reader.cancel());
    if (error === deadlineMarker) {
      throw new Error("Private review frame access exceeded its deadline");
    }
    throw error;
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}

function cancelWithoutBlocking(cancel: () => Promise<unknown>): void {
  try {
    void cancel().catch(() => undefined);
  } catch {
    // Cleanup must never delay or replace the authoritative rollback path.
  }
}

function assertBeforeEvidenceDeadline(deadlineAt: Date, now: Date): void {
  if (now.getTime() >= deadlineAt.getTime()) {
    throw new Error("Private review context exceeded its access deadline");
  }
}

function exactIsoDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Private review payload contains an invalid date");
  }
  return parsed;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256")
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
