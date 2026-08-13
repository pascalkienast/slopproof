import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { DatabaseConnection } from "@slopproof/db";
import { FinalizeRecordingSchema } from "@slopproof/media";
import {
  FrameSelectionMetadataV1Schema,
  type FrameSelectionMetadataV1,
  type PayloadCipher,
  type TranscriptV1,
} from "@slopproof/providers";
import type { S3EvidenceStore } from "@slopproof/storage";
import { PrivateProviderStageUnavailableError } from "./provider-pipeline-contracts";
import type { ProviderFrameSelectionAdapter } from "./provider-pipeline";
import {
  authenticateRecordingFinalization,
  streamDecryptedRecording,
} from "./recording-reader";

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;
const MAX_JPEG_BYTES = 1024 * 1024;
const FRAME_RESERVATION_MIN_REMAINING_MS = 15 * 60_000;
const FRAME_KEY_PATTERN =
  /^provider-frame\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(\d+)x(\d+)$/;

type FrameSourceRow = {
  attempt_id: string;
  attempt_status: string;
  head_sha: string;
  is_current: boolean;
  recording_object_id: string;
  object_key: string;
  finalize_envelope: unknown;
  material_id: string;
  material_key_id: string;
  recording_deleted_at: Date | null;
  delete_after: Date;
};

type ExistingFrameReason =
  | "question_transition"
  | "answer_midpoint"
  | "transcript_alignment"
  | "quality_check";

type ExistingFrameRow = {
  id: string;
  timestamp_ms: number;
  reason_code: ExistingFrameReason;
  object_key: string;
};

type ExistingFrameEligibilityRow = {
  eligible_attempt_id: string;
  id: string | null;
  timestamp_ms: number | null;
  reason_code: ExistingFrameReason | null;
  object_key: string | null;
};

type FrameStorage = Pick<
  S3EvidenceStore,
  "getObjectStream" | "headObject" | "putCiphertextObject"
>;

type FrameExtractor = (input: {
  source: FrameSourceRow;
  timestampMs: number;
}) => Promise<Uint8Array>;

export class EncryptedFfmpegFrameSelectionAdapter implements ProviderFrameSelectionAdapter {
  constructor(
    private readonly dependencies: {
      database: DatabaseConnection;
      storage: FrameStorage;
      privateKeyPath: string;
      ffmpegPath: string;
      payloadCipher: PayloadCipher;
      now?: () => Date;
      extractFrame?: FrameExtractor;
    },
  ) {}

  async select(input: {
    attemptId: string;
    recordingObjectId: string;
    recordingDurationMs: number;
    transcript: TranscriptV1;
  }): Promise<FrameSelectionMetadataV1> {
    const existing = await this.loadExistingFrames(input, this.now());
    if (existing.length > 0) {
      return this.metadata(input, existing.map(decodeExistingFrame));
    }

    const source = await this.loadSource(input, this.now());
    const segment =
      input.transcript.segments[
        Math.floor(input.transcript.segments.length / 2)
      ];
    if (!segment) throw new Error("Transcript has no frame-alignment segment");
    const timestampMs = Math.min(
      input.recordingDurationMs - 1,
      Math.max(0, Math.floor((segment.startMs + segment.endMs) / 2)),
    );
    const extract =
      this.dependencies.extractFrame ??
      ((frameInput) => this.extractFrameWithFfmpeg(frameInput));
    const jpeg = await extract({ source, timestampMs });
    assertJpeg(jpeg);

    const reference = deterministicUuid(
      `frame-reference:${input.attemptId}:${input.recordingObjectId}:${String(timestampMs)}`,
    );
    const id = deterministicUuid(`frame-row:${reference}`);
    const aad = framePayloadAad(input.attemptId, reference);
    const envelope = this.dependencies.payloadCipher.encrypt(jpeg, aad);
    const encryptedBytes = Buffer.from(JSON.stringify(envelope), "utf8");
    const ciphertextSha256 = createHash("sha256")
      .update(encryptedBytes)
      .digest("hex");
    const objectKey = `provider-frame/${reference}/${ciphertextSha256}/${String(FRAME_WIDTH)}x${String(FRAME_HEIGHT)}`;
    try {
      // Reserve the final, hash-bound object key durably before the PUT. A
      // process crash after the PUT therefore leaves a retention-visible row,
      // never an unreferenced ciphertext object. A retry repairs a reservation
      // whose PUT never became visible in storage.
      await this.reserveFrameObject({
        source,
        id,
        timestampMs,
        objectKey,
        now: this.now(),
      });
      await this.dependencies.storage.putCiphertextObject(
        objectKey,
        encryptedBytes,
        {
          artifact: "review-frame-v1",
          attempt: input.attemptId,
        },
      );
    } finally {
      jpeg.fill(0);
      encryptedBytes.fill(0);
    }

    return this.metadata(input, [
      {
        id,
        timestampMs,
        reasonCode: "transcript_alignment" as const,
        reason: "Middle of the central transcript-aligned answer segment.",
        encryptedDerivativeRef: reference,
        ciphertextSha256,
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
      },
    ]);
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private metadata(
    input: {
      attemptId: string;
      recordingDurationMs: number;
    },
    frames: FrameSelectionMetadataV1["frames"],
  ): FrameSelectionMetadataV1 {
    return FrameSelectionMetadataV1Schema.parse({
      schemaVersion: "1",
      selectionVersion: "frame-selection-v1",
      attemptId: input.attemptId,
      recordingDurationMs: input.recordingDurationMs,
      frames,
    });
  }

  private async loadExistingFrames(
    input: { attemptId: string; recordingObjectId: string },
    now: Date,
  ): Promise<ExistingFrameRow[]> {
    const threshold = new Date(
      now.getTime() + FRAME_RESERVATION_MIN_REMAINING_MS,
    );
    const result =
      await this.dependencies.database.pool.query<ExistingFrameEligibilityRow>(
        `SELECT attempt.id AS eligible_attempt_id,
                frame.id, frame.timestamp_ms, frame.reason_code,
                frame.object_key
           FROM attempts attempt
           JOIN pull_request_revisions revision
             ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request
             ON pull_request.id = revision.pull_request_id
           JOIN repositories repository
             ON repository.id = pull_request.repository_id
            AND repository.id = attempt.repository_id
           JOIN installations installation
             ON installation.id = repository.installation_id
           JOIN recording_objects recording
             ON recording.attempt_id = attempt.id
           LEFT JOIN frame_selections frame
             ON frame.attempt_id = attempt.id
            AND frame.deleted_at IS NULL
            AND frame.delete_after = recording.delete_after
          WHERE attempt.id = $1 AND recording.id = $2
            AND attempt.status = 'processing'
            AND revision.is_current = true
            AND pull_request.state = 'open'
            AND repository.status = 'active'
            AND installation.status = 'active'
            AND recording.deleted_at IS NULL
            AND recording.delete_after > $3
          ORDER BY frame.timestamp_ms ASC, frame.id ASC`,
        [input.attemptId, input.recordingObjectId, threshold],
      );
    if (result.rows.length === 0) {
      throw new PrivateProviderStageUnavailableError();
    }
    const frames: ExistingFrameRow[] = [];
    for (const row of result.rows) {
      if (row.id === null) continue;
      if (
        row.timestamp_ms === null ||
        row.reason_code === null ||
        row.object_key === null
      ) {
        throw new PrivateProviderStageUnavailableError();
      }
      frames.push({
        id: row.id,
        timestamp_ms: row.timestamp_ms,
        reason_code: row.reason_code,
        object_key: row.object_key,
      });
    }
    const available: ExistingFrameRow[] = [];
    for (const row of frames) {
      try {
        await this.dependencies.storage.headObject(row.object_key);
        available.push(row);
      } catch (error) {
        if (!isMissingStorageTarget(error)) throw error;
        const repairThreshold = new Date(
          this.now().getTime() + FRAME_RESERVATION_MIN_REMAINING_MS,
        );
        const deleted = await this.dependencies.database.pool.query(
          `DELETE FROM frame_selections frame
            WHERE frame.id = $1 AND frame.attempt_id = $2
              AND frame.object_key = $3 AND frame.deleted_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM attempts attempt
                  JOIN pull_request_revisions revision
                    ON revision.id = attempt.revision_id
                  JOIN pull_requests pull_request
                    ON pull_request.id = revision.pull_request_id
                  JOIN repositories repository
                    ON repository.id = pull_request.repository_id
                   AND repository.id = attempt.repository_id
                  JOIN installations installation
                    ON installation.id = repository.installation_id
                  JOIN recording_objects recording
                    ON recording.attempt_id = attempt.id
                 WHERE attempt.id = $2 AND recording.id = $4
                   AND attempt.status = 'processing'
                   AND revision.is_current = true
                   AND pull_request.state = 'open'
                   AND repository.status = 'active'
                   AND installation.status = 'active'
                   AND recording.deleted_at IS NULL
                   AND recording.delete_after > $5
              )`,
          [
            row.id,
            input.attemptId,
            row.object_key,
            input.recordingObjectId,
            repairThreshold,
          ],
        );
        if (deleted.rowCount !== 1) {
          throw new PrivateProviderStageUnavailableError();
        }
      }
    }
    return available;
  }

  private async reserveFrameObject(input: {
    source: FrameSourceRow;
    id: string;
    timestampMs: number;
    objectKey: string;
    now: Date;
  }): Promise<void> {
    const reserved = await this.dependencies.database.pool.query(
      `INSERT INTO frame_selections
         (id, attempt_id, timestamp_ms, reason_code, object_key, delete_after)
       SELECT $1, attempt.id, $2, 'transcript_alignment', $3,
              recording.delete_after
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
          AND repository.id = attempt.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
        WHERE attempt.id = $4 AND attempt.status = 'processing'
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
          AND recording.id = $5 AND recording.deleted_at IS NULL
          AND recording.delete_after > $6
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.id,
        input.timestampMs,
        input.objectKey,
        input.source.attempt_id,
        input.source.recording_object_id,
        new Date(input.now.getTime() + FRAME_RESERVATION_MIN_REMAINING_MS),
      ],
    );
    if (reserved.rowCount === 1) return;

    const existing = await this.dependencies.database.pool.query(
      `SELECT 1
         FROM frame_selections frame
         JOIN attempts attempt ON attempt.id = frame.attempt_id
         JOIN pull_request_revisions revision
           ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
          AND repository.id = attempt.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
         JOIN recording_objects recording
           ON recording.attempt_id = attempt.id
        WHERE frame.id = $1 AND frame.attempt_id = $2
          AND frame.object_key = $3 AND frame.deleted_at IS NULL
          AND frame.delete_after = recording.delete_after
          AND attempt.status = 'processing'
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
          AND recording.id = $4 AND recording.deleted_at IS NULL
          AND recording.delete_after > $5`,
      [
        input.id,
        input.source.attempt_id,
        input.objectKey,
        input.source.recording_object_id,
        new Date(input.now.getTime() + FRAME_RESERVATION_MIN_REMAINING_MS),
      ],
    );
    if (existing.rowCount === 1) return;
    throw new PrivateProviderStageUnavailableError();
  }

  private async loadSource(
    input: {
      attemptId: string;
      recordingObjectId: string;
    },
    now: Date,
  ): Promise<FrameSourceRow> {
    const result = await this.dependencies.database.pool.query<FrameSourceRow>(
      `SELECT attempt.id AS attempt_id, attempt.status AS attempt_status,
              attempt.head_sha, revision.is_current,
              recording.id AS recording_object_id, recording.object_key,
              recording.deleted_at AS recording_deleted_at,
              recording.delete_after, upload.finalize_envelope,
              material.id AS material_id, material.key_id AS material_key_id
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
          AND repository.id = attempt.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
         JOIN recording_objects recording ON recording.attempt_id = attempt.id
         JOIN upload_sessions upload
           ON upload.attempt_id = attempt.id
          AND upload.object_key = recording.object_key
         JOIN wrapping_materials material
           ON material.id = recording.wrapping_material_id
        WHERE attempt.id = $1 AND recording.id = $2
          AND attempt.status = 'processing'
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
          AND recording.deleted_at IS NULL
          AND recording.delete_after > $3
          AND upload.state = 'completed'
        LIMIT 1`,
      [
        input.attemptId,
        input.recordingObjectId,
        new Date(now.getTime() + FRAME_RESERVATION_MIN_REMAINING_MS),
      ],
    );
    const row = result.rows[0];
    if (!row || row.finalize_envelope === null) {
      throw new PrivateProviderStageUnavailableError();
    }
    return row;
  }

  private async extractFrameWithFfmpeg(input: {
    source: FrameSourceRow;
    timestampMs: number;
  }): Promise<Uint8Array> {
    const finalization = FinalizeRecordingSchema.parse(
      input.source.finalize_envelope,
    );
    if (
      finalization.manifest.attemptId !== input.source.attempt_id ||
      finalization.manifest.headSha !== input.source.head_sha ||
      finalization.manifest.objectId === "" ||
      finalization.manifest.wrapping.materialId !== input.source.material_id ||
      finalization.manifest.wrapping.keyId !== input.source.material_key_id
    ) {
      throw new Error("Frame source manifest binding is invalid");
    }
    const key = await authenticateRecordingFinalization(
      finalization,
      {
        materialId: input.source.material_id,
        keyId: input.source.material_key_id,
      },
      this.dependencies.privateKeyPath,
    );
    const process = startFrameExtractor(
      this.dependencies.ffmpegPath,
      input.timestampMs,
    );
    const ciphertext = await this.dependencies.storage.getObjectStream(
      input.source.object_key,
    );
    return runFrameExtractorPipeline(
      async (onPlaintext) =>
        streamDecryptedRecording(
          ciphertext,
          finalization.manifest,
          key,
          onPlaintext,
        ),
      process,
    );
  }
}

export function framePayloadAad(attemptId: string, reference: string): string {
  return `slopproof:frame:v1:${attemptId}:${reference}`;
}

function startFrameExtractor(
  path: string,
  timestampMs: number,
): {
  child: ReturnType<typeof spawn>;
  stdin: Writable;
  result: Promise<Uint8Array>;
} {
  const child = spawn(path, buildFrameExtractorArguments(timestampMs), {
    stdio: "pipe",
    env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", LANG: "C" },
  });
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  child.stdout.on("data", (chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > MAX_JPEG_BYTES) {
      tooLarge = true;
      child.kill("SIGKILL");
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  child.stderr.resume();
  const result = new Promise<Uint8Array>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || tooLarge) {
        reject(
          new Error(
            tooLarge
              ? "Extracted frame exceeded its byte limit"
              : `ffmpeg frame extraction failed with exit code ${String(code)}`,
          ),
        );
        return;
      }
      const jpeg = Buffer.concat(chunks);
      try {
        assertJpeg(jpeg);
        resolve(new Uint8Array(jpeg));
      } catch (error) {
        reject(error);
      }
    });
  });
  return { child, stdin: child.stdin, result };
}

export async function runFrameExtractorPipeline(
  writePlaintext: (
    onPlaintext: (bytes: Uint8Array) => Promise<void>,
  ) => Promise<void>,
  process: {
    child: Pick<ReturnType<typeof spawn>, "kill">;
    stdin: Writable;
    result: Promise<Uint8Array>;
  },
): Promise<Uint8Array> {
  let acceptingInput = true;
  let stdinError: unknown;
  const onStdinError = (error: unknown) => {
    stdinError ??= error;
    acceptingInput = false;
  };
  process.stdin.on("error", onStdinError);
  const outcome = process.result.then(
    (value) => {
      acceptingInput = false;
      return { status: "fulfilled", value } as const;
    },
    (error: unknown) => {
      acceptingInput = false;
      return { status: "rejected", error } as const;
    },
  );
  try {
    await writePlaintext(async (plaintext) => {
      if (!acceptingInput) return;
      try {
        await writeAll(process.stdin, plaintext);
      } catch (error) {
        if (!isExpectedClosedDecoderInput(error)) throw error;
        stdinError ??= error;
        acceptingInput = false;
      }
    });
    if (acceptingInput) process.stdin.end();
    const settled = await outcome;
    if (settled.status === "rejected") throw settled.error;
    if (stdinError && !isExpectedClosedDecoderInput(stdinError)) {
      throw stdinError;
    }
    return settled.value;
  } catch (error) {
    process.child.kill("SIGKILL");
    await outcome;
    throw error;
  } finally {
    process.stdin.off("error", onStdinError);
  }
}

function isExpectedClosedDecoderInput(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

export function buildFrameExtractorArguments(timestampMs: number): string[] {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new Error("Frame extraction timestamp must be non-negative");
  }
  return [
    "-v",
    "error",
    "-nostdin",
    "-cpucount",
    "1",
    "-max_alloc",
    "134217728",
    "-probesize",
    "16777216",
    "-analyzeduration",
    "30000000",
    "-threads",
    "1",
    "-protocol_whitelist",
    "pipe",
    "-i",
    "pipe:0",
    "-ss",
    (timestampMs / 1_000).toFixed(3),
    "-frames:v",
    "1",
    "-vf",
    `scale=${String(FRAME_WIDTH)}:${String(FRAME_HEIGHT)}:force_original_aspect_ratio=decrease,pad=${String(FRAME_WIDTH)}:${String(FRAME_HEIGHT)}:(ow-iw)/2:(oh-ih)/2`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "5",
    "pipe:1",
  ];
}

function assertJpeg(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 4 ||
    bytes.byteLength > MAX_JPEG_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.byteLength - 2] !== 0xff ||
    bytes[bytes.byteLength - 1] !== 0xd9
  ) {
    throw new Error("Frame extractor did not return a bounded JPEG image");
  }
}

function isMissingStorageTarget(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const record = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    if (
      record.name === "NoSuchKey" ||
      record.name === "NotFound" ||
      record.code === "NoSuchKey" ||
      record.$metadata?.httpStatusCode === 404
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

function decodeExistingFrame(
  row: ExistingFrameRow,
): FrameSelectionMetadataV1["frames"][number] {
  const match = FRAME_KEY_PATTERN.exec(row.object_key);
  if (!match) throw new Error("Stored frame reference is invalid");
  const [, reference, hash, width, height] = match;
  return {
    id: row.id,
    timestampMs: row.timestamp_ms,
    reasonCode: row.reason_code,
    reason: "Previously extracted transcript-aligned review frame.",
    encryptedDerivativeRef: reference!,
    ciphertextSha256: hash!,
    width: Number(width),
    height: Number(height),
  };
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function writeAll(stream: Writable, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}
