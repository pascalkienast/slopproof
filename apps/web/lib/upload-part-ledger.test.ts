import { describe, expect, it } from "vitest";
import { storedUploadPartMatches } from "./upload-part-ledger";

const expected = {
  partNumber: 1,
  firstChunkIndex: 0,
  lastChunkIndex: 37,
  byteLength: 2_712_801,
  sha256: "70e3a45b033f6f2e96c111c54ae7e12edc3722d51051639668cf51be40f813d7",
};

const stored = {
  part_number: 1,
  first_chunk_index: 0,
  last_chunk_index: 37,
  byte_length: "2712801",
  sha256: expected.sha256,
  etag: '"e4aab7a949e42d795ad7d5932319466e"',
};

describe("upload part ledger", () => {
  it("matches PostgreSQL bigint strings to validated manifest integers", () => {
    expect(storedUploadPartMatches(stored, expected, stored.etag)).toBe(true);
  });

  it("rejects a changed byte length or transport receipt", () => {
    expect(
      storedUploadPartMatches(
        stored,
        { ...expected, byteLength: expected.byteLength + 1 },
        stored.etag,
      ),
    ).toBe(false);
    expect(storedUploadPartMatches(stored, expected, '"other"')).toBe(false);
  });
});
