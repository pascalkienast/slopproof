import {
  constants as nodeCryptoConstants,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PublicWrappingMaterialSchema,
  RecordingManifestSchema,
  RecordingProtocolError,
  authenticateManifest,
  buildChunkNonce,
  canonicalChunkAadBytes,
  canonicalKdfContextBytes,
  canonicalManifestBytes,
  decodeBase64Url,
  decodeHex,
  decryptRecordingChunk,
  deriveRecordingKeyMaterial,
  deriveRecordingKeys,
  encodeBase64Url,
  encodeHex,
  encryptRecordingChunk,
  parseChunkRecord,
  parseChunkRecordSequence,
  sha256Hex,
  unwrapMasterKey,
  verifyAuthenticatedManifest,
  wrapMasterKey,
  type PublicWrappingMaterial,
  type RecordingBinding,
  type RecordingManifest,
  type WrappedMasterKey,
} from "./index";

const binding: RecordingBinding = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  objectId: "22222222-2222-4222-8222-222222222222",
};
const alternateBinding: RecordingBinding = {
  attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  headSha: "b".repeat(40),
  objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const masterKey = new Uint8Array(
  Array.from({ length: 32 }, (_, index) => index),
);
const noncePrefix = decodeHex("a0a1a2a3a4a5a6a7");
const plaintext = new TextEncoder().encode("SlopProof SP-RC1 golden chunk");

const expected = {
  kdfContext:
    '["slopproof-recording-kdf",1,"11111111-1111-4111-8111-111111111111","0123456789abcdef0123456789abcdef01234567","22222222-2222-4222-8222-222222222222"]',
  encryptionKey:
    "2825517c5acc689834a8be970d52ce294d55b0cbe71f6a5bc43aeba4633a2004",
  manifestKey:
    "4d7054d4e27669206cb315793a679a23ea1155f2ad7bd8aec0faeebddde1e79c",
  nonce: "a0a1a2a3a4a5a6a700000000",
  aad: '["slopproof-recording-chunk",1,"SP-RC1","11111111-1111-4111-8111-111111111111","0123456789abcdef0123456789abcdef01234567","22222222-2222-4222-8222-222222222222","video/webm;codecs=vp8,opus",0,"oKGio6SlpqcAAAAA",29]',
  sealed:
    "15d6b4b4f3583e4ac8842e371d0582f68b26294f2a72db9b40be9222b69161e137504c286c5aae35d29c25bcde",
  record:
    "535043310100002000000000a0a1a2a3a4a5a6a7000000000000001d0000002d15d6b4b4f3583e4ac8842e371d0582f68b26294f2a72db9b40be9222b69161e137504c286c5aae35d29c25bcde",
  manifestCanonical:
    '["slopproof-recording-manifest",1,"SP-RC1","11111111-1111-4111-8111-111111111111","0123456789abcdef0123456789abcdef01234567","22222222-2222-4222-8222-222222222222","video/webm;codecs=vp8,opus","oKGio6Slpqc","33333333-3333-4333-8333-333333333333","local-2026-08","RSA-OAEP-256","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",1234,29,77,[[0,"oKGio6SlpqcAAAAA",29,45,"4ff64f62e46158150e35b16074916752cc6795d043ed84096cd10f9b1b26ca7c"]],[[1,0,0,77,"b2804840dba26733bfa1773a5e1cfeeeefac98c703608eb777a354159e228246"]]]',
  manifestDigest:
    "bbb71f482f08d2243bb9ba1fb522bba6c8150b68274688a5a37d4e763ad2feb2",
  manifestTag: "MBC5Sdqv9sw71nim62fewOcY2fKoC_O-fOFvtJQGlvc",
} as const;

const goldenManifest: RecordingManifest = {
  protocolVersion: 1,
  suiteId: "SP-RC1",
  ...binding,
  codec: "video/webm;codecs=vp8,opus",
  noncePrefixBase64url: "oKGio6Slpqc",
  wrapping: {
    materialId: "33333333-3333-4333-8333-333333333333",
    keyId: "local-2026-08",
    algorithm: "RSA-OAEP-256",
    wrappedKeySha256: "a".repeat(64),
  },
  durationMs: 1234,
  totalPlaintextBytes: 29,
  totalObjectBytes: 77,
  chunks: [
    {
      index: 0,
      nonce: "oKGio6SlpqcAAAAA",
      plaintextBytes: 29,
      sealedBytes: 45,
      ciphertextSha256:
        "4ff64f62e46158150e35b16074916752cc6795d043ed84096cd10f9b1b26ca7c",
    },
  ],
  parts: [
    {
      partNumber: 1,
      firstChunkIndex: 0,
      lastChunkIndex: 0,
      byteLength: 77,
      sha256:
        "b2804840dba26733bfa1773a5e1cfeeeefac98c703608eb777a354159e228246",
    },
  ],
};

function cloneManifest(): RecordingManifest {
  return structuredClone(goldenManifest);
}

describe("SP-RC1 golden vectors", () => {
  it("derives the exact KDF, nonce, AAD, ciphertext and SPC1 record bytes", async () => {
    expect(new TextDecoder().decode(canonicalKdfContextBytes(binding))).toBe(
      expected.kdfContext,
    );
    const material = await deriveRecordingKeyMaterial(masterKey, binding);
    expect(encodeHex(material.encryptionKeyBytes)).toBe(expected.encryptionKey);
    expect(encodeHex(material.manifestKeyBytes)).toBe(expected.manifestKey);
    expect(encodeHex(buildChunkNonce(noncePrefix, 0))).toBe(expected.nonce);
    expect(
      new TextDecoder().decode(
        canonicalChunkAadBytes({
          ...binding,
          codec: "video/webm;codecs=vp8,opus",
          chunkIndex: 0,
          nonceBase64url: "oKGio6SlpqcAAAAA",
          plaintextBytes: plaintext.byteLength,
        }),
      ),
    ).toBe(expected.aad);

    const keys = await deriveRecordingKeys(masterKey, binding);
    const encrypted = await encryptRecordingChunk({
      plaintext,
      chunkIndex: 0,
      noncePrefix,
      binding,
      encryptionKey: keys.encryptionKey,
    });
    expect(encodeHex(encrypted.sealed)).toBe(expected.sealed);
    expect(encodeHex(encrypted.record)).toBe(expected.record);
    expect(
      new TextDecoder().decode(
        await decryptRecordingChunk({
          record: encrypted.record,
          expectedChunkIndex: 0,
          expectedNoncePrefix: noncePrefix,
          binding,
          encryptionKey: keys.encryptionKey,
        }),
      ),
    ).toBe("SlopProof SP-RC1 golden chunk");
  });

  it("reconstructs exact canonical manifest, digest and HMAC bytes", async () => {
    const keys = await deriveRecordingKeys(masterKey, binding);
    expect(
      new TextDecoder().decode(canonicalManifestBytes(goldenManifest)),
    ).toBe(expected.manifestCanonical);
    const authenticated = await authenticateManifest(
      goldenManifest,
      keys.manifestKey,
    );
    expect(authenticated.manifestDigest).toBe(expected.manifestDigest);
    expect(authenticated.manifestTagBase64url).toBe(expected.manifestTag);
    await expect(
      verifyAuthenticatedManifest(authenticated, keys.manifestKey),
    ).resolves.toEqual(goldenManifest);
  });
});

describe("SP-RC1 validation and authentication", () => {
  it("uses strict schemas and canonical normal forms", () => {
    expect(() =>
      RecordingManifestSchema.parse({ ...goldenManifest, unexpected: true }),
    ).toThrow();
    expect(() =>
      RecordingManifestSchema.parse({
        ...goldenManifest,
        attemptId: "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF",
      }),
    ).toThrow();
    expect(() =>
      RecordingManifestSchema.parse({
        ...goldenManifest,
        headSha: "A".repeat(40),
      }),
    ).toThrow();
    expect(() => decodeBase64Url("AA==")).toThrow(RecordingProtocolError);
    expect(() => decodeBase64Url("A")).toThrow(RecordingProtocolError);
    expect(encodeBase64Url(decodeBase64Url("oKGio6Slpqc"))).toBe("oKGio6Slpqc");
  });

  it("rejects duplicate, missing and inconsistent manifest ranges and limits", () => {
    const duplicate = cloneManifest();
    duplicate.chunks.push({ ...duplicate.chunks[0]!, index: 0 });
    expect(() => RecordingManifestSchema.parse(duplicate)).toThrow();

    const gap = cloneManifest();
    gap.chunks[0] = { ...gap.chunks[0]!, index: 1 };
    expect(() => RecordingManifestSchema.parse(gap)).toThrow();

    const wrongNonce = cloneManifest();
    wrongNonce.chunks[0] = {
      ...wrongNonce.chunks[0]!,
      nonce: encodeBase64Url(buildChunkNonce(noncePrefix, 2)),
    };
    expect(() => RecordingManifestSchema.parse(wrongNonce)).toThrow();

    const wrongLength = cloneManifest();
    wrongLength.chunks[0] = { ...wrongLength.chunks[0]!, sealedBytes: 46 };
    expect(() => RecordingManifestSchema.parse(wrongLength)).toThrow();

    expect(() =>
      RecordingManifestSchema.parse({ ...goldenManifest, durationMs: 480_001 }),
    ).toThrow();
    expect(
      RecordingManifestSchema.parse({ ...goldenManifest, durationMs: 0 })
        .durationMs,
    ).toBe(0);
    expect(() =>
      RecordingManifestSchema.parse({
        ...goldenManifest,
        totalObjectBytes: 128 * 1024 * 1024 + 1,
      }),
    ).toThrow();
  });

  it("rejects any authenticated manifest field mutation and a wrong manifest key", async () => {
    const keys = await deriveRecordingKeys(masterKey, binding);
    const authenticated = await authenticateManifest(
      goldenManifest,
      keys.manifestKey,
    );
    const mutations: Array<(manifest: RecordingManifest) => void> = [
      (manifest) => {
        manifest.attemptId = alternateBinding.attemptId;
      },
      (manifest) => {
        manifest.headSha = alternateBinding.headSha;
      },
      (manifest) => {
        manifest.objectId = alternateBinding.objectId;
      },
      (manifest) => {
        manifest.wrapping.materialId = "44444444-4444-4444-8444-444444444444";
      },
      (manifest) => {
        manifest.wrapping.keyId = "other-key";
      },
      (manifest) => {
        manifest.wrapping.wrappedKeySha256 = "b".repeat(64);
      },
      (manifest) => {
        manifest.durationMs += 1;
      },
      (manifest) => {
        manifest.chunks[0]!.ciphertextSha256 = "c".repeat(64);
      },
      (manifest) => {
        manifest.parts[0]!.sha256 = "d".repeat(64);
      },
      (manifest) => {
        const changedPrefix = new Uint8Array(8).fill(4);
        manifest.noncePrefixBase64url = encodeBase64Url(changedPrefix);
        manifest.chunks[0]!.nonce = encodeBase64Url(
          buildChunkNonce(changedPrefix, 0),
        );
      },
      (manifest) => {
        manifest.chunks[0]!.plaintextBytes = 28;
        manifest.chunks[0]!.sealedBytes = 44;
        manifest.totalPlaintextBytes = 28;
        manifest.totalObjectBytes = 76;
        manifest.parts[0]!.byteLength = 76;
      },
    ];
    for (const mutate of mutations) {
      const manifest = cloneManifest();
      mutate(manifest);
      await expect(
        verifyAuthenticatedManifest(
          { ...authenticated, manifest },
          keys.manifestKey,
        ),
      ).rejects.toMatchObject({ code: "invalid_manifest" });
    }

    const wrongKeys = await deriveRecordingKeys(
      new Uint8Array(32).fill(9),
      binding,
    );
    await expect(
      verifyAuthenticatedManifest(authenticated, wrongKeys.manifestKey),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("rejects ciphertext, key, AAD binding, nonce and record-order tampering", async () => {
    const keys = await deriveRecordingKeys(masterKey, binding);
    const first = await encryptRecordingChunk({
      plaintext,
      chunkIndex: 0,
      noncePrefix,
      binding,
      encryptionKey: keys.encryptionKey,
    });
    const second = await encryptRecordingChunk({
      plaintext: new TextEncoder().encode("second"),
      chunkIndex: 1,
      noncePrefix,
      binding,
      encryptionKey: keys.encryptionKey,
    });
    const tampered = first.record.slice();
    const previousLastByte = tampered.at(-1);
    if (previousLastByte === undefined) {
      throw new Error("test fixture unexpectedly empty");
    }
    tampered[tampered.length - 1] = previousLastByte ^ 1;
    await expect(
      decryptRecordingChunk({
        record: tampered,
        expectedChunkIndex: 0,
        expectedNoncePrefix: noncePrefix,
        binding,
        encryptionKey: keys.encryptionKey,
      }),
    ).rejects.toMatchObject({ code: "authentication_failed" });

    const wrongKeys = await deriveRecordingKeys(
      new Uint8Array(32).fill(7),
      binding,
    );
    await expect(
      decryptRecordingChunk({
        record: first.record,
        expectedChunkIndex: 0,
        expectedNoncePrefix: noncePrefix,
        binding,
        encryptionKey: wrongKeys.encryptionKey,
      }),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      decryptRecordingChunk({
        record: first.record,
        expectedChunkIndex: 0,
        expectedNoncePrefix: noncePrefix,
        binding: alternateBinding,
        encryptionKey: keys.encryptionKey,
      }),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      decryptRecordingChunk({
        record: first.record,
        expectedChunkIndex: 0,
        expectedNoncePrefix: new Uint8Array(8).fill(1),
        binding,
        encryptionKey: keys.encryptionKey,
      }),
    ).rejects.toMatchObject({ code: "invalid_nonce" });

    const joined = new Uint8Array(first.record.length + second.record.length);
    joined.set(first.record);
    joined.set(second.record, first.record.length);
    expect(parseChunkRecordSequence(joined)).toHaveLength(2);
    const reordered = new Uint8Array(joined.length);
    reordered.set(second.record);
    reordered.set(first.record, second.record.length);
    expect(() => parseChunkRecordSequence(reordered)).toThrow();
    expect(() => parseChunkRecordSequence(first.record, 1)).toThrow();
    const duplicated = new Uint8Array(first.record.length * 2);
    duplicated.set(first.record);
    duplicated.set(first.record, first.record.length);
    expect(() => parseChunkRecordSequence(duplicated)).toThrow();
    expect(() => parseChunkRecord(first.record.slice(0, -1))).toThrow();
    const extended = new Uint8Array(first.record.length + 1);
    extended.set(first.record);
    expect(() => parseChunkRecord(extended)).toThrow();

    const wrongNonceSuffix = first.record.slice();
    wrongNonceSuffix[23] = 1;
    expect(() => parseChunkRecord(wrongNonceSuffix)).toThrowError(
      RecordingProtocolError,
    );
    const otherPrefixSecond = await encryptRecordingChunk({
      plaintext: new TextEncoder().encode("second"),
      chunkIndex: 1,
      noncePrefix: new Uint8Array(8).fill(5),
      binding,
      encryptionKey: keys.encryptionKey,
    });
    const mixedPrefixes = new Uint8Array(
      first.record.length + otherPrefixSecond.record.length,
    );
    mixedPrefixes.set(first.record);
    mixedPrefixes.set(otherPrefixSecond.record, first.record.length);
    expect(() => parseChunkRecordSequence(mixedPrefixes)).toThrowError(
      RecordingProtocolError,
    );
  });

  it("stores only framed ciphertext and never embeds a known plaintext marker", async () => {
    const keys = await deriveRecordingKeys(masterKey, binding);
    const encrypted = await encryptRecordingChunk({
      plaintext,
      chunkIndex: 0,
      noncePrefix,
      binding,
      encryptionKey: keys.encryptionKey,
    });
    expect(new TextDecoder().decode(encrypted.record.slice(0, 4))).toBe("SPC1");
    expect(encodeHex(encrypted.record)).not.toContain(encodeHex(plaintext));
  });
});

describe("RSA-OAEP/SHA-256 key wrapping", () => {
  it("wraps in Web Crypto and unwraps in Node, then the inverse", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const material: PublicWrappingMaterial = {
      protocolVersion: 1,
      suiteId: "SP-RC1",
      ...binding,
      materialId: "33333333-3333-4333-8333-333333333333",
      keyId: "local-2026-08",
      algorithm: "RSA-OAEP-256",
      spkiBase64url: encodeBase64Url(publicKey),
      usableUntil: "2099-01-01T00:00:00.000Z",
    };
    const wrapped = await wrapMasterKey(masterKey, material, binding, {
      now: new Date("2026-08-11T00:00:00.000Z"),
    });
    const nodePlaintext = privateDecrypt(
      {
        key: createPrivateKey({
          key: privateKey,
          format: "der",
          type: "pkcs8",
        }),
        oaepHash: "sha256",
        padding: nodeCryptoConstants.RSA_PKCS1_OAEP_PADDING,
      },
      decodeBase64Url(wrapped.wrappedKeyBase64url),
    );
    expect(new Uint8Array(nodePlaintext)).toEqual(masterKey);

    const nodeWrapped = publicEncrypt(
      {
        key: createPublicKey({ key: publicKey, format: "der", type: "spki" }),
        oaepHash: "sha256",
        padding: nodeCryptoConstants.RSA_PKCS1_OAEP_PADDING,
      },
      masterKey,
    );
    const inverse: WrappedMasterKey = {
      materialId: material.materialId,
      keyId: material.keyId,
      algorithm: "RSA-OAEP-256",
      wrappedKeyBase64url: encodeBase64Url(nodeWrapped),
      wrappedKeySha256: await sha256Hex(nodeWrapped),
    };
    await expect(
      unwrapMasterKey(inverse, privateKey, {
        materialId: material.materialId,
        keyId: material.keyId,
      }),
    ).resolves.toEqual(masterKey);
  }, 20_000);

  it("rejects weak, expired, replayed and hash-mismatched wrapping material", async () => {
    const weak = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const material = PublicWrappingMaterialSchema.parse({
      protocolVersion: 1,
      suiteId: "SP-RC1",
      ...binding,
      materialId: "33333333-3333-4333-8333-333333333333",
      keyId: "weak",
      algorithm: "RSA-OAEP-256",
      spkiBase64url: encodeBase64Url(weak.publicKey),
      usableUntil: "2099-01-01T00:00:00.000Z",
    });
    await expect(
      wrapMasterKey(masterKey, material, binding),
    ).rejects.toMatchObject({
      code: "invalid_key",
    });
    await expect(
      wrapMasterKey(
        masterKey,
        { ...material, usableUntil: "2020-01-01T00:00:00.000Z" },
        binding,
      ),
    ).rejects.toMatchObject({ code: "invalid_key" });
    await expect(
      wrapMasterKey(masterKey, material, alternateBinding),
    ).rejects.toMatchObject({ code: "invalid_key" });

    const weakExponent = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 3,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    await expect(
      wrapMasterKey(
        masterKey,
        {
          ...material,
          keyId: "exponent-3",
          spkiBase64url: encodeBase64Url(weakExponent.publicKey),
        },
        binding,
      ),
    ).rejects.toMatchObject({ code: "invalid_key" });

    const strong = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const strongMaterial = {
      ...material,
      keyId: "strong",
      spkiBase64url: encodeBase64Url(strong.publicKey),
    };
    const wrapped = await wrapMasterKey(masterKey, strongMaterial, binding);
    await expect(
      unwrapMasterKey(
        { ...wrapped, wrappedKeySha256: "f".repeat(64) },
        strong.privateKey,
        { materialId: wrapped.materialId, keyId: wrapped.keyId },
      ),
    ).rejects.toMatchObject({ code: "invalid_key" });
    await expect(
      unwrapMasterKey(wrapped, strong.privateKey, {
        materialId: wrapped.materialId,
        keyId: "wrong-key",
      }),
    ).rejects.toMatchObject({ code: "invalid_key" });
  }, 20_000);
});
