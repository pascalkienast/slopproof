import { describe, expect, it } from "vitest";
import {
  ReviewDecisionInputSchema,
  planReviewDecision,
  shouldAccelerateEvidenceDeletion,
} from "./maintainer-review";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@understandproof/policy";

const headSha = "a".repeat(40);

describe("maintainer review decisions", () => {
  it.each([
    ["approve", "pass", "passed", "success", "maintainer_approved"],
    [
      "reject",
      "retry",
      "retry_required",
      "action_required",
      "maintainer_rejected",
    ],
    [
      "manual_retry",
      "retry",
      "technical_retry",
      "action_required",
      "manual_retry",
    ],
  ] as const)(
    "maps %s to a manual append-only decision",
    (action, databaseDecision, targetStatus, conclusion, reasonCode) => {
      expect(planReviewDecision(action, headSha)).toEqual({
        databaseDecision,
        targetStatus,
        reasonCode,
        checkConclusion: conclusion,
        publicSummary:
          action === "approve"
            ? `passed ${headSha}`
            : action === "reject"
              ? `action required ${headSha}`
              : `technical retry ${headSha}`,
      });
    },
  );

  it("accepts only strict manual actions and a bound current SHA", () => {
    const valid = {
      action: "approve",
      expectedHeadSha: headSha,
      explanation: "The answers cover the stored rubric.",
      idempotencyKey: "review:10000000-0000-4000-8000-000000000001",
    };
    expect(ReviewDecisionInputSchema.parse(valid)).toEqual(valid);
    expect(() =>
      ReviewDecisionInputSchema.parse({ ...valid, action: "auto_pass" }),
    ).toThrow();
    expect(() =>
      ReviewDecisionInputSchema.parse({ ...valid, modelScore: 0.99 }),
    ).toThrow();
    expect(planReviewDecision("approve", headSha).publicSummary).toMatch(
      /^passed [0-9a-f]{40}$/,
    );
  });

  it("accelerates deletion only after a pass when the frozen policy opts in", () => {
    expect(
      shouldAccelerateEvidenceDeletion("approve", DEFAULT_REPOSITORY_POLICY_V1),
    ).toBe(true);
    expect(
      shouldAccelerateEvidenceDeletion("reject", DEFAULT_REPOSITORY_POLICY_V1),
    ).toBe(false);
    expect(
      shouldAccelerateEvidenceDeletion("approve", {
        ...DEFAULT_REPOSITORY_POLICY_V1,
        evidence: {
          ...DEFAULT_REPOSITORY_POLICY_V1.evidence,
          deleteAfterMaintainerPass: false,
        },
      }),
    ).toBe(false);
  });
});
