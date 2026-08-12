import { createHash, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  MAX_PLAINTEXT_CHUNK_BYTES,
  RECORD_HEADER_BYTES,
  decodeBase64Url,
  decryptRecordingChunk,
  deriveRecordingKeyMaterial,
  importDerivedRecordingKeys,
  parseChunkRecord,
  sha256Hex,
  unwrapMasterKey,
  verifyAuthenticatedManifest,
  type FinalizeRecording,
  type RecordingManifest,
} from "@slopproof/media";

export type RecordingKeyBinding = {
  materialId: string;
  keyId: string;
};

const privateKeyCache = new Map<string, Promise<Uint8Array>>();

/**
 * The private wrapping key is loaded only inside the worker process. The web
 * process receives neither the file nor an export of this key.
 */
export async function loadLocalPrivateKeyPkcs8(
  path: string,
): Promise<Uint8Array> {
  let cached = privateKeyCache.get(path);
  if (!cached) {
    cached = (async () => {
      const pem = await readFile(path, "utf8");
      const key = createPrivateKey(pem);
      if (
        key.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3_072
      ) {
        throw new Error("worker wrapping key must be RSA-3072 or stronger");
      }
      const exported = key.export({ format: "der", type: "pkcs8" });
      return new Uint8Array(exported);
    })();
    privateKeyCache.set(path, cached);
  }
  return cached;
}

export async function authenticateRecordingFinalization(
  finalization: FinalizeRecording,
  binding: RecordingKeyBinding,
  privateKeyPath: string,
): Promise<CryptoKey> {
  const privateKey = await loadLocalPrivateKeyPkcs8(privateKeyPath);
  let masterKey: Uint8Array | undefined;
  try {
    masterKey = await unwrapMasterKey(
      finalization.wrappedKey,
      privateKey,
      binding,
    );
    const manifest = finalization.manifest;
    const keyMaterial = await deriveRecordingKeyMaterial(masterKey, {
      attemptId: manifest.attemptId,
      headSha: manifest.headSha,
      objectId: manifest.objectId,
    });
    try {
      const keys = await importDerivedRecordingKeys(keyMaterial);
      await verifyAuthenticatedManifest(
        {
          manifest,
          manifestTagBase64url: finalization.manifestTagBase64url,
          manifestDigest: finalization.manifestDigest,
        },
        keys.manifestKey,
      );
      return keys.encryptionKey;
    } finally {
      keyMaterial.encryptionKeyBytes.fill(0);
      keyMaterial.manifestKeyBytes.fill(0);
    }
  } finally {
    masterKey?.fill(0);
  }
}

/**
 * Validates the authenticated part layout and every framed AEAD record before
 * releasing its plaintext to the supplied worker-only sink. The sink must not
 * retain the buffer: it is overwritten immediately after the callback.
 */
export async function streamDecryptedRecording(
  stream: ReadableStream<Uint8Array>,
  manifest: RecordingManifest,
  encryptionKey: CryptoKey,
  onPlaintext: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const noncePrefix = decodeBase64Url(manifest.noncePrefixBase64url);
  let pending = new Uint8Array(0);
  let recordIndex = 0;
  let partIndex = 0;
  let partRemaining = manifest.parts[0]?.byteLength ?? 0;
  let partHash = createHash("sha256");
  let objectBytes = 0;

  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const incoming = read.value;
      objectBytes += incoming.byteLength;
      let hashOffset = 0;
      while (hashOffset < incoming.byteLength) {
        const take = Math.min(partRemaining, incoming.byteLength - hashOffset);
        if (take <= 0) throw new Error("object exceeds manifest part ranges");
        partHash.update(incoming.subarray(hashOffset, hashOffset + take));
        hashOffset += take;
        partRemaining -= take;
        if (partRemaining === 0) {
          const expected = manifest.parts[partIndex];
          if (!expected || partHash.digest("hex") !== expected.sha256) {
            throw new Error("ciphertext part hash mismatch");
          }
          partIndex += 1;
          partRemaining = manifest.parts[partIndex]?.byteLength ?? 0;
          partHash = createHash("sha256");
        }
      }

      const combined = new Uint8Array(pending.byteLength + incoming.byteLength);
      combined.set(pending);
      combined.set(incoming, pending.byteLength);
      pending = combined;

      while (pending.byteLength >= RECORD_HEADER_BYTES) {
        const view = new DataView(
          pending.buffer,
          pending.byteOffset,
          RECORD_HEADER_BYTES,
        );
        const sealedLength = view.getUint32(28, false);
        if (
          sealedLength < 17 ||
          sealedLength > MAX_PLAINTEXT_CHUNK_BYTES + 16
        ) {
          throw new Error("invalid framed record length");
        }
        const recordLength = RECORD_HEADER_BYTES + sealedLength;
        if (pending.byteLength < recordLength) break;

        const recordBytes = pending.slice(0, recordLength);
        pending = pending.slice(recordLength);
        const record = parseChunkRecord(recordBytes);
        const expected = manifest.chunks[recordIndex];
        if (
          !expected ||
          record.chunkIndex !== expected.index ||
          record.plaintextLength !== expected.plaintextBytes ||
          record.sealedLength !== expected.sealedBytes ||
          (await sha256Hex(record.sealed)) !== expected.ciphertextSha256
        ) {
          throw new Error("ciphertext record does not match manifest");
        }

        const plaintext = await decryptRecordingChunk({
          record: recordBytes,
          expectedChunkIndex: recordIndex,
          expectedNoncePrefix: noncePrefix,
          binding: {
            attemptId: manifest.attemptId,
            headSha: manifest.headSha,
            objectId: manifest.objectId,
          },
          encryptionKey,
        });
        try {
          await onPlaintext(plaintext);
        } finally {
          plaintext.fill(0);
          recordBytes.fill(0);
        }
        recordIndex += 1;
      }
    }

    if (
      pending.byteLength !== 0 ||
      recordIndex !== manifest.chunks.length ||
      partIndex !== manifest.parts.length ||
      partRemaining !== 0 ||
      objectBytes !== manifest.totalObjectBytes
    ) {
      throw new Error("ciphertext object ended outside manifest boundaries");
    }
  } finally {
    noncePrefix.fill(0);
    pending.fill(0);
    reader.releaseLock();
  }
}
