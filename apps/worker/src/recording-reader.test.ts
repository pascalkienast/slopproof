import {
  deriveRecordingKeys,
  encodeBase64Url,
  encryptRecordingChunk,
  sha256Hex,
  type RecordingManifest,
} from "@slopproof/media";
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
});
