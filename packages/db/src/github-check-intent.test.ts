import { describe, expect, it } from "vitest";
import {
  parseGithubCheckIntent,
  type GithubCheckIntent,
} from "./github-production";

const baseIntent: GithubCheckIntent = {
  revisionId: "10000000-0000-4000-8000-000000000001",
  expectedHeadSha: "a".repeat(40),
  idempotencyKey: "check:intent:review-required",
  reason: "review_required",
  name: "SlopProof / understanding required",
  status: "in_progress",
  conclusion: null,
  publicSummary: "maintainer review required for head",
  detailsUrl:
    "https://slopproof.test/revisions/10000000-0000-4000-8000-000000000001",
};

describe("GitHub check intent persist contract", () => {
  it("accepts review_required only as in_progress with no conclusion", () => {
    expect(parseGithubCheckIntent(baseIntent)).toMatchObject({
      reason: "review_required",
      status: "in_progress",
      conclusion: null,
    });
  });

  it("rejects review_required completed+neutral, which would satisfy a required check", () => {
    expect(() =>
      parseGithubCheckIntent({
        ...baseIntent,
        status: "completed",
        conclusion: "neutral",
      }),
    ).toThrow(/review_required checks must stay in_progress/);
  });

  it("keeps completed+neutral only for technical_retry", () => {
    expect(
      parseGithubCheckIntent({
        ...baseIntent,
        idempotencyKey: "check:intent:technical-retry",
        reason: "technical_retry",
        status: "completed",
        conclusion: "neutral",
        publicSummary: "technical retry required for head",
      }),
    ).toMatchObject({
      reason: "technical_retry",
      status: "completed",
      conclusion: "neutral",
    });
  });
});
