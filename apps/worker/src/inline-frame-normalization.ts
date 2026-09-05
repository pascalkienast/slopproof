import { createHash } from "node:crypto";
import {
  FrameSelectionMetadataV1Schema,
  NormalizedInlineJudgeFrameV1Schema,
  type FrameSelectionMetadataV1,
  type NormalizedInlineJudgeFrameV1,
  type PayloadCipher,
} from "@understandproof/providers";
import { z } from "zod";
import { framePayloadAad } from "./frame-selection";

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;
const DEFAULT_MAX_FRAMES = 4;
const MAX_FRAMES = 4;
const MAX_ENCRYPTED_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_JPEG_BYTES = 512 * 1024;

export const InlineFrameNormalizationWarningV1Schema = z.enum([
  "frames_unavailable",
  "frames_truncated",
  "frame_metadata_invalid",
  "frame_ciphertext_unavailable",
  "frame_ciphertext_too_large",
  "frame_ciphertext_hash_mismatch",
  "frame_ciphertext_invalid",
  "frame_decryption_failed",
  "frame_jpeg_invalid",
  "frame_dimensions_invalid",
]);

export type InlineFrameNormalizationWarningV1 = z.infer<
  typeof InlineFrameNormalizationWarningV1Schema
>;

export const InlineFrameNormalizationResultV1Schema = z
  .object({
    frames: z.array(NormalizedInlineJudgeFrameV1Schema).max(MAX_FRAMES),
    warnings: z.array(InlineFrameNormalizationWarningV1Schema).max(10),
  })
  .strict();

export type InlineFrameNormalizationResultV1 = z.infer<
  typeof InlineFrameNormalizationResultV1Schema
>;

export type InlineFrameNormalizationDependencies = {
  storage: {
    getObjectStream(objectKey: string): Promise<ReadableStream<Uint8Array>>;
  };
  payloadCipher: Pick<PayloadCipher, "decrypt">;
  maxFrames?: number;
  now?: () => Date;
};

export class PrivateFrameLoadDeadlineExceededError extends Error {
  constructor() {
    super("Private frame loading exceeded its retention deadline");
    this.name = "PrivateFrameLoadDeadlineExceededError";
  }
}

/**
 * Loads already-normalized encrypted review derivatives for one provider call.
 * Returned JPEG bytes are ephemeral and must be zeroed by the caller after use.
 */
export async function loadNormalizedInlineJudgeFrames(
  rawInput: {
    attemptId: string;
    frameSelection: FrameSelectionMetadataV1;
    deadlineAt?: Date;
    signal?: AbortSignal;
  },
  dependencies: InlineFrameNormalizationDependencies,
): Promise<InlineFrameNormalizationResultV1> {
  const selection = FrameSelectionMetadataV1Schema.safeParse(
    rawInput.frameSelection,
  );
  if (
    !selection.success ||
    selection.data.attemptId !== rawInput.attemptId ||
    !Number.isInteger(dependencies.maxFrames ?? DEFAULT_MAX_FRAMES) ||
    (dependencies.maxFrames ?? DEFAULT_MAX_FRAMES) < 1 ||
    (dependencies.maxFrames ?? DEFAULT_MAX_FRAMES) > MAX_FRAMES
  ) {
    return {
      frames: [],
      warnings: ["frame_metadata_invalid", "frames_unavailable"],
    };
  }

  const deadline = createFrameLoadDeadline(
    rawInput.deadlineAt,
    rawInput.signal,
    dependencies.now,
  );
  const frames: NormalizedInlineJudgeFrameV1[] = [];
  try {
    const maximumFrames = dependencies.maxFrames ?? DEFAULT_MAX_FRAMES;
    assertFrameLoadBeforeDeadline(
      rawInput.deadlineAt,
      dependencies.now,
      deadline.signal,
    );
    const ordered = [...selection.data.frames].sort(
      (left, right) =>
        left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
    );
    const warnings = new Set<InlineFrameNormalizationWarningV1>();
    if (ordered.length > maximumFrames) warnings.add("frames_truncated");

    for (const frame of ordered.slice(0, maximumFrames)) {
      try {
        frames.push(
          await loadOneFrame(
            rawInput.attemptId,
            frame,
            rawInput.deadlineAt,
            deadline.signal,
            dependencies,
          ),
        );
      } catch (error) {
        if (isFrameDeadlineError(error, deadline.signal)) throw error;
        warnings.add(
          error instanceof FrameNormalizationError
            ? error.warning
            : "frame_ciphertext_unavailable",
        );
      }
    }
    if (frames.length === 0) warnings.add("frames_unavailable");
    return { frames, warnings: [...warnings] };
  } catch (error) {
    if (isFrameDeadlineError(error, deadline.signal)) {
      for (const loaded of frames) loaded.jpegBytes.fill(0);
      throw frameDeadlineError(deadline.signal);
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

async function loadOneFrame(
  attemptId: string,
  frame: FrameSelectionMetadataV1["frames"][number],
  deadlineAt: Date | undefined,
  signal: AbortSignal,
  dependencies: InlineFrameNormalizationDependencies,
): Promise<NormalizedInlineJudgeFrameV1> {
  assertFrameLoadBeforeDeadline(deadlineAt, dependencies.now, signal);
  if (frame.width !== FRAME_WIDTH || frame.height !== FRAME_HEIGHT) {
    throw new FrameNormalizationError("frame_metadata_invalid");
  }
  const objectKey = frameObjectKey(frame);
  let encryptedBytes: Uint8Array | undefined;
  let jpeg: Uint8Array | undefined;
  let keepJpeg = false;
  try {
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await dependencies.storage.getObjectStream(objectKey);
    } catch {
      throw new FrameNormalizationError("frame_ciphertext_unavailable");
    }
    encryptedBytes = await readBoundedStream(
      stream,
      MAX_ENCRYPTED_FRAME_BYTES,
      signal,
      () => assertFrameLoadBeforeDeadline(deadlineAt, dependencies.now, signal),
    );
    assertFrameLoadBeforeDeadline(deadlineAt, dependencies.now, signal);
    const actualHash = createHash("sha256")
      .update(encryptedBytes)
      .digest("hex");
    if (actualHash !== frame.ciphertextSha256) {
      throw new FrameNormalizationError("frame_ciphertext_hash_mismatch");
    }

    let envelope: unknown;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        encryptedBytes,
      );
      envelope = JSON.parse(decoded) as unknown;
    } catch {
      throw new FrameNormalizationError("frame_ciphertext_invalid");
    }
    try {
      jpeg = dependencies.payloadCipher.decrypt(
        envelope,
        framePayloadAad(attemptId, frame.encryptedDerivativeRef),
      );
    } catch {
      throw new FrameNormalizationError("frame_decryption_failed");
    }
    assertFrameLoadBeforeDeadline(deadlineAt, dependencies.now, signal);
    if (!isBoundedJpeg(jpeg)) {
      throw new FrameNormalizationError("frame_jpeg_invalid");
    }
    const dimensions = jpegDimensions(jpeg);
    if (
      dimensions?.width !== FRAME_WIDTH ||
      dimensions.height !== FRAME_HEIGHT
    ) {
      throw new FrameNormalizationError("frame_dimensions_invalid");
    }
    const normalized = NormalizedInlineJudgeFrameV1Schema.parse({
      id: frame.id,
      timestampMs: frame.timestampMs,
      reasonCode: frame.reasonCode,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      mediaType: "image/jpeg",
      jpegBytes: jpeg,
    });
    keepJpeg = true;
    return normalized;
  } finally {
    encryptedBytes?.fill(0);
    if (!keepJpeg) jpeg?.fill(0);
  }
}

function frameObjectKey(
  frame: FrameSelectionMetadataV1["frames"][number],
): string {
  return `provider-frame/${frame.encryptedDerivativeRef}/${frame.ciphertextSha256}/${String(frame.width)}x${String(frame.height)}`;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
  assertActive: () => void = () => undefined,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      assertActive();
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await readWithAbort(reader, signal);
      } catch {
        throw new FrameNormalizationError("frame_ciphertext_unavailable");
      }
      if (next.done) break;
      chunks.push(next.value);
      assertActive();
      total += next.value.byteLength;
      if (total > maximumBytes) {
        throw new FrameNormalizationError("frame_ciphertext_too_large");
      }
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may still be settling; cancellation owns its lock.
    }
    for (const chunk of chunks) chunk.fill(0);
  }
}

function assertFrameLoadBeforeDeadline(
  deadlineAt: Date | undefined,
  now: (() => Date) | undefined,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw frameDeadlineError(signal);
  if (
    deadlineAt !== undefined &&
    (now ?? (() => new Date()))().getTime() >= deadlineAt.getTime()
  ) {
    throw new PrivateFrameLoadDeadlineExceededError();
  }
}

function createFrameLoadDeadline(
  deadlineAt: Date | undefined,
  parentSignal: AbortSignal | undefined,
  now: (() => Date) | undefined,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(
      parentSignal?.reason ?? new PrivateFrameLoadDeadlineExceededError(),
    );
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (deadlineAt !== undefined && !controller.signal.aborted) {
    const delayMs = Math.max(
      0,
      deadlineAt.getTime() - (now ?? (() => new Date()))().getTime(),
    );
    timer = setTimeout(
      () => controller.abort(new PrivateFrameLoadDeadlineExceededError()),
      delayMs,
    );
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw frameDeadlineError(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const reason = frameDeadlineError(signal);
      void reader.cancel(reason).catch(() => undefined);
      reject(reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isFrameDeadlineError(error: unknown, signal: AbortSignal): boolean {
  return (
    error instanceof PrivateFrameLoadDeadlineExceededError || signal.aborted
  );
}

function frameDeadlineError(
  signal: AbortSignal,
): PrivateFrameLoadDeadlineExceededError {
  return signal.reason instanceof PrivateFrameLoadDeadlineExceededError
    ? signal.reason
    : new PrivateFrameLoadDeadlineExceededError();
}

function isBoundedJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes.byteLength <= MAX_INLINE_JPEG_BYTES &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  );
}

function jpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 1 < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      return undefined;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.byteLength) return undefined;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength - 2) {
      return undefined;
    }
    if (isStartOfFrameMarker(marker)) {
      if (segmentLength < 8) return undefined;
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function isStartOfFrameMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

class FrameNormalizationError extends Error {
  constructor(readonly warning: InlineFrameNormalizationWarningV1) {
    super("Private frame normalization failed");
  }
}
