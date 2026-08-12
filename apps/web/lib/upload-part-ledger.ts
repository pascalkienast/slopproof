export type StoredUploadPart = {
  part_number: number;
  first_chunk_index: number;
  last_chunk_index: number;
  byte_length: string;
  sha256: string;
  etag: string;
};

export type ExpectedUploadPart = {
  partNumber: number;
  firstChunkIndex: number;
  lastChunkIndex: number;
  byteLength: number;
  sha256: string;
};

export function storedUploadPartMatches(
  stored: StoredUploadPart,
  expected: ExpectedUploadPart,
  etag: string,
): boolean {
  return (
    stored.part_number === expected.partNumber &&
    stored.first_chunk_index === expected.firstChunkIndex &&
    stored.last_chunk_index === expected.lastChunkIndex &&
    stored.byte_length === String(expected.byteLength) &&
    stored.sha256 === expected.sha256 &&
    stored.etag === etag
  );
}
