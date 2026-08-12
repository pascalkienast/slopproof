import {
  CHUNK_AEAD_INFO,
  MANIFEST_AUTH_INFO,
  MASTER_KEY_BYTES,
  MAX_PLAINTEXT_CHUNK_BYTES,
  NONCE_PREFIX_BYTES,
  RECORDING_CODEC,
  RSA_MINIMUM_MODULUS_BITS,
} from "./constants";
import { canonicalChunkAadBytes, canonicalKdfContextBytes } from "./canonical";
import {
  bytesEqual,
  decodeBase64Url,
  encodeBase64Url,
  encodeHex,
  utf8Bytes,
} from "./encoding";
import { RecordingProtocolError } from "./errors";
import { buildChunkNonce } from "./nonce";
import { buildChunkRecord, parseChunkRecord } from "./records";
import {
  PublicWrappingMaterialSchema,
  RecordingBindingSchema,
  WrappedMasterKeySchema,
  type ManifestChunk,
  type PublicWrappingMaterial,
  type RecordingBinding,
  type WrappedMasterKey,
} from "./schemas";

export type DerivedRecordingKeyMaterial = {
  encryptionKeyBytes: Uint8Array;
  manifestKeyBytes: Uint8Array;
};

export type DerivedRecordingKeys = {
  encryptionKey: CryptoKey;
  manifestKey: CryptoKey;
};

export type EncryptedChunk = {
  record: Uint8Array;
  sealed: Uint8Array;
  manifest: ManifestChunk;
};

export type CryptoOptions = {
  crypto?: Crypto;
};

function resolveCrypto(options: CryptoOptions): Crypto {
  const provider = options.crypto ?? globalThis.crypto;
  if (provider === undefined) {
    throw new RecordingProtocolError(
      "invalid_key",
      "Web Crypto is not available in this runtime",
    );
  }
  return provider;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer;
}

function requireMasterKey(masterKey: Uint8Array): void {
  if (masterKey.byteLength !== MASTER_KEY_BYTES) {
    throw new RecordingProtocolError(
      "invalid_key",
      `Master key must be ${String(MASTER_KEY_BYTES)} bytes`,
    );
  }
}

function requireRsaStrength(key: CryptoKey): void {
  const algorithm = key.algorithm;
  if (!("modulusLength" in algorithm) || !("publicExponent" in algorithm)) {
    throw new RecordingProtocolError("invalid_key", "Wrapping key is not RSA");
  }
  const modulusLength = algorithm.modulusLength;
  const publicExponent = algorithm.publicExponent;
  if (
    typeof modulusLength !== "number" ||
    modulusLength < RSA_MINIMUM_MODULUS_BITS
  ) {
    throw new RecordingProtocolError(
      "invalid_key",
      `RSA wrapping key must be at least ${String(RSA_MINIMUM_MODULUS_BITS)} bits`,
    );
  }
  if (
    !(publicExponent instanceof Uint8Array) ||
    !bytesEqual(publicExponent, new Uint8Array([1, 0, 1]))
  ) {
    throw new RecordingProtocolError(
      "invalid_key",
      "RSA wrapping key must use public exponent 65537",
    );
  }
}

export function createMasterKey(options: CryptoOptions = {}): Uint8Array {
  const result = new Uint8Array(MASTER_KEY_BYTES);
  resolveCrypto(options).getRandomValues(result);
  return result;
}

export function createNoncePrefix(options: CryptoOptions = {}): Uint8Array {
  const result = new Uint8Array(NONCE_PREFIX_BYTES);
  resolveCrypto(options).getRandomValues(result);
  return result;
}

export async function sha256(
  value: Uint8Array,
  options: CryptoOptions = {},
): Promise<Uint8Array> {
  const digest = await resolveCrypto(options).subtle.digest(
    "SHA-256",
    toArrayBuffer(value),
  );
  return new Uint8Array(digest);
}

export async function sha256Hex(
  value: Uint8Array,
  options: CryptoOptions = {},
): Promise<string> {
  return encodeHex(await sha256(value, options));
}

async function deriveHkdfBits(
  masterKey: Uint8Array,
  salt: Uint8Array,
  info: string,
  options: CryptoOptions,
): Promise<Uint8Array> {
  const cryptoProvider = resolveCrypto(options);
  const hkdfKey = await cryptoProvider.subtle.importKey(
    "raw",
    toArrayBuffer(masterKey),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await cryptoProvider.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(utf8Bytes(info)),
    },
    hkdfKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveRecordingKeyMaterial(
  masterKey: Uint8Array,
  bindingInput: RecordingBinding,
  options: CryptoOptions = {},
): Promise<DerivedRecordingKeyMaterial> {
  requireMasterKey(masterKey);
  const binding = RecordingBindingSchema.parse(bindingInput);
  const context = canonicalKdfContextBytes(binding);
  const salt = await sha256(context, options);
  const [encryptionKeyBytes, manifestKeyBytes] = await Promise.all([
    deriveHkdfBits(masterKey, salt, CHUNK_AEAD_INFO, options),
    deriveHkdfBits(masterKey, salt, MANIFEST_AUTH_INFO, options),
  ]);
  return { encryptionKeyBytes, manifestKeyBytes };
}

export async function importDerivedRecordingKeys(
  material: DerivedRecordingKeyMaterial,
  options: CryptoOptions = {},
): Promise<DerivedRecordingKeys> {
  if (
    material.encryptionKeyBytes.byteLength !== 32 ||
    material.manifestKeyBytes.byteLength !== 32
  ) {
    throw new RecordingProtocolError(
      "invalid_key",
      "Derived recording keys must be 32 bytes",
    );
  }
  const subtle = resolveCrypto(options).subtle;
  const [encryptionKey, manifestKey] = await Promise.all([
    subtle.importKey(
      "raw",
      toArrayBuffer(material.encryptionKeyBytes),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    subtle.importKey(
      "raw",
      toArrayBuffer(material.manifestKeyBytes),
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    ),
  ]);
  return { encryptionKey, manifestKey };
}

export async function deriveRecordingKeys(
  masterKey: Uint8Array,
  binding: RecordingBinding,
  options: CryptoOptions = {},
): Promise<DerivedRecordingKeys> {
  return importDerivedRecordingKeys(
    await deriveRecordingKeyMaterial(masterKey, binding, options),
    options,
  );
}

export async function encryptRecordingChunk(
  input: {
    plaintext: Uint8Array;
    chunkIndex: number;
    noncePrefix: Uint8Array;
    binding: RecordingBinding;
    encryptionKey: CryptoKey;
  },
  options: CryptoOptions = {},
): Promise<EncryptedChunk> {
  if (
    input.plaintext.byteLength < 1 ||
    input.plaintext.byteLength > MAX_PLAINTEXT_CHUNK_BYTES
  ) {
    throw new RecordingProtocolError(
      "limit_exceeded",
      "Plaintext chunk is empty or exceeds the protocol limit",
    );
  }
  const binding = RecordingBindingSchema.parse(input.binding);
  const nonce = buildChunkNonce(input.noncePrefix, input.chunkIndex);
  const nonceBase64url = encodeBase64Url(nonce);
  const aad = canonicalChunkAadBytes({
    ...binding,
    codec: RECORDING_CODEC,
    chunkIndex: input.chunkIndex,
    nonceBase64url,
    plaintextBytes: input.plaintext.byteLength,
  });

  let sealedBuffer: ArrayBuffer;
  try {
    sealedBuffer = await resolveCrypto(options).subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(aad),
        tagLength: 128,
      },
      input.encryptionKey,
      toArrayBuffer(input.plaintext),
    );
  } catch (error) {
    throw new RecordingProtocolError(
      "authentication_failed",
      "Chunk encryption failed",
      { cause: error },
    );
  }
  const sealed = new Uint8Array(sealedBuffer);
  const record = buildChunkRecord({
    chunkIndex: input.chunkIndex,
    nonce,
    plaintextLength: input.plaintext.byteLength,
    sealed,
  });
  return {
    record,
    sealed,
    manifest: {
      index: input.chunkIndex,
      nonce: nonceBase64url,
      plaintextBytes: input.plaintext.byteLength,
      sealedBytes: sealed.byteLength,
      ciphertextSha256: await sha256Hex(sealed, options),
    },
  };
}

export async function decryptRecordingChunk(
  input: {
    record: Uint8Array;
    expectedChunkIndex: number;
    expectedNoncePrefix: Uint8Array;
    binding: RecordingBinding;
    encryptionKey: CryptoKey;
  },
  options: CryptoOptions = {},
): Promise<Uint8Array> {
  const record = parseChunkRecord(input.record);
  const expectedNonce = buildChunkNonce(
    input.expectedNoncePrefix,
    input.expectedChunkIndex,
  );
  if (
    record.chunkIndex !== input.expectedChunkIndex ||
    !bytesEqual(record.nonce, expectedNonce)
  ) {
    throw new RecordingProtocolError(
      "invalid_nonce",
      "Record index or nonce does not match the expected sequence",
    );
  }
  const binding = RecordingBindingSchema.parse(input.binding);
  const aad = canonicalChunkAadBytes({
    ...binding,
    codec: RECORDING_CODEC,
    chunkIndex: record.chunkIndex,
    nonceBase64url: encodeBase64Url(record.nonce),
    plaintextBytes: record.plaintextLength,
  });

  try {
    const plaintext = await resolveCrypto(options).subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(record.nonce),
        additionalData: toArrayBuffer(aad),
        tagLength: 128,
      },
      input.encryptionKey,
      toArrayBuffer(record.sealed),
    );
    if (plaintext.byteLength !== record.plaintextLength) {
      throw new RecordingProtocolError(
        "invalid_record",
        "Decrypted chunk length does not match its record",
      );
    }
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof RecordingProtocolError) {
      throw error;
    }
    throw new RecordingProtocolError(
      "authentication_failed",
      "Chunk authentication failed",
      { cause: error },
    );
  }
}

export async function signManifestBytes(
  manifestKey: CryptoKey,
  canonicalBytes: Uint8Array,
  options: CryptoOptions = {},
): Promise<Uint8Array> {
  const signature = await resolveCrypto(options).subtle.sign(
    "HMAC",
    manifestKey,
    toArrayBuffer(canonicalBytes),
  );
  return new Uint8Array(signature);
}

export async function verifyManifestBytes(
  manifestKey: CryptoKey,
  canonicalBytes: Uint8Array,
  signature: Uint8Array,
  options: CryptoOptions = {},
): Promise<boolean> {
  if (signature.byteLength !== 32) {
    return false;
  }
  return resolveCrypto(options).subtle.verify(
    "HMAC",
    manifestKey,
    toArrayBuffer(signature),
    toArrayBuffer(canonicalBytes),
  );
}

function sameBinding(
  material: PublicWrappingMaterial,
  expected: RecordingBinding,
): boolean {
  return (
    material.attemptId === expected.attemptId &&
    material.headSha === expected.headSha &&
    material.objectId === expected.objectId
  );
}

export async function wrapMasterKey(
  masterKey: Uint8Array,
  materialInput: PublicWrappingMaterial,
  expectedBindingInput: RecordingBinding,
  options: CryptoOptions & { now?: Date } = {},
): Promise<WrappedMasterKey> {
  requireMasterKey(masterKey);
  const material = PublicWrappingMaterialSchema.parse(materialInput);
  const expectedBinding = RecordingBindingSchema.parse(expectedBindingInput);
  if (!sameBinding(material, expectedBinding)) {
    throw new RecordingProtocolError(
      "invalid_key",
      "Wrapping material is bound to a different recording",
    );
  }
  const now = options.now ?? new Date();
  if (Date.parse(material.usableUntil) <= now.getTime()) {
    throw new RecordingProtocolError(
      "invalid_key",
      "Wrapping material has expired",
    );
  }

  const cryptoProvider = resolveCrypto(options);
  let key: CryptoKey;
  try {
    key = await cryptoProvider.subtle.importKey(
      "spki",
      toArrayBuffer(decodeBase64Url(material.spkiBase64url)),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
  } catch (error) {
    throw new RecordingProtocolError(
      "invalid_key",
      "Invalid RSA SPKI material",
      {
        cause: error,
      },
    );
  }
  requireRsaStrength(key);

  const wrappedBuffer = await cryptoProvider.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    toArrayBuffer(masterKey),
  );
  const wrapped = new Uint8Array(wrappedBuffer);
  return WrappedMasterKeySchema.parse({
    materialId: material.materialId,
    keyId: material.keyId,
    algorithm: material.algorithm,
    wrappedKeyBase64url: encodeBase64Url(wrapped),
    wrappedKeySha256: await sha256Hex(wrapped, options),
  });
}

export async function unwrapMasterKey(
  wrappedInput: WrappedMasterKey,
  privateKeyPkcs8: Uint8Array,
  expected: { materialId: string; keyId: string },
  options: CryptoOptions = {},
): Promise<Uint8Array> {
  const wrapped = WrappedMasterKeySchema.parse(wrappedInput);
  if (
    wrapped.materialId !== expected.materialId ||
    wrapped.keyId !== expected.keyId
  ) {
    throw new RecordingProtocolError(
      "invalid_key",
      "Wrapped key reference does not match",
    );
  }
  const wrappedBytes = decodeBase64Url(wrapped.wrappedKeyBase64url);
  if ((await sha256Hex(wrappedBytes, options)) !== wrapped.wrappedKeySha256) {
    throw new RecordingProtocolError(
      "invalid_key",
      "Wrapped key hash does not match",
    );
  }

  const cryptoProvider = resolveCrypto(options);
  let privateKey: CryptoKey;
  try {
    privateKey = await cryptoProvider.subtle.importKey(
      "pkcs8",
      toArrayBuffer(privateKeyPkcs8),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
  } catch (error) {
    throw new RecordingProtocolError("invalid_key", "Invalid RSA private key", {
      cause: error,
    });
  }
  requireRsaStrength(privateKey);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await cryptoProvider.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      toArrayBuffer(wrappedBytes),
    );
  } catch (error) {
    throw new RecordingProtocolError(
      "authentication_failed",
      "Key unwrap failed",
      {
        cause: error,
      },
    );
  }
  const masterKey = new Uint8Array(plaintext);
  requireMasterKey(masterKey);
  return masterKey;
}
