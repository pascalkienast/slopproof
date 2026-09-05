import { GitShaSchema, UuidSchema } from "@understandproof/domain";
import { z } from "zod";

export const RepositoryPolicyV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    decisionMode: z.literal("maintainer_review"),
    proof: z
      .object({
        minimumQuestions: z.number().int().min(1).max(5),
        maximumQuestions: z.number().int().min(1).max(5),
        maximumDurationSeconds: z
          .number()
          .int()
          .min(30)
          .max(30 * 60),
        maximumUploadBytes: z.number().int().min(1).max(2_000_000_000),
      })
      .strict(),
    evidence: z
      .object({
        retentionHours: z.number().int().min(1).max(24),
        deleteAfterMaintainerPass: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.proof.minimumQuestions > policy.proof.maximumQuestions) {
      context.addIssue({
        code: "custom",
        path: ["proof", "minimumQuestions"],
        message: "minimumQuestions must not exceed maximumQuestions",
      });
    }
  });

export type RepositoryPolicyV1 = z.infer<typeof RepositoryPolicyV1Schema>;

export type RecordingProtocolLimits = {
  maximumDurationMs: number;
  maximumUploadBytes: number;
};

export type EffectiveRecordingLimits = RecordingProtocolLimits & {
  retentionHours: number;
  deleteAfterMaintainerPass: boolean;
};

/**
 * Narrows repository policy with non-negotiable protocol ceilings. Browser
 * APIs and workers share this calculation so policy can only tighten SP-RC1.
 */
export function resolveEffectiveRecordingLimits(
  rawPolicy: RepositoryPolicyV1,
  protocol: RecordingProtocolLimits,
): EffectiveRecordingLimits {
  const policy = RepositoryPolicyV1Schema.parse(rawPolicy);
  if (
    !Number.isSafeInteger(protocol.maximumDurationMs) ||
    protocol.maximumDurationMs < 1 ||
    !Number.isSafeInteger(protocol.maximumUploadBytes) ||
    protocol.maximumUploadBytes < 1
  ) {
    throw new Error("Protocol recording limits must be positive safe integers");
  }
  return {
    maximumDurationMs: Math.min(
      protocol.maximumDurationMs,
      policy.proof.maximumDurationSeconds * 1_000,
    ),
    maximumUploadBytes: Math.min(
      protocol.maximumUploadBytes,
      policy.proof.maximumUploadBytes,
    ),
    retentionHours: policy.evidence.retentionHours,
    deleteAfterMaintainerPass: policy.evidence.deleteAfterMaintainerPass,
  };
}

export function calculateEvidenceDeleteAfter(
  acceptedAt: Date,
  retentionHours: number,
): Date {
  if (
    !Number.isFinite(acceptedAt.getTime()) ||
    !Number.isSafeInteger(retentionHours) ||
    retentionHours < 1 ||
    retentionHours > 24
  ) {
    throw new Error("Evidence retention inputs are invalid");
  }
  return new Date(acceptedAt.getTime() + retentionHours * 60 * 60_000);
}

export const DEFAULT_REPOSITORY_POLICY_V1 = Object.freeze({
  schemaVersion: "1",
  decisionMode: "maintainer_review",
  proof: Object.freeze({
    minimumQuestions: 1,
    maximumQuestions: 5,
    maximumDurationSeconds: 10 * 60,
    maximumUploadBytes: 500_000_000,
  }),
  evidence: Object.freeze({
    retentionHours: 24,
    deleteAfterMaintainerPass: true,
  }),
}) satisfies RepositoryPolicyV1;

export const ProviderRecommendationSchema = z.enum([
  "pass",
  "review_required",
  "retry",
]);

export type ProviderRecommendation = z.infer<
  typeof ProviderRecommendationSchema
>;

export const ApplyPolicyV1InputSchema = z
  .object({
    attemptId: UuidSchema,
    revisionId: UuidSchema,
    evaluationId: UuidSchema,
    expectedHeadSha: GitShaSchema,
    currentHeadSha: GitShaSchema,
    recommendation: ProviderRecommendationSchema,
    evaluatedQuestionIds: z.array(UuidSchema).min(1),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      new Set(input.evaluatedQuestionIds).size !==
      input.evaluatedQuestionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["evaluatedQuestionIds"],
        message: "evaluatedQuestionIds must be unique",
      });
    }
  });

export type ApplyPolicyV1Input = z.infer<typeof ApplyPolicyV1InputSchema>;

export const MaintainerReviewPolicyDecisionV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    kind: z.literal("maintainer_review"),
    attemptStatus: z.literal("review_required"),
    checkMutation: z.literal("none"),
    attemptId: UuidSchema,
    revisionId: UuidSchema,
    evaluationId: UuidSchema,
    headSha: GitShaSchema,
    providerRecommendation: ProviderRecommendationSchema,
  })
  .strict();

export type MaintainerReviewPolicyDecisionV1 = z.infer<
  typeof MaintainerReviewPolicyDecisionV1Schema
>;

export class PolicyHeadShaMismatchError extends Error {
  readonly code = "POLICY_HEAD_SHA_MISMATCH" as const;

  constructor() {
    super("Evaluation is not bound to the current pull-request head SHA");
    this.name = "PolicyHeadShaMismatchError";
  }
}

/**
 * Routes a technically valid, schema-checked provider evaluation. In MVP v1,
 * even a provider `pass` is evidence for a human and never a check conclusion.
 */
export function applyRepositoryPolicyV1(
  rawPolicy: RepositoryPolicyV1,
  rawInput: ApplyPolicyV1Input,
): MaintainerReviewPolicyDecisionV1 {
  RepositoryPolicyV1Schema.parse(rawPolicy);
  const input = ApplyPolicyV1InputSchema.parse(rawInput);

  if (input.expectedHeadSha !== input.currentHeadSha) {
    throw new PolicyHeadShaMismatchError();
  }

  return MaintainerReviewPolicyDecisionV1Schema.parse({
    schemaVersion: "1",
    kind: "maintainer_review",
    attemptStatus: "review_required",
    checkMutation: "none",
    attemptId: input.attemptId,
    revisionId: input.revisionId,
    evaluationId: input.evaluationId,
    headSha: input.currentHeadSha,
    providerRecommendation: input.recommendation,
  });
}

export const policyPackage = "@understandproof/policy" as const;
