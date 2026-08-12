import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApplyPolicyV1InputSchema,
  DEFAULT_REPOSITORY_POLICY_V1,
  PolicyHeadShaMismatchError,
  RepositoryPolicyV1Schema,
  applyRepositoryPolicyV1,
  calculateEvidenceDeleteAfter,
  resolveEffectiveRecordingLimits,
  type ProviderRecommendation,
} from "./index";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "10000000-0000-4000-8000-000000000002";
const EVALUATION_ID = "10000000-0000-4000-8000-000000000003";
const QUESTION_ID = "10000000-0000-4000-8000-000000000004";
const SHA = "a".repeat(40);

describe("MVP repository policy v1", () => {
  it.each<ProviderRecommendation>(["pass", "review_required", "retry"])(
    "routes provider recommendation %s to maintainer review without mutating the check",
    (recommendation) => {
      const decision = applyRepositoryPolicyV1(DEFAULT_REPOSITORY_POLICY_V1, {
        attemptId: ATTEMPT_ID,
        revisionId: REVISION_ID,
        evaluationId: EVALUATION_ID,
        expectedHeadSha: SHA,
        currentHeadSha: SHA,
        recommendation,
        evaluatedQuestionIds: [QUESTION_ID],
      });

      expect(decision).toEqual({
        schemaVersion: "1",
        kind: "maintainer_review",
        attemptStatus: "review_required",
        checkMutation: "none",
        attemptId: ATTEMPT_ID,
        revisionId: REVISION_ID,
        evaluationId: EVALUATION_ID,
        headSha: SHA,
        providerRecommendation: recommendation,
      });
    },
  );

  it("does not accept calibrated_auto_pass as configuration", () => {
    expect(() =>
      RepositoryPolicyV1Schema.parse({
        ...DEFAULT_REPOSITORY_POLICY_V1,
        decisionMode: "calibrated_auto_pass",
      }),
    ).toThrow(z.ZodError);
  });

  it("uses the stricter repository/protocol limits and derives retention from acceptance", () => {
    expect(
      resolveEffectiveRecordingLimits(
        {
          ...DEFAULT_REPOSITORY_POLICY_V1,
          proof: {
            ...DEFAULT_REPOSITORY_POLICY_V1.proof,
            maximumDurationSeconds: 900,
            maximumUploadBytes: 32_000_000,
          },
          evidence: {
            retentionHours: 6,
            deleteAfterMaintainerPass: false,
          },
        },
        { maximumDurationMs: 480_000, maximumUploadBytes: 128_000_000 },
      ),
    ).toEqual({
      maximumDurationMs: 480_000,
      maximumUploadBytes: 32_000_000,
      retentionHours: 6,
      deleteAfterMaintainerPass: false,
    });
    expect(
      calculateEvidenceDeleteAfter(
        new Date("2030-01-01T00:00:00.000Z"),
        6,
      ).toISOString(),
    ).toBe("2030-01-01T06:00:00.000Z");
  });

  it("rejects unknown configuration and invalid question budgets", () => {
    expect(() =>
      RepositoryPolicyV1Schema.parse({
        ...DEFAULT_REPOSITORY_POLICY_V1,
        autoPassThreshold: 0.95,
      }),
    ).toThrow(z.ZodError);

    expect(() =>
      RepositoryPolicyV1Schema.parse({
        ...DEFAULT_REPOSITORY_POLICY_V1,
        proof: {
          ...DEFAULT_REPOSITORY_POLICY_V1.proof,
          minimumQuestions: 5,
          maximumQuestions: 2,
        },
      }),
    ).toThrow("minimumQuestions must not exceed maximumQuestions");
  });

  it("rejects stale SHA, duplicate questions and unknown input fields", () => {
    expect(() =>
      applyRepositoryPolicyV1(DEFAULT_REPOSITORY_POLICY_V1, {
        attemptId: ATTEMPT_ID,
        revisionId: REVISION_ID,
        evaluationId: EVALUATION_ID,
        expectedHeadSha: SHA,
        currentHeadSha: "b".repeat(40),
        recommendation: "pass",
        evaluatedQuestionIds: [QUESTION_ID],
      }),
    ).toThrow(PolicyHeadShaMismatchError);

    expect(() =>
      ApplyPolicyV1InputSchema.parse({
        attemptId: ATTEMPT_ID,
        revisionId: REVISION_ID,
        evaluationId: EVALUATION_ID,
        expectedHeadSha: SHA,
        currentHeadSha: SHA,
        recommendation: "pass",
        evaluatedQuestionIds: [QUESTION_ID, QUESTION_ID],
      }),
    ).toThrow("evaluatedQuestionIds must be unique");

    expect(() =>
      ApplyPolicyV1InputSchema.parse({
        attemptId: ATTEMPT_ID,
        revisionId: REVISION_ID,
        evaluationId: EVALUATION_ID,
        expectedHeadSha: SHA,
        currentHeadSha: SHA,
        recommendation: "pass",
        evaluatedQuestionIds: [QUESTION_ID],
        modelScore: 0.99,
      }),
    ).toThrow(z.ZodError);
  });
});
