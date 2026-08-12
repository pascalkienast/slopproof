import {
  AES_GCM_NONCE_BYTES,
  MAX_UINT32,
  NONCE_PREFIX_BYTES,
} from "./constants";
import { RecordingProtocolError } from "./errors";

export function buildChunkNonce(
  noncePrefix: Uint8Array,
  chunkIndex: number,
): Uint8Array {
  if (noncePrefix.byteLength !== NONCE_PREFIX_BYTES) {
    throw new RecordingProtocolError(
      "invalid_nonce",
      `Nonce prefix must be ${String(NONCE_PREFIX_BYTES)} bytes`,
    );
  }
  if (
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex > MAX_UINT32
  ) {
    throw new RecordingProtocolError(
      "invalid_nonce",
      "Chunk index is outside uint32",
    );
  }

  const nonce = new Uint8Array(AES_GCM_NONCE_BYTES);
  nonce.set(noncePrefix, 0);
  new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).setUint32(
    NONCE_PREFIX_BYTES,
    chunkIndex,
    false,
  );
  return nonce;
}
