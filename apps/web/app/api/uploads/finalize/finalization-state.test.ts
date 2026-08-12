import { describe, expect, it } from "vitest";
import { classifyUploadFinalization } from "./finalization-state";

const future = new Date("2026-08-12T12:00:00.000Z");
const now = new Date("2026-08-12T10:00:00.000Z");
const digest = "a".repeat(64);

describe("upload finalization HTTP state", () => {
  it("allows the first accepted finalization to reach provider verification", () => {
    expect(
      classifyUploadFinalization(
        {
          uploadState: "active",
          attemptStatus: "uploading",
          uploadExpiresAt: future,
          storedManifestDigest: null,
        },
        digest,
        now,
      ),
    ).toBe("fresh");
  });

  it("lets an identical pending finalization reach the transactional replay branch", () => {
    expect(
      classifyUploadFinalization(
        {
          uploadState: "pending_finalization",
          attemptStatus: "processing",
          uploadExpiresAt: future,
          storedManifestDigest: digest,
        },
        digest,
        now,
      ),
    ).toBe("replay");
  });

  it("rejects a changed digest and expired upload", () => {
    const state = {
      uploadState: "pending_finalization",
      attemptStatus: "processing",
      uploadExpiresAt: future,
      storedManifestDigest: digest,
    };
    expect(classifyUploadFinalization(state, "b".repeat(64), now)).toBe(
      "reject",
    );
    expect(
      classifyUploadFinalization(
        { ...state, uploadExpiresAt: now },
        digest,
        now,
      ),
    ).toBe("reject");
  });
});
