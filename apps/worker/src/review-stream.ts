import type { IncomingMessage, ServerResponse } from "node:http";
import { FinalizeRecordingSchema } from "@understandproof/media";
import type { DatabaseConnection } from "@understandproof/db";
import type { S3EvidenceStore } from "@understandproof/storage";
import {
  WorkerEvidenceCapabilityError,
  verifyWorkerEvidenceCapability,
} from "./evidence-capability";
import {
  authenticateRecordingFinalization,
  streamDecryptedRecording,
} from "./recording-reader";

const REVIEW_PATH = /^\/internal\/review\/evidence\/([0-9a-f-]{36})$/;

type ReviewEvidenceRow = {
  attempt_id: string;
  repository_id: string;
  attempt_status: string;
  head_sha: string;
  is_current: boolean;
  object_key: string;
  recording_deleted_at: Date | null;
  delete_after: Date;
  finalize_envelope: unknown;
  material_id: string;
  material_key_id: string;
  material_destroyed_at: Date | null;
};

export type ReviewStreamDependencies = {
  database: DatabaseConnection;
  storage: S3EvidenceStore;
  privateKeyPath: string;
  capabilitySecret: string;
  now?: () => Date;
  onEvent?: (event: ReviewStreamEvent) => void;
  onFailure?: (failure: ReviewStreamFailure) => void;
};

export type ReviewStreamStage =
  "capability" | "authorization" | "binding" | "key" | "storage" | "stream";

export type ReviewStreamEvent = {
  attemptId: string;
  stage: ReviewStreamStage;
  bytesExpected?: number | null;
  bytesSent?: number;
  contentTypePresent?: boolean;
  contentLengthPresent?: boolean;
  aborted?: boolean;
  httpStatus?: number;
  errorClass?: string;
};

export type ReviewStreamFailure = ReviewStreamEvent;

type EvidenceStreamAuditAction =
  "evidence.stream.started" | "evidence.stream.completed";

export async function writeEvidenceStreamAudit(
  query: (sql: string, values: string[]) => Promise<unknown>,
  input: {
    actorId: string;
    action: EvidenceStreamAuditAction;
    attemptId: string;
    capabilityJti: string;
  },
): Promise<void> {
  await query(
    `INSERT INTO audit_events
      (actor_id, action, object_type, object_id, metadata)
     VALUES ($1::text, $2::text, 'attempt', $3::text,
             jsonb_build_object('capabilityJti', $4::text))`,
    [input.actorId, input.action, input.attemptId, input.capabilityJti],
  );
}

export async function handleReviewEvidenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ReviewStreamDependencies,
): Promise<boolean> {
  const path = request.url
    ? new URL(request.url, "http://worker").pathname
    : "";
  const match = REVIEW_PATH.exec(path);
  if (!match) return false;
  if (request.method !== "GET") {
    jsonError(response, 405, "method_not_allowed");
    return true;
  }

  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (!bearer) {
    jsonError(response, 401, "capability_required");
    return true;
  }

  const now = dependencies.now?.() ?? new Date();
  const attemptId = match[1] ?? "";
  let stage: ReviewStreamStage = "capability";
  let bytesExpected: number | null = null;
  let bytesSent = 0;
  let contentTypePresent = false;
  let contentLengthPresent = false;
  const emit = (event: Partial<ReviewStreamEvent> = {}): void => {
    const payload: ReviewStreamEvent = {
      attemptId,
      stage,
      bytesExpected,
      bytesSent,
      contentTypePresent,
      contentLengthPresent,
      ...event,
    };
    dependencies.onEvent?.(payload);
    if (payload.errorClass !== undefined) {
      dependencies.onFailure?.(payload);
    }
  };
  emit();
  try {
    const capability = verifyWorkerEvidenceCapability(
      bearer,
      dependencies.capabilitySecret,
      now,
    );
    if (capability.attemptId !== attemptId) {
      throw new WorkerEvidenceCapabilityError(
        "Capability belongs to another attempt",
      );
    }

    stage = "authorization";
    const row = await authorizeAndConsumeCapability(
      capability,
      now,
      dependencies.database,
    );
    stage = "binding";
    const finalization = FinalizeRecordingSchema.parse(row.finalize_envelope);
    if (
      finalization.manifest.attemptId !== row.attempt_id ||
      finalization.manifest.headSha !== row.head_sha ||
      finalization.manifest.wrapping.materialId !== row.material_id ||
      finalization.manifest.wrapping.keyId !== row.material_key_id
    ) {
      throw new Error("Stored recording binding is invalid");
    }

    stage = "key";
    const encryptionKey = await authenticateRecordingFinalization(
      finalization,
      { materialId: row.material_id, keyId: row.material_key_id },
      dependencies.privateKeyPath,
    );
    stage = "storage";
    const head = await dependencies.storage.headObject(row.object_key);
    if (head.byteLength !== finalization.manifest.totalObjectBytes) {
      throw new Error(
        "Stored ciphertext length no longer matches its manifest",
      );
    }

    bytesExpected = finalization.manifest.totalPlaintextBytes;
    contentTypePresent = Boolean(finalization.manifest.codec);
    contentLengthPresent = true;
    response.writeHead(200, {
      "cache-control": "private, no-store, max-age=0",
      "content-disposition": "inline",
      "content-length": String(finalization.manifest.totalPlaintextBytes),
      "content-type": finalization.manifest.codec,
      "x-content-type-options": "nosniff",
    });
    stage = "stream";
    emit({ httpStatus: 200 });
    const ciphertext = await dependencies.storage.getObjectStream(
      row.object_key,
    );
    await streamDecryptedRecording(
      ciphertext,
      finalization.manifest,
      encryptionKey,
      async (plaintext) => {
        await writeResponse(response, plaintext);
        bytesSent += plaintext.byteLength;
      },
    );
    response.end();
    emit({ httpStatus: 200, aborted: false });
    await writeEvidenceStreamAudit(
      (sql, values) => dependencies.database.pool.query(sql, values),
      {
        actorId: "worker",
        action: "evidence.stream.completed",
        attemptId: row.attempt_id,
        capabilityJti: capability.jti,
      },
    );
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : "UnknownError";
    const aborted = response.headersSent && !response.writableEnded;
    const status = error instanceof WorkerEvidenceCapabilityError ? 401 : 403;
    emit({
      errorClass,
      aborted,
      httpStatus: response.headersSent ? 200 : status,
    });
    if (!response.headersSent) {
      jsonError(
        response,
        status,
        status === 401 ? "invalid_capability" : "forbidden",
      );
    } else {
      response.destroy();
    }
  }
  return true;
}

async function authorizeAndConsumeCapability(
  capability: ReturnType<typeof verifyWorkerEvidenceCapability>,
  now: Date,
  database: DatabaseConnection,
): Promise<ReviewEvidenceRow> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ReviewEvidenceRow>(
      `SELECT attempt.id AS attempt_id, attempt.repository_id,
              attempt.status AS attempt_status, attempt.head_sha,
              revision.is_current, recording.object_key,
              recording.deleted_at AS recording_deleted_at,
              recording.delete_after, upload.finalize_envelope,
              material.id AS material_id, material.key_id AS material_key_id,
              material.destroyed_at AS material_destroyed_at
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN recording_objects recording ON recording.attempt_id = attempt.id
       JOIN upload_sessions upload ON upload.attempt_id = attempt.id
       JOIN wrapping_materials material
         ON material.id = recording.wrapping_material_id
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
      row.material_destroyed_at !== null ||
      row.delete_after.getTime() <= now.getTime() ||
      row.finalize_envelope === null
    ) {
      throw new Error("Evidence is not currently reviewable");
    }
    const replay = await client.query(
      `SELECT 1 FROM audit_events
       WHERE action = 'evidence.stream.started'
         AND metadata ->> 'capabilityJti' = $1
       LIMIT 1`,
      [capability.jti],
    );
    if (replay.rowCount !== 0) {
      throw new WorkerEvidenceCapabilityError(
        "Capability has already been consumed",
      );
    }
    await writeEvidenceStreamAudit((sql, values) => client.query(sql, values), {
      actorId: capability.actorId,
      action: "evidence.stream.started",
      attemptId: row.attempt_id,
      capabilityJti: capability.jti,
    });
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function writeResponse(
  response: ServerResponse,
  bytes: Uint8Array,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    response.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

function jsonError(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: code }));
}
