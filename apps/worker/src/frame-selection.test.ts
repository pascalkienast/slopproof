import { Writable } from "node:stream";
import type { DatabaseConnection } from "@slopproof/db";
import { PayloadCipher, TranscriptV1Schema } from "@slopproof/providers";
import { describe, expect, it, vi } from "vitest";
import {
  EncryptedFfmpegFrameSelectionAdapter,
  buildFrameExtractorArguments,
  framePayloadAad,
  runFrameExtractorPipeline,
} from "./frame-selection";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const RECORDING_ID = "22222222-2222-4222-8222-222222222222";
const EXISTING_FRAME_ID = "66666666-6666-4666-8666-666666666666";
const EXISTING_FRAME_KEY = `provider-frame/77777777-7777-4777-8777-777777777777/${"c".repeat(64)}/320x180`;

function transcriptFixture() {
  return TranscriptV1Schema.parse({
    schemaVersion: "1",
    transcriptVersion: "transcript-v1",
    id: "44444444-4444-4444-8444-444444444444",
    attemptId: ATTEMPT_ID,
    provider: "local-fake",
    model: "fixture-v1",
    language: "en",
    durationMs: 10_000,
    sourceSha256: "b".repeat(64),
    segments: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        startMs: 2_000,
        endMs: 8_000,
        speaker: "contributor",
        text: {
          trust: "untrusted",
          source: "transcript",
          content: "Bound answer segment",
        },
      },
    ],
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  });
}

function sourceRow() {
  return {
    attempt_id: ATTEMPT_ID,
    attempt_status: "processing",
    head_sha: "a".repeat(40),
    is_current: true,
    recording_object_id: RECORDING_ID,
    object_key: "evidence/v1/ciphertext",
    finalize_envelope: {},
    material_id: "33333333-3333-4333-8333-333333333333",
    material_key_id: "local-v1",
    recording_deleted_at: null,
    delete_after: new Date("2030-01-02T00:00:00.000Z"),
  };
}

function cipherFixture(): PayloadCipher {
  let nonce = 0;
  return new PayloadCipher(new Uint8Array(32).fill(7), (length) => {
    const value = new Uint8Array(length);
    value[length - 1] = nonce++;
    return value;
  });
}

describe("EncryptedFfmpegFrameSelectionAdapter", () => {
  it("keeps authenticating plaintext after ffmpeg closes a successful one-frame input", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    let resolveFrame: ((value: Uint8Array) => void) | undefined;
    const result = new Promise<Uint8Array>((resolve) => {
      resolveFrame = resolve;
    });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        resolveFrame?.(jpeg);
        const error = Object.assign(new Error("decoder input closed"), {
          code: "EPIPE",
        });
        callback(error);
      },
    });
    let authenticatedChunks = 0;
    const kill = vi.fn(() => true);

    await expect(
      runFrameExtractorPipeline(
        async (onPlaintext) => {
          for (let index = 0; index < 3; index += 1) {
            authenticatedChunks += 1;
            await onPlaintext(new Uint8Array([index]));
          }
        },
        { child: { kill }, stdin, result },
      ),
    ).resolves.toEqual(jpeg);

    expect(authenticatedChunks).toBe(3);
    expect(kill).not.toHaveBeenCalled();
  });

  it("uses bounded decoder resources and rejects an invalid timestamp", () => {
    expect(buildFrameExtractorArguments(1_250)).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(buildFrameExtractorArguments(1_250)).toContain("1.250");
    expect(() => buildFrameExtractorArguments(-1)).toThrow(
      "Frame extraction timestamp must be non-negative",
    );
  });

  it("stores a real extracted frame only as authenticated ciphertext", async () => {
    const operations: string[] = [];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM frame_selections")) return { rows: [] };
      if (sql.includes("INSERT INTO frame_selections")) {
        operations.push("reserve");
        return { rows: [{ id: "reserved" }], rowCount: 1 };
      }
      return { rows: [sourceRow()] };
    });
    const stored: { key?: string; bytes?: Uint8Array } = {};
    const putCiphertextObject = vi.fn(
      async (key: string, bytes: Uint8Array) => {
        operations.push("put");
        stored.key = key;
        stored.bytes = new Uint8Array(bytes);
      },
    );
    const cipher = cipherFixture();
    const marker = new TextEncoder().encode("sensitive-frame-marker");
    const jpeg = new Uint8Array([0xff, 0xd8, ...marker, 0xff, 0xd9]);
    const adapter = new EncryptedFfmpegFrameSelectionAdapter({
      database: { pool: { query } } as unknown as DatabaseConnection,
      storage: {
        getObjectStream: vi.fn(),
        headObject: vi.fn(),
        putCiphertextObject,
      },
      privateKeyPath: "/worker-only/private.pem",
      ffmpegPath: "/usr/bin/ffmpeg",
      payloadCipher: cipher,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      extractFrame: async () => new Uint8Array(jpeg),
    });
    const transcript = transcriptFixture();

    const selection = await adapter.select({
      attemptId: ATTEMPT_ID,
      recordingObjectId: RECORDING_ID,
      recordingDurationMs: 10_000,
      transcript,
    });

    expect(selection.frames).toHaveLength(1);
    expect(selection.frames[0]?.timestampMs).toBe(5_000);
    expect(operations).toEqual(["reserve", "put"]);
    expect(putCiphertextObject).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(stored.bytes)).not.toContain(
      "sensitive-frame-marker",
    );
    const reference = selection.frames[0]!.encryptedDerivativeRef;
    const decrypted = cipher.decrypt(
      JSON.parse(new TextDecoder().decode(stored.bytes)),
      framePayloadAad(ATTEMPT_ID, reference),
    );
    expect([...decrypted]).toEqual([...jpeg]);
    expect(stored.key).toMatch(
      new RegExp(`^provider-frame/${reference}/[0-9a-f]{64}/320x180$`),
    );
  });

  it("reuses a durable frame reservation after a post-upload worker crash", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: EXISTING_FRAME_ID,
          timestamp_ms: 5_000,
          reason_code: "transcript_alignment",
          object_key: EXISTING_FRAME_KEY,
        },
      ],
    }));
    const headObject = vi.fn(async () => ({ byteLength: 512 }));
    const putCiphertextObject = vi.fn();
    const extractFrame = vi.fn();
    const adapter = new EncryptedFfmpegFrameSelectionAdapter({
      database: { pool: { query } } as unknown as DatabaseConnection,
      storage: {
        getObjectStream: vi.fn(),
        headObject,
        putCiphertextObject,
      },
      privateKeyPath: "/worker-only/private.pem",
      ffmpegPath: "/usr/bin/ffmpeg",
      payloadCipher: cipherFixture(),
      extractFrame,
    });

    const selection = await adapter.select({
      attemptId: ATTEMPT_ID,
      recordingObjectId: RECORDING_ID,
      recordingDurationMs: 10_000,
      transcript: transcriptFixture(),
    });

    expect(selection.frames[0]?.id).toBe(EXISTING_FRAME_ID);
    expect(selection.frames[0]?.ciphertextSha256).toBe("c".repeat(64));
    expect(headObject).toHaveBeenCalledWith(EXISTING_FRAME_KEY);
    expect(extractFrame).not.toHaveBeenCalled();
    expect(putCiphertextObject).not.toHaveBeenCalled();
  });

  it("repairs only the exact DB reservation when its pre-upload object is absent", async () => {
    const deleted: unknown[][] = [];
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("SELECT id, timestamp_ms")) {
        return {
          rows: [
            {
              id: EXISTING_FRAME_ID,
              timestamp_ms: 5_000,
              reason_code: "transcript_alignment",
              object_key: EXISTING_FRAME_KEY,
            },
          ],
        };
      }
      if (sql.includes("DELETE FROM frame_selections")) {
        deleted.push(parameters ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO frame_selections")) {
        return { rows: [{ id: "replacement" }], rowCount: 1 };
      }
      return { rows: [sourceRow()] };
    });
    const missing = new Error("missing");
    missing.name = "NoSuchKey";
    const headObject = vi.fn(async () => {
      throw missing;
    });
    const putCiphertextObject = vi.fn();
    const adapter = new EncryptedFfmpegFrameSelectionAdapter({
      database: { pool: { query } } as unknown as DatabaseConnection,
      storage: {
        getObjectStream: vi.fn(),
        headObject,
        putCiphertextObject,
      },
      privateKeyPath: "/worker-only/private.pem",
      ffmpegPath: "/usr/bin/ffmpeg",
      payloadCipher: cipherFixture(),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      extractFrame: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });

    await expect(
      adapter.select({
        attemptId: ATTEMPT_ID,
        recordingObjectId: RECORDING_ID,
        recordingDurationMs: 10_000,
        transcript: transcriptFixture(),
      }),
    ).resolves.toBeDefined();

    expect(deleted).toEqual([
      [EXISTING_FRAME_ID, ATTEMPT_ID, EXISTING_FRAME_KEY],
    ]);
    expect(putCiphertextObject).toHaveBeenCalledOnce();
    expect(putCiphertextObject.mock.calls[0]?.[0]).not.toBe(EXISTING_FRAME_KEY);
  });

  it("keeps a reservation on transient storage errors instead of deleting a referenced frame", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: EXISTING_FRAME_ID,
          timestamp_ms: 5_000,
          reason_code: "transcript_alignment",
          object_key: EXISTING_FRAME_KEY,
        },
      ],
    }));
    const headObject = vi.fn(async () => {
      throw new Error("temporary storage outage");
    });
    const adapter = new EncryptedFfmpegFrameSelectionAdapter({
      database: { pool: { query } } as unknown as DatabaseConnection,
      storage: {
        getObjectStream: vi.fn(),
        headObject,
        putCiphertextObject: vi.fn(),
      },
      privateKeyPath: "/worker-only/private.pem",
      ffmpegPath: "/usr/bin/ffmpeg",
      payloadCipher: cipherFixture(),
    });

    await expect(
      adapter.select({
        attemptId: ATTEMPT_ID,
        recordingObjectId: RECORDING_ID,
        recordingDurationMs: 10_000,
        transcript: transcriptFixture(),
      }),
    ).rejects.toThrow("temporary storage outage");
    expect(query).toHaveBeenCalledOnce();
  });
});
