import {
  MULTIPART_TARGET_BYTES,
  MAX_PLAINTEXT_CHUNK_BYTES,
  bytesEqual,
  deriveRecordingKeys,
  encodeBase64Url,
  encryptRecordingChunk,
  packChunkRecords,
  sha256Hex,
  type RecordingManifest,
} from "@understandproof/media";
import { describe, expect, it } from "vitest";
import { streamDecryptedRecording } from "./recording-reader";

const binding = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  objectId: "22222222-2222-4222-8222-222222222222",
} as const;

async function fixture(): Promise<{
  object: Uint8Array;
  manifest: RecordingManifest;
  encryptionKey: CryptoKey;
  plaintext: Uint8Array;
}> {
  const masterKey = new Uint8Array(32).map((_, index) => index);
  const noncePrefix = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const plaintext = new TextEncoder().encode(
    "worker-only plaintext marker for streamed review",
  );
  const keys = await deriveRecordingKeys(masterKey, binding);
  masterKey.fill(0);
  const encrypted = await encryptRecordingChunk({
    plaintext,
    chunkIndex: 0,
    noncePrefix,
    binding,
    encryptionKey: keys.encryptionKey,
  });
  const manifest: RecordingManifest = {
    protocolVersion: 1,
    suiteId: "SP-RC1",
    ...binding,
    codec: "video/webm;codecs=vp8,opus",
    noncePrefixBase64url: encodeBase64Url(noncePrefix),
    wrapping: {
      materialId: "33333333-3333-4333-8333-333333333333",
      keyId: "local-test",
      algorithm: "RSA-OAEP-256",
      wrappedKeySha256: "a".repeat(64),
    },
    durationMs: 1_000,
    totalPlaintextBytes: plaintext.byteLength,
    totalObjectBytes: encrypted.record.byteLength,
    chunks: [encrypted.manifest],
    parts: [
      {
        partNumber: 1,
        firstChunkIndex: 0,
        lastChunkIndex: 0,
        byteLength: encrypted.record.byteLength,
        sha256: await sha256Hex(encrypted.record),
      },
    ],
  };
  return {
    object: encrypted.record,
    manifest,
    encryptionKey: keys.encryptionKey,
    plaintext,
  };
}

describe("worker recording reader", () => {
  it("validates framing and decrypts fragmented ciphertext into a transient sink", async () => {
    const value = await fixture();
    const output: Uint8Array[] = [];
    const object = value.object;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(object.slice(0, 13));
        controller.enqueue(object.slice(13, 41));
        controller.enqueue(object.slice(41));
        controller.close();
      },
    });

    await streamDecryptedRecording(
      stream,
      value.manifest,
      value.encryptionKey,
      async (bytes) => {
        output.push(bytes.slice());
      },
    );

    expect(new TextDecoder().decode(output[0])).toBe(
      new TextDecoder().decode(value.plaintext),
    );
    expect(new TextDecoder().decode(value.object)).not.toContain(
      "worker-only plaintext marker",
    );
  });

  it("rejects ciphertext tampering before emitting plaintext", async () => {
    const value = await fixture();
    const lastIndex = value.object.byteLength - 1;
    const lastByte = value.object[lastIndex];
    if (lastByte === undefined) throw new Error("fixture object is empty");
    value.object[lastIndex] = lastByte ^ 1;
    let writes = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(value.object);
        controller.close();
      },
    });

    await expect(
      streamDecryptedRecording(
        stream,
        value.manifest,
        value.encryptionKey,
        async () => {
          writes += 1;
        },
      ),
    ).rejects.toThrow("ciphertext part hash mismatch");
    expect(writes).toBe(0);
  });

  it("decrypts variable records split across three or more equal multipart windows", async () => {
    const masterKey = new Uint8Array(32).map((_, index) => index + 1);
    const noncePrefix = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
    const keys = await deriveRecordingKeys(masterKey, binding);
    masterKey.fill(0);
    const plaintextSizes = [
      MAX_PLAINTEXT_CHUNK_BYTES,
      MAX_PLAINTEXT_CHUNK_BYTES - 1,
      MAX_PLAINTEXT_CHUNK_BYTES - 2,
      MAX_PLAINTEXT_CHUNK_BYTES - 3,
      64,
    ];
    const plaintexts: Uint8Array[] = [];
    const records: Uint8Array[] = [];
    const chunks = [];
    for (const [index, plaintextSize] of plaintextSizes.entries()) {
      const plaintext = new Uint8Array(plaintextSize).fill(index + 1);
      const encrypted = await encryptRecordingChunk({
        plaintext,
        chunkIndex: index,
        noncePrefix,
        binding,
        encryptionKey: keys.encryptionKey,
      });
      plaintexts.push(plaintext);
      records.push(encrypted.record);
      chunks.push(encrypted.manifest);
    }
    const parts = await packChunkRecords(records);
    records.forEach((record) => record.fill(0));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    parts.slice(0, -1).forEach((part) => {
      expect(part.byteLength).toBe(MULTIPART_TARGET_BYTES);
    });

    const manifest: RecordingManifest = {
      protocolVersion: 1,
      suiteId: "SP-RC1",
      ...binding,
      codec: "video/webm;codecs=vp8,opus",
      noncePrefixBase64url: encodeBase64Url(noncePrefix),
      wrapping: {
        materialId: "33333333-3333-4333-8333-333333333333",
        keyId: "local-test",
        algorithm: "RSA-OAEP-256",
        wrappedKeySha256: "a".repeat(64),
      },
      durationMs: 1_000,
      totalPlaintextBytes: plaintextSizes.reduce(
        (total, size) => total + size,
        0,
      ),
      totalObjectBytes: parts.reduce(
        (total, part) => total + part.byteLength,
        0,
      ),
      chunks,
      parts: parts.map(({ bytes: _bytes, ...part }) => part),
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        parts.forEach((part) => controller.enqueue(part.bytes));
        controller.close();
      },
    });
    let plaintextIndex = 0;
    await streamDecryptedRecording(
      stream,
      manifest,
      keys.encryptionKey,
      async (bytes) => {
        expect(bytesEqual(bytes, plaintexts[plaintextIndex]!)).toBe(true);
        plaintextIndex += 1;
      },
    );
    expect(plaintextIndex).toBe(plaintexts.length);
    parts.forEach((part) => part.bytes.fill(0));
    plaintexts.forEach((plaintext) => plaintext.fill(0));
  }, 20_000);
});
