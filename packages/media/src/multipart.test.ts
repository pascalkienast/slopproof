import { describe, expect, it } from "vitest";
import {
  MAX_ENCRYPTED_BUFFER_BYTES,
  MAX_FINALIZE_JSON_BYTES,
  MAX_PLAINTEXT_CHUNK_BYTES,
  MAX_RECORDING_CHUNKS,
  MULTIPART_TARGET_BYTES,
  MultipartPartLedger,
  MultipartRecordPacker,
  RecordingManifestSchema,
  RecordingProtocolError,
  assertFinalizeJsonLimit,
  buildChunkNonce,
  buildChunkRecord,
  encodeBase64Url,
  packChunkRecords,
  parseChunkRecordSequence,
  verifyProviderPartList,
  type RecordingManifest,
} from "./index";

const prefix = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function syntheticRecord(
  index: number,
  plaintextBytes: number,
  marker = index,
): Uint8Array {
  return buildChunkRecord({
    chunkIndex: index,
    nonce: buildChunkNonce(prefix, index),
    plaintextLength: plaintextBytes,
    sealed: new Uint8Array(plaintextBytes + 16).fill(marker & 0xff),
  });
}

function twoPartManifest(): RecordingManifest {
  const firstPlaintext = 3 * 1024 * 1024;
  const secondPlaintext = 2 * 1024 * 1024;
  const finalPlaintext = 10;
  return {
    protocolVersion: 1,
    suiteId: "SP-RC1",
    attemptId: "11111111-1111-4111-8111-111111111111",
    headSha: "a".repeat(40),
    objectId: "22222222-2222-4222-8222-222222222222",
    codec: "video/webm;codecs=vp8,opus",
    noncePrefixBase64url: encodeBase64Url(prefix),
    wrapping: {
      materialId: "33333333-3333-4333-8333-333333333333",
      keyId: "local",
      algorithm: "RSA-OAEP-256",
      wrappedKeySha256: "b".repeat(64),
    },
    durationMs: 1000,
    totalPlaintextBytes: firstPlaintext + secondPlaintext + finalPlaintext,
    totalObjectBytes:
      firstPlaintext + 48 + secondPlaintext + 48 + finalPlaintext + 48,
    chunks: [
      {
        index: 0,
        nonce: encodeBase64Url(buildChunkNonce(prefix, 0)),
        plaintextBytes: firstPlaintext,
        sealedBytes: firstPlaintext + 16,
        ciphertextSha256: "c".repeat(64),
      },
      {
        index: 1,
        nonce: encodeBase64Url(buildChunkNonce(prefix, 1)),
        plaintextBytes: secondPlaintext,
        sealedBytes: secondPlaintext + 16,
        ciphertextSha256: "d".repeat(64),
      },
      {
        index: 2,
        nonce: encodeBase64Url(buildChunkNonce(prefix, 2)),
        plaintextBytes: finalPlaintext,
        sealedBytes: finalPlaintext + 16,
        ciphertextSha256: "a".repeat(64),
      },
    ],
    parts: [
      {
        partNumber: 1,
        firstChunkIndex: 0,
        lastChunkIndex: 1,
        byteLength: firstPlaintext + 48 + secondPlaintext + 48,
        sha256: "e".repeat(64),
      },
      {
        partNumber: 2,
        firstChunkIndex: 2,
        lastChunkIndex: 2,
        byteLength: finalPlaintext + 48,
        sha256: "f".repeat(64),
      },
    ],
  };
}

describe("SP-RC1 multipart packing", () => {
  it("packs complete SPC1 records sequentially and permits only a small final part", async () => {
    const records = [
      syntheticRecord(0, MAX_PLAINTEXT_CHUNK_BYTES, 0x11),
      syntheticRecord(1, MAX_PLAINTEXT_CHUNK_BYTES, 0x22),
      syntheticRecord(2, 17, 0x33),
    ];
    const parts = await packChunkRecords(records);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      partNumber: 1,
      firstChunkIndex: 0,
      lastChunkIndex: 1,
    });
    expect(parts[0]!.byteLength).toBeGreaterThanOrEqual(MULTIPART_TARGET_BYTES);
    expect(parts[1]).toMatchObject({
      partNumber: 2,
      firstChunkIndex: 2,
      lastChunkIndex: 2,
      byteLength: 65,
    });
    expect(parseChunkRecordSequence(parts[0]!.bytes)).toHaveLength(2);
    expect(parseChunkRecordSequence(parts[1]!.bytes, 2)).toHaveLength(1);
    expect(parts[0]!.bytes.slice(0, 4)).toEqual(
      new TextEncoder().encode("SPC1"),
    );
    expect(parts[1]!.bytes.slice(0, 4)).toEqual(
      new TextEncoder().encode("SPC1"),
    );

    const incremental = new MultipartRecordPacker();
    await expect(incremental.push(records[0]!)).resolves.toEqual([]);
    const ready = await incremental.push(records[1]!);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.lastChunkIndex).toBe(1);
    await expect(incremental.push(records[2]!)).resolves.toEqual([]);
    const final = await incremental.finish();
    expect(final).toHaveLength(1);
    expect(final[0]!.firstChunkIndex).toBe(2);
    await expect(incremental.push(records[2]!)).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("makes same-number part replay idempotent but rejects different bytes", async () => {
    const [part] = await packChunkRecords([syntheticRecord(0, 32, 0x11)]);
    expect(part).toBeDefined();
    const ledger = new MultipartPartLedger();
    expect(ledger.register(part!)).toBe("accepted");
    expect(ledger.register({ ...part!, bytes: part!.bytes.slice() })).toBe(
      "duplicate",
    );

    const changed = part!.bytes.slice();
    const previousLastByte = changed.at(-1);
    if (previousLastByte === undefined) {
      throw new Error("test fixture unexpectedly empty");
    }
    changed[changed.length - 1] = previousLastByte ^ 1;
    expect(() => ledger.register({ ...part!, bytes: changed })).toThrowError(
      RecordingProtocolError,
    );
  });

  it("requires ListParts number, size and opaque ETag to match finalization", () => {
    const parts = twoPartManifest().parts;
    const receipts = [
      { partNumber: 1, etag: '"opaque-one"' },
      { partNumber: 2, etag: '"opaque-two"' },
    ];
    const provider = [
      { partNumber: 1, byteLength: parts[0]!.byteLength, etag: '"opaque-one"' },
      { partNumber: 2, byteLength: parts[1]!.byteLength, etag: '"opaque-two"' },
    ];
    expect(() =>
      verifyProviderPartList(parts, receipts, provider),
    ).not.toThrow();
    expect(() =>
      verifyProviderPartList(parts, receipts, [
        provider[0]!,
        { ...provider[1]!, byteLength: provider[1]!.byteLength + 1 },
      ]),
    ).toThrowError(RecordingProtocolError);
    expect(() =>
      verifyProviderPartList(parts, receipts, [
        provider[0]!,
        { ...provider[1]!, etag: '"different"' },
      ]),
    ).toThrowError(RecordingProtocolError);
    expect(() =>
      verifyProviderPartList(parts, receipts, [provider[0]!]),
    ).toThrowError(RecordingProtocolError);
  });
});

describe("SP-RC1 multipart and finalize limits", () => {
  it("rejects a too-small non-final part and incomplete or overlapping ranges", () => {
    const small = twoPartManifest();
    small.chunks[0] = {
      ...small.chunks[0]!,
      plaintextBytes: 10,
      sealedBytes: 26,
    };
    small.chunks[1] = {
      ...small.chunks[1]!,
      plaintextBytes: 10,
      sealedBytes: 26,
    };
    small.totalPlaintextBytes = 30;
    small.totalObjectBytes = 174;
    small.parts[0] = { ...small.parts[0]!, byteLength: 116 };
    small.parts[1] = { ...small.parts[1]!, byteLength: 58 };
    expect(() => RecordingManifestSchema.parse(small)).toThrow();

    const overlap = twoPartManifest();
    overlap.parts[1] = { ...overlap.parts[1]!, firstChunkIndex: 1 };
    expect(() => RecordingManifestSchema.parse(overlap)).toThrow();

    const missing = twoPartManifest();
    missing.parts = [missing.parts[0]!];
    expect(() => RecordingManifestSchema.parse(missing)).toThrow();
  });

  it("enforces chunk, nonce, queue and finalize JSON bounds", async () => {
    expect(() =>
      syntheticRecord(0, MAX_PLAINTEXT_CHUNK_BYTES + 1),
    ).toThrowError(RecordingProtocolError);
    expect(() => buildChunkNonce(prefix, 0x1_0000_0000)).toThrowError(
      RecordingProtocolError,
    );
    await expect(packChunkRecords([])).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    await expect(
      packChunkRecords(
        Array.from({ length: MAX_RECORDING_CHUNKS + 1 }, () =>
          syntheticRecord(0, 1),
        ),
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(
      MULTIPART_TARGET_BYTES + MAX_PLAINTEXT_CHUNK_BYTES + 48,
    ).toBeLessThan(MAX_ENCRYPTED_BUFFER_BYTES);

    expect(() => assertFinalizeJsonLimit({ small: "ok" })).not.toThrow();
    expect(() => assertFinalizeJsonLimit(undefined)).toThrowError(
      RecordingProtocolError,
    );
    expect(() =>
      assertFinalizeJsonLimit({
        oversized: "x".repeat(MAX_FINALIZE_JSON_BYTES),
      }),
    ).toThrowError(RecordingProtocolError);
    const tooManyParts = twoPartManifest();
    tooManyParts.parts = Array.from({ length: 33 }, (_, index) => ({
      ...tooManyParts.parts[0]!,
      partNumber: index + 1,
    }));
    expect(() => RecordingManifestSchema.parse(tooManyParts)).toThrow();
  });
});
