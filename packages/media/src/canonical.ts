import {
  CHUNK_AAD_DOMAIN,
  KDF_DOMAIN,
  MANIFEST_DOMAIN,
  RECORDING_PROTOCOL_VERSION,
  RECORDING_SUITE_ID,
  WRAPPING_ALGORITHM,
} from "./constants";
import { utf8Bytes } from "./encoding";
import {
  ChunkAadContextSchema,
  RecordingBindingSchema,
  RecordingManifestSchema,
  type ChunkAadContext,
  type RecordingBinding,
  type RecordingManifest,
} from "./schemas";

export function canonicalKdfContextBytes(input: RecordingBinding): Uint8Array {
  const binding = RecordingBindingSchema.parse(input);
  return utf8Bytes(
    JSON.stringify([
      KDF_DOMAIN,
      RECORDING_PROTOCOL_VERSION,
      binding.attemptId,
      binding.headSha,
      binding.objectId,
    ]),
  );
}

export function canonicalChunkAadBytes(input: ChunkAadContext): Uint8Array {
  const context = ChunkAadContextSchema.parse(input);
  return utf8Bytes(
    JSON.stringify([
      CHUNK_AAD_DOMAIN,
      RECORDING_PROTOCOL_VERSION,
      RECORDING_SUITE_ID,
      context.attemptId,
      context.headSha,
      context.objectId,
      context.codec,
      context.chunkIndex,
      context.nonceBase64url,
      context.plaintextBytes,
    ]),
  );
}

export function canonicalManifestBytes(input: RecordingManifest): Uint8Array {
  const manifest = RecordingManifestSchema.parse(input);
  return utf8Bytes(
    JSON.stringify([
      MANIFEST_DOMAIN,
      RECORDING_PROTOCOL_VERSION,
      RECORDING_SUITE_ID,
      manifest.attemptId,
      manifest.headSha,
      manifest.objectId,
      manifest.codec,
      manifest.noncePrefixBase64url,
      manifest.wrapping.materialId,
      manifest.wrapping.keyId,
      WRAPPING_ALGORITHM,
      manifest.wrapping.wrappedKeySha256,
      manifest.durationMs,
      manifest.totalPlaintextBytes,
      manifest.totalObjectBytes,
      manifest.chunks.map((chunk) => [
        chunk.index,
        chunk.nonce,
        chunk.plaintextBytes,
        chunk.sealedBytes,
        chunk.ciphertextSha256,
      ]),
      manifest.parts.map((part) => [
        part.partNumber,
        part.firstChunkIndex,
        part.lastChunkIndex,
        part.byteLength,
        part.sha256,
      ]),
    ]),
  );
}
