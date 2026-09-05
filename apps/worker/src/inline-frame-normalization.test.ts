import { createHash } from "node:crypto";
import {
  FrameSelectionMetadataV1Schema,
  PayloadCipher,
} from "@understandproof/providers";
import { describe, expect, it, vi } from "vitest";
import { framePayloadAad } from "./frame-selection";
import {
  PrivateFrameLoadDeadlineExceededError,
  loadNormalizedInlineJudgeFrames,
} from "./inline-frame-normalization";

const ATTEMPT_ID = "70000000-0000-4000-8000-000000000001";
const FRAME_ID = "70000000-0000-4000-8000-000000000002";
const FRAME_REFERENCE = "70000000-0000-4000-8000-000000000003";

describe("inline judge frame normalization", () => {
  it("reuses the stored ciphertext key and exact frame AAD", async () => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher);
    const getObjectStream = vi.fn(async (objectKey: string) => {
      expect(objectKey).toBe(stored.objectKey);
      return streamFrom(stored.encryptedBytes);
    });

    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: stored.selection },
      { storage: { getObjectStream }, payloadCipher: cipher },
    );

    expect(result.warnings).toEqual([]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({
      id: FRAME_ID,
      timestampMs: 1_500,
      reasonCode: "transcript_alignment",
      width: 320,
      height: 180,
      mediaType: "image/jpeg",
    });
    expect(Buffer.from(result.frames[0]!.jpegBytes)).toEqual(
      Buffer.from(jpegFixture()),
    );
    expect(getObjectStream).toHaveBeenCalledTimes(1);
  });

  it("fails closed when metadata belongs to a different attempt", async () => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher);
    const getObjectStream = vi.fn();
    const result = await loadNormalizedInlineJudgeFrames(
      {
        attemptId: "70000000-0000-4000-8000-000000000099",
        frameSelection: stored.selection,
      },
      { storage: { getObjectStream }, payloadCipher: cipher },
    );
    expect(result).toEqual({
      frames: [],
      warnings: ["frame_metadata_invalid", "frames_unavailable"],
    });
    expect(getObjectStream).not.toHaveBeenCalled();
  });

  it("turns missing ciphertext into content-free warnings", async () => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher);
    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: stored.selection },
      {
        storage: {
          getObjectStream: vi.fn(async () => {
            throw new Error("private bucket/object detail");
          }),
        },
        payloadCipher: cipher,
      },
    );
    expect(result).toEqual({
      frames: [],
      warnings: ["frame_ciphertext_unavailable", "frames_unavailable"],
    });
    expect(JSON.stringify(result)).not.toContain("private bucket");
  });

  it("rejects oversized ciphertext before hashing or parsing", async () => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher);
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: stored.selection },
      {
        storage: {
          getObjectStream: vi.fn(async () => streamFrom(oversized)),
        },
        payloadCipher: cipher,
      },
    );
    expect(result.warnings).toEqual([
      "frame_ciphertext_too_large",
      "frames_unavailable",
    ]);
  });

  it("cancels the source and wipes buffered ciphertext when retention expires during a read", async () => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher);
    const deadlineAt = new Date("2026-08-13T02:00:01.000Z");
    let currentTime = new Date("2026-08-13T02:00:00.000Z");
    const emittedBytes = stored.encryptedBytes.slice();
    const cancel = vi.fn();
    let sent = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) return;
          sent = true;
          controller.enqueue(emittedBytes);
          currentTime = deadlineAt;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );

    await expect(
      loadNormalizedInlineJudgeFrames(
        {
          attemptId: ATTEMPT_ID,
          frameSelection: stored.selection,
          deadlineAt,
        },
        {
          storage: { getObjectStream: vi.fn(async () => stream) },
          payloadCipher: cipher,
          now: () => currentTime,
        },
      ),
    ).rejects.toBeInstanceOf(PrivateFrameLoadDeadlineExceededError);

    expect(cancel).toHaveBeenCalledOnce();
    expect(emittedBytes).toEqual(new Uint8Array(emittedBytes.byteLength));
  });

  it("cancels an indefinitely pending source at the absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const cipher = cipherFixture();
      const stored = encryptedFrameFixture(cipher);
      const deadlineAt = new Date("2026-08-13T02:00:01.000Z");
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ pull() {}, cancel });
      const pending = loadNormalizedInlineJudgeFrames(
        {
          attemptId: ATTEMPT_ID,
          frameSelection: stored.selection,
          deadlineAt,
        },
        {
          storage: { getObjectStream: vi.fn(async () => stream) },
          payloadCipher: cipher,
          now: () => new Date("2026-08-13T02:00:00.000Z"),
        },
      );
      const rejection = expect(pending).rejects.toBeInstanceOf(
        PrivateFrameLoadDeadlineExceededError,
      );

      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a ciphertext hash mismatch before decryption", async () => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher, {
      metadataHash: "f".repeat(64),
    });
    const decrypt = vi.spyOn(cipher, "decrypt");
    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: stored.selection },
      {
        storage: {
          getObjectStream: vi.fn(async () => streamFrom(stored.encryptedBytes)),
        },
        payloadCipher: cipher,
      },
    );
    expect(result.warnings).toContain("frame_ciphertext_hash_mismatch");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("rejects malformed versioned ciphertext envelopes", async () => {
    const cipher = cipherFixture();
    const encryptedBytes = new TextEncoder().encode("{not-json");
    const stored = encryptedFrameFixture(cipher, { encryptedBytes });
    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: stored.selection },
      {
        storage: {
          getObjectStream: vi.fn(async () => streamFrom(encryptedBytes)),
        },
        payloadCipher: cipher,
      },
    );
    expect(result.warnings).toContain("frame_ciphertext_invalid");
  });

  it("rejects frames encrypted under any other AAD", async () => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher, {
      encryptedAttemptId: "70000000-0000-4000-8000-000000000099",
    });
    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: stored.selection },
      {
        storage: {
          getObjectStream: vi.fn(async () => streamFrom(stored.encryptedBytes)),
        },
        payloadCipher: cipher,
      },
    );
    expect(result.warnings).toContain("frame_decryption_failed");
  });

  it.each([
    {
      name: "non-JPEG plaintext",
      jpeg: new TextEncoder().encode("private plaintext frame"),
      warning: "frame_jpeg_invalid",
    },
    {
      name: "wrong normalized dimensions",
      jpeg: jpegFixture(640, 360),
      warning: "frame_dimensions_invalid",
    },
  ])("rejects $name without leaking bytes", async ({ jpeg, warning }) => {
    const cipher = cipherFixture();
    const stored = encryptedFrameFixture(cipher, { jpeg });
    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: stored.selection },
      {
        storage: {
          getObjectStream: vi.fn(async () => streamFrom(stored.encryptedBytes)),
        },
        payloadCipher: cipher,
      },
    );
    expect(result.frames).toEqual([]);
    expect(result.warnings).toContain(warning);
    expect(JSON.stringify(result)).not.toContain("private plaintext");
  });

  it("sorts deterministically and caps the provider request at four frames", async () => {
    const cipher = cipherFixture();
    const timestamps = [4_000, 1_000, 3_000, 2_000, 5_000];
    const storedFrames = timestamps.map((timestampMs, index) =>
      encryptedFrameFixture(cipher, {
        frameId: uuidWithSuffix(index + 10),
        reference: uuidWithSuffix(index + 20),
        timestampMs,
      }),
    );
    const byKey = new Map(
      storedFrames.map((stored) => [stored.objectKey, stored.encryptedBytes]),
    );
    const selection = FrameSelectionMetadataV1Schema.parse({
      ...storedFrames[0]!.selection,
      frames: storedFrames.flatMap((stored) => stored.selection.frames),
    });
    const getObjectStream = vi.fn(async (key: string) => {
      const bytes = byKey.get(key);
      if (!bytes) throw new Error("unexpected key");
      return streamFrom(bytes);
    });
    const result = await loadNormalizedInlineJudgeFrames(
      { attemptId: ATTEMPT_ID, frameSelection: selection },
      { storage: { getObjectStream }, payloadCipher: cipher },
    );
    expect(result.frames.map((frame) => frame.timestampMs)).toEqual([
      1_000, 2_000, 3_000, 4_000,
    ]);
    expect(result.warnings).toEqual(["frames_truncated"]);
    expect(getObjectStream).toHaveBeenCalledTimes(4);
  });
});

function cipherFixture(): PayloadCipher {
  let nonce = 0;
  return new PayloadCipher(new Uint8Array(32).fill(7), (length) => {
    const value = new Uint8Array(length);
    value[length - 1] = ++nonce;
    return value;
  });
}

function encryptedFrameFixture(
  cipher: PayloadCipher,
  options: {
    jpeg?: Uint8Array;
    encryptedBytes?: Uint8Array;
    encryptedAttemptId?: string;
    metadataHash?: string;
    frameId?: string;
    reference?: string;
    timestampMs?: number;
  } = {},
) {
  const reference = options.reference ?? FRAME_REFERENCE;
  const encryptedBytes =
    options.encryptedBytes ??
    new TextEncoder().encode(
      JSON.stringify(
        cipher.encrypt(
          options.jpeg ?? jpegFixture(),
          framePayloadAad(options.encryptedAttemptId ?? ATTEMPT_ID, reference),
        ),
      ),
    );
  const actualHash = createHash("sha256").update(encryptedBytes).digest("hex");
  const metadataHash = options.metadataHash ?? actualHash;
  const selection = FrameSelectionMetadataV1Schema.parse({
    schemaVersion: "1",
    selectionVersion: "frame-selection-v1",
    attemptId: ATTEMPT_ID,
    recordingDurationMs: 10_000,
    frames: [
      {
        id: options.frameId ?? FRAME_ID,
        timestampMs: options.timestampMs ?? 1_500,
        reasonCode: "transcript_alignment",
        reason: "Stored transcript-aligned frame.",
        encryptedDerivativeRef: reference,
        ciphertextSha256: metadataHash,
        width: 320,
        height: 180,
      },
    ],
  });
  return {
    encryptedBytes,
    selection,
    objectKey: `provider-frame/${reference}/${metadataHash}/320x180`,
  };
}

function jpegFixture(width = 320, height = 180): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

function uuidWithSuffix(suffix: number): string {
  return `70000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}
