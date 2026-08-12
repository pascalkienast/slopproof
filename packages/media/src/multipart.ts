import {
  MAX_ENCRYPTED_BUFFER_BYTES,
  MAX_MULTIPART_PARTS,
  MAX_RECORDING_CHUNKS,
  MAX_RECORDING_OBJECT_BYTES,
  MULTIPART_TARGET_BYTES,
  S3_MINIMUM_NONFINAL_PART_BYTES,
} from "./constants";
import { bytesEqual, concatBytes } from "./encoding";
import { RecordingProtocolError } from "./errors";
import { sha256Hex, type CryptoOptions } from "./crypto";
import { parseChunkRecord } from "./records";
import {
  ManifestPartSchema,
  ProviderListedPartSchema,
  UploadedPartReceiptSchema,
  type ManifestPart,
  type ProviderListedPart,
  type UploadedPartReceipt,
} from "./schemas";

export type PackedMultipartPart = ManifestPart & {
  bytes: Uint8Array;
};

export class MultipartRecordPacker {
  readonly #options: CryptoOptions;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #firstChunkIndex = 0;
  #chunkCount = 0;
  #partCount = 0;
  #objectBytes = 0;
  #finished = false;

  constructor(options: CryptoOptions = {}) {
    this.#options = options;
  }

  async push(recordBytes: Uint8Array): Promise<PackedMultipartPart[]> {
    if (this.#finished) {
      throw new RecordingProtocolError(
        "invalid_record",
        "Cannot append a record after multipart packing is finalized",
      );
    }
    if (this.#chunkCount >= MAX_RECORDING_CHUNKS) {
      throw new RecordingProtocolError(
        "limit_exceeded",
        "Record count exceeds the protocol limit",
      );
    }
    const record = parseChunkRecord(recordBytes);
    if (record.chunkIndex !== this.#chunkCount) {
      throw new RecordingProtocolError(
        "invalid_record",
        "Records must be contiguous and ordered before multipart packing",
      );
    }
    if (
      this.#objectBytes + record.bytes.byteLength >
      MAX_RECORDING_OBJECT_BYTES
    ) {
      throw new RecordingProtocolError(
        "limit_exceeded",
        "Recording object exceeds the protocol limit",
      );
    }

    const ready: PackedMultipartPart[] = [];
    if (
      this.#pendingBytes + record.bytes.byteLength >
      MAX_ENCRYPTED_BUFFER_BYTES
    ) {
      ready.push(await this.#flush(false));
    }
    this.#pending.push(record.bytes);
    this.#pendingBytes += record.bytes.byteLength;
    this.#objectBytes += record.bytes.byteLength;
    this.#chunkCount += 1;

    if (this.#pendingBytes >= MULTIPART_TARGET_BYTES) {
      ready.push(await this.#flush(false));
    }
    return ready;
  }

  async finish(): Promise<PackedMultipartPart[]> {
    if (this.#finished) {
      throw new RecordingProtocolError(
        "invalid_record",
        "Multipart packing was already finalized",
      );
    }
    this.#finished = true;
    if (this.#chunkCount === 0) {
      throw new RecordingProtocolError(
        "limit_exceeded",
        "Record sequence must not be empty",
      );
    }
    return this.#pending.length === 0 ? [] : [await this.#flush(true)];
  }

  async #flush(finalPart: boolean): Promise<PackedMultipartPart> {
    if (this.#pending.length === 0) {
      throw new RecordingProtocolError(
        "invalid_record",
        "Cannot flush an empty multipart buffer",
      );
    }
    if (
      this.#pendingBytes > MAX_ENCRYPTED_BUFFER_BYTES ||
      (!finalPart && this.#pendingBytes < S3_MINIMUM_NONFINAL_PART_BYTES)
    ) {
      throw new RecordingProtocolError(
        "limit_exceeded",
        "Multipart buffer violates the generic S3 size bounds",
      );
    }
    if (this.#partCount >= MAX_MULTIPART_PARTS) {
      throw new RecordingProtocolError(
        "limit_exceeded",
        "Multipart part count exceeds the protocol limit",
      );
    }

    const bytes = concatBytes(...this.#pending);
    const metadata = ManifestPartSchema.parse({
      partNumber: this.#partCount + 1,
      firstChunkIndex: this.#firstChunkIndex,
      lastChunkIndex: this.#firstChunkIndex + this.#pending.length - 1,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes, this.#options),
    });
    this.#firstChunkIndex += this.#pending.length;
    this.#partCount += 1;
    this.#pending = [];
    this.#pendingBytes = 0;
    return { ...metadata, bytes };
  }
}

export async function packChunkRecords(
  records: readonly Uint8Array[],
  options: CryptoOptions = {},
): Promise<PackedMultipartPart[]> {
  if (records.length < 1 || records.length > MAX_RECORDING_CHUNKS) {
    throw new RecordingProtocolError(
      "limit_exceeded",
      "Record count is outside the protocol limit",
    );
  }
  const packer = new MultipartRecordPacker(options);
  const result: PackedMultipartPart[] = [];
  for (const record of records) {
    result.push(...(await packer.push(record)));
  }
  result.push(...(await packer.finish()));
  return result;
}

export class MultipartPartLedger {
  readonly #parts = new Map<number, PackedMultipartPart>();

  register(part: PackedMultipartPart): "accepted" | "duplicate" {
    const metadata = ManifestPartSchema.parse({
      partNumber: part.partNumber,
      firstChunkIndex: part.firstChunkIndex,
      lastChunkIndex: part.lastChunkIndex,
      byteLength: part.byteLength,
      sha256: part.sha256,
    });
    if (metadata.byteLength !== part.bytes.byteLength) {
      throw new RecordingProtocolError(
        "multipart_mismatch",
        "Part metadata does not match its bytes",
      );
    }
    const existing = this.#parts.get(metadata.partNumber);
    if (existing === undefined) {
      this.#parts.set(metadata.partNumber, {
        ...metadata,
        bytes: part.bytes.slice(),
      });
      return "accepted";
    }
    if (
      existing.sha256 === metadata.sha256 &&
      existing.firstChunkIndex === metadata.firstChunkIndex &&
      existing.lastChunkIndex === metadata.lastChunkIndex &&
      bytesEqual(existing.bytes, part.bytes)
    ) {
      return "duplicate";
    }
    throw new RecordingProtocolError(
      "multipart_mismatch",
      "Different bytes were supplied for an existing part number",
    );
  }
}

export function verifyProviderPartList(
  manifestPartsInput: readonly ManifestPart[],
  receiptsInput: readonly UploadedPartReceipt[],
  providerPartsInput: readonly ProviderListedPart[],
): void {
  const manifestParts = manifestPartsInput.map((part) =>
    ManifestPartSchema.parse(part),
  );
  const receipts = receiptsInput.map((part) =>
    UploadedPartReceiptSchema.parse(part),
  );
  const providerParts = providerPartsInput.map((part) =>
    ProviderListedPartSchema.parse(part),
  );
  if (
    manifestParts.length !== receipts.length ||
    manifestParts.length !== providerParts.length
  ) {
    throw new RecordingProtocolError(
      "multipart_mismatch",
      "Provider part list has a different length",
    );
  }
  manifestParts.forEach((manifestPart, index) => {
    const receipt = receipts[index];
    const providerPart = providerParts[index];
    if (
      receipt === undefined ||
      providerPart === undefined ||
      manifestPart.partNumber !== index + 1 ||
      receipt.partNumber !== manifestPart.partNumber ||
      providerPart.partNumber !== manifestPart.partNumber ||
      providerPart.byteLength !== manifestPart.byteLength ||
      providerPart.etag !== receipt.etag
    ) {
      throw new RecordingProtocolError(
        "multipart_mismatch",
        "Provider part list does not match the authenticated finalization",
      );
    }
  });
}
