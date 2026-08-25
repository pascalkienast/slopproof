import { describe, expect, it } from "vitest";
import {
  ATTEMPT_EXPIRED_GITHUB_CHECK,
  REVIEW_REQUIRED_GITHUB_CHECK,
  TECHNICAL_RETRY_GITHUB_CHECK,
  requiredCheckSatisfiesMergeGate,
} from "./check-gate";

describe("GitHub required-check merge gate", () => {
  it("keeps review_required in_progress with no conclusion", () => {
    expect(REVIEW_REQUIRED_GITHUB_CHECK).toEqual({
      status: "in_progress",
      conclusion: null,
    });
  });

  it("does not treat waiting-for-review as a satisfied required check", () => {
    expect(
      requiredCheckSatisfiesMergeGate(
        REVIEW_REQUIRED_GITHUB_CHECK.status,
        REVIEW_REQUIRED_GITHUB_CHECK.conclusion,
      ),
    ).toBe(false);
    expect(requiredCheckSatisfiesMergeGate("queued", null)).toBe(false);
    expect(requiredCheckSatisfiesMergeGate("in_progress", null)).toBe(false);
  });

  it("models completed+neutral as satisfied but never uses it for retry or expiry", () => {
    expect(requiredCheckSatisfiesMergeGate("completed", "neutral")).toBe(true);
    for (const check of [
      TECHNICAL_RETRY_GITHUB_CHECK,
      ATTEMPT_EXPIRED_GITHUB_CHECK,
    ]) {
      expect(check).toEqual({
        status: "completed",
        conclusion: "action_required",
      });
      expect(
        requiredCheckSatisfiesMergeGate(check.status, check.conclusion),
      ).toBe(false);
    }
    expect(REVIEW_REQUIRED_GITHUB_CHECK).not.toEqual(
      TECHNICAL_RETRY_GITHUB_CHECK,
    );
    expect(REVIEW_REQUIRED_GITHUB_CHECK.conclusion).not.toBe("neutral");
    expect(REVIEW_REQUIRED_GITHUB_CHECK.status).not.toBe("completed");
  });

  it("blocks merge on maintainer reject and allows it only after approve", () => {
    expect(
      requiredCheckSatisfiesMergeGate("completed", "action_required"),
    ).toBe(false);
    expect(requiredCheckSatisfiesMergeGate("completed", "success")).toBe(true);
    expect(requiredCheckSatisfiesMergeGate("completed", "cancelled")).toBe(
      false,
    );
  });
});
