import {
  AES_GCM_TAG_BYTES,
  MAX_PLAINTEXT_CHUNK_BYTES,
  MAX_RECORDING_CHUNKS,
  MAX_RECORDING_OBJECT_BYTES,
  MAX_UINT32,
  RECORD_HEADER_BYTES,
  RECORD_MAGIC,
  RECORD_VERSION,
} from "./constants";
import { bytesEqual, concatBytes, utf8Bytes } from "./encoding";
import { RecordingProtocolError } from "./errors";
import { buildChunkNonce } from "./nonce";

const magicBytes = utf8Bytes(RECORD_MAGIC);

export type ChunkRecord = {
  chunkIndex: number;
  nonce: Uint8Array;
  plaintextLength: number;
  sealedLength: number;
  sealed: Uint8Array;
  bytes: Uint8Array;
};

function validateRecordFields(input: {
  chunkIndex: number;
  nonce: Uint8Array;
  plaintextLength: number;
  sealed: Uint8Array;
}): void {
  if (
    !Number.isSafeInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    input.chunkIndex > MAX_UINT32
  ) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Chunk index is outside uint32",
    );
  }
  if (input.nonce.byteLength !== 12) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Record nonce must be 12 bytes",
    );
  }
  if (
    !bytesEqual(
      input.nonce,
      buildChunkNonce(input.nonce.slice(0, 8), input.chunkIndex),
    )
  ) {
    throw new RecordingProtocolError(
      "invalid_nonce",
      "Record nonce suffix must match its chunk index",
    );
  }
  if (
    !Number.isSafeInteger(input.plaintextLength) ||
    input.plaintextLength < 1 ||
    input.plaintextLength > MAX_PLAINTEXT_CHUNK_BYTES
  ) {
    throw new RecordingProtocolError(
      "limit_exceeded",
      "Record plaintext length exceeds the chunk limit",
    );
  }
  if (input.sealed.byteLength !== input.plaintextLength + AES_GCM_TAG_BYTES) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Record sealed length does not match plaintext length plus tag",
    );
  }
}

export function buildChunkRecord(input: {
  chunkIndex: number;
  nonce: Uint8Array;
  plaintextLength: number;
  sealed: Uint8Array;
}): Uint8Array {
  validateRecordFields(input);
  const header = new Uint8Array(RECORD_HEADER_BYTES);
  header.set(magicBytes, 0);
  const view = new DataView(header.buffer);
  view.setUint8(4, RECORD_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, RECORD_HEADER_BYTES, false);
  view.setUint32(8, input.chunkIndex, false);
  header.set(input.nonce, 12);
  view.setUint32(24, input.plaintextLength, false);
  view.setUint32(28, input.sealed.byteLength, false);
  return concatBytes(header, input.sealed);
}

function parseRecordAt(bytes: Uint8Array, offset: number): ChunkRecord {
  if (bytes.byteLength - offset < RECORD_HEADER_BYTES) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Truncated SPC1 record header",
    );
  }
  const header = bytes.subarray(offset, offset + RECORD_HEADER_BYTES);
  if (!bytesEqual(header.subarray(0, 4), magicBytes)) {
    throw new RecordingProtocolError("invalid_record", "Unknown record magic");
  }
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  if (
    view.getUint8(4) !== RECORD_VERSION ||
    view.getUint8(5) !== 0 ||
    view.getUint16(6, false) !== RECORD_HEADER_BYTES
  ) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Unknown SPC1 record header",
    );
  }
  const chunkIndex = view.getUint32(8, false);
  const nonce = header.slice(12, 24);
  if (!bytesEqual(nonce, buildChunkNonce(nonce.slice(0, 8), chunkIndex))) {
    throw new RecordingProtocolError(
      "invalid_nonce",
      "SPC1 nonce suffix does not match its chunk index",
    );
  }
  const plaintextLength = view.getUint32(24, false);
  const sealedLength = view.getUint32(28, false);
  const recordLength = RECORD_HEADER_BYTES + sealedLength;
  if (
    plaintextLength < 1 ||
    plaintextLength > MAX_PLAINTEXT_CHUNK_BYTES ||
    sealedLength !== plaintextLength + AES_GCM_TAG_BYTES
  ) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Invalid SPC1 record lengths",
    );
  }
  if (bytes.byteLength - offset < recordLength) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Truncated SPC1 record body",
    );
  }
  const recordBytes = bytes.slice(offset, offset + recordLength);
  return {
    chunkIndex,
    nonce,
    plaintextLength,
    sealedLength,
    sealed: recordBytes.slice(RECORD_HEADER_BYTES),
    bytes: recordBytes,
  };
}

export function parseChunkRecord(bytes: Uint8Array): ChunkRecord {
  const record = parseRecordAt(bytes, 0);
  if (record.bytes.byteLength !== bytes.byteLength) {
    throw new RecordingProtocolError(
      "invalid_record",
      "SPC1 record has trailing bytes",
    );
  }
  return record;
}

export function parseChunkRecordSequence(
  bytes: Uint8Array,
  expectedFirstIndex = 0,
): ChunkRecord[] {
  if (
    !Number.isSafeInteger(expectedFirstIndex) ||
    expectedFirstIndex < 0 ||
    expectedFirstIndex > MAX_UINT32
  ) {
    throw new RecordingProtocolError(
      "invalid_record",
      "Invalid expected record index",
    );
  }
  if (bytes.byteLength > MAX_RECORDING_OBJECT_BYTES) {
    throw new RecordingProtocolError(
      "limit_exceeded",
      "SPC1 sequence exceeds the object-size limit",
    );
  }
  const records: ChunkRecord[] = [];
  let noncePrefix: Uint8Array | undefined;
  let offset = 0;
  let expectedIndex = expectedFirstIndex;
  while (offset < bytes.byteLength) {
    const record = parseRecordAt(bytes, offset);
    noncePrefix ??= record.nonce.slice(0, 8);
    if (record.chunkIndex !== expectedIndex) {
      throw new RecordingProtocolError(
        "invalid_record",
        "SPC1 record indices are duplicated, missing or reordered",
      );
    }
    if (!bytesEqual(record.nonce.slice(0, 8), noncePrefix)) {
      throw new RecordingProtocolError(
        "invalid_nonce",
        "SPC1 records use different nonce prefixes",
      );
    }
    records.push(record);
    if (records.length > MAX_RECORDING_CHUNKS) {
      throw new RecordingProtocolError(
        "limit_exceeded",
        "SPC1 sequence exceeds the chunk-count limit",
      );
    }
    offset += record.bytes.byteLength;
    expectedIndex += 1;
  }
  if (records.length === 0) {
    throw new RecordingProtocolError(
      "invalid_record",
      "SPC1 sequence is empty",
    );
  }
  return records;
}
