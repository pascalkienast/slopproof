import {
  GenerationProviderMaterialV1Schema,
  type GenerationProviderMaterialV1,
} from "@slopproof/analysis";
import { GitShaSchema, Sha256Schema, UuidSchema } from "@slopproof/domain";
import {
  PracticeQuestionCandidateV2Schema,
  ProofQuestionIntentV2Schema,
  type PracticeFeedbackCandidateV1,
  type ProofQuestionCandidateV2,
  type LearningBundleCandidateV1,
} from "@slopproof/questions";
import { z } from "zod";
import { PROVIDER_ERROR_CODES, PROVIDER_FAILURE_KINDS } from "./errors";

export const SemanticProviderPurposeV1Schema = z.enum([
  "learning_material",
  "practice_feedback",
  "proof_questions",
]);

export type SemanticProviderPurposeV1 = z.infer<
  typeof SemanticProviderPurposeV1Schema
>;

export const SemanticProviderDescriptorV1Schema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
  })
  .strict();

export type SemanticProviderDescriptorV1 = z.infer<
  typeof SemanticProviderDescriptorV1Schema
>;

export const SemanticProviderCallContextV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    callId: UuidSchema,
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    contextHash: Sha256Schema,
    purpose: SemanticProviderPurposeV1Schema,
    phase: z.enum(["initial", "repair"]),
    deadlineAt: z.date(),
  })
  .strict();

export type SemanticProviderCallContextV1 = z.infer<
  typeof SemanticProviderCallContextV1Schema
>;

export const SemanticTokenUsageV1Schema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(10_000_000),
    outputTokens: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

export type SemanticTokenUsageV1 = z.infer<typeof SemanticTokenUsageV1Schema>;

/** Raw content is always validated by the worker; only usage metadata is trusted here. */
export const SemanticProviderRawResponseV1Schema = z
  .object({
    output: z.unknown(),
    tokenUsage: SemanticTokenUsageV1Schema.nullable(),
    transportAttemptCount: z.number().int().min(1).max(3).optional(),
  })
  .strict();

export type SemanticProviderRawResponseV1 = z.infer<
  typeof SemanticProviderRawResponseV1Schema
>;

export const SemanticProviderRepairInstructionV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    invalidOutputHash: Sha256Schema,
    validationCode: z.enum([
      "schema_invalid",
      "anchor_invalid",
      "count_invalid",
      "content_policy_invalid",
    ]),
    maximumAdditionalAttempts: z.literal(1),
  })
  .strict();

export type SemanticProviderRepairInstructionV1 = z.infer<
  typeof SemanticProviderRepairInstructionV1Schema
>;

const ProviderVersionsV1Schema = z
  .object({
    promptVersion: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    outputSchemaVersion: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    plannerVersion: z.literal("proof-planner-v2"),
  })
  .strict();

export const LearningMaterialProviderInputV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    inputVersion: z.literal("learning-material-input-v1"),
    generationMaterial: GenerationProviderMaterialV1Schema,
    practiceQuestionCount: z.number().int().min(3).max(5),
    versions: ProviderVersionsV1Schema,
  })
  .strict();

export type LearningMaterialProviderInputV1 = z.infer<
  typeof LearningMaterialProviderInputV1Schema
>;

export const ContributorPracticeAnswerV1Schema = z
  .object({
    trust: z.literal("untrusted"),
    source: z.literal("contributor_answer"),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const PracticeCoachProviderInputV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    inputVersion: z.literal("practice-coach-input-v1"),
    generationMaterial: GenerationProviderMaterialV1Schema,
    practiceQuestion: PracticeQuestionCandidateV2Schema,
    contributorAnswer: ContributorPracticeAnswerV1Schema,
    versions: ProviderVersionsV1Schema,
  })
  .strict();

export type PracticeCoachProviderInputV1 = z.infer<
  typeof PracticeCoachProviderInputV1Schema
>;

export const ProofQuestionProviderInputV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    inputVersion: z.literal("proof-question-input-v1"),
    generationMaterial: GenerationProviderMaterialV1Schema,
    exactCandidateCount: z.number().int().min(1).max(5),
    permittedIntents: z
      .array(ProofQuestionIntentV2Schema)
      .min(1)
      .max(5)
      .superRefine((intents, context) => {
        if (new Set(intents).size !== intents.length) {
          context.addIssue({
            code: "custom",
            message: "Permitted proof intents must be unique",
          });
        }
      }),
    versions: ProviderVersionsV1Schema,
  })
  .strict();

export type ProofQuestionProviderInputV1 = z.infer<
  typeof ProofQuestionProviderInputV1Schema
>;

export const SemanticProviderFailureV1Schema = z
  .object({
    schemaVersion: z.literal("semantic-provider-failure-v1"),
    failureCode: z.enum([
      ...PROVIDER_ERROR_CODES,
      "PROVIDER_DESCRIPTOR_INVALID",
      "SEMANTIC_VALIDATION_FAILED",
      "UNKNOWN",
    ]),
    lastFailureKind: z.enum([
      ...PROVIDER_FAILURE_KINDS,
      "provider_descriptor_invalid",
      "semantic_validation",
      "unknown",
    ]),
    httpStatusClass: z.enum(["4xx", "5xx"]).nullable(),
    transportAttemptCount: z.number().int().min(0).max(6).nullable(),
  })
  .strict()
  .superRefine((failure, context) => {
    const expectedClass =
      failure.lastFailureKind === "rate_limited" ||
      failure.lastFailureKind === "request_rejected"
        ? "4xx"
        : failure.lastFailureKind === "upstream_unavailable"
          ? "5xx"
          : null;
    if (failure.httpStatusClass !== expectedClass) {
      context.addIssue({
        code: "custom",
        path: ["httpStatusClass"],
        message: "HTTP status class does not match the safe failure kind",
      });
    }
  });

export type SemanticProviderFailureV1 = z.infer<
  typeof SemanticProviderFailureV1Schema
>;

export const SemanticProviderInvocationMetadataV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    metadataVersion: z.literal("semantic-provider-metadata-v1"),
    callId: UuidSchema,
    purpose: SemanticProviderPurposeV1Schema,
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    promptVersion: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    outputSchemaVersion: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    plannerVersion: z.literal("proof-planner-v2"),
    inputHash: Sha256Schema,
    outputHash: Sha256Schema,
    tokenUsage: SemanticTokenUsageV1Schema.nullable(),
    latencyMs: z
      .number()
      .int()
      .nonnegative()
      .max(15 * 60_000),
    invocationCount: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    outcome: z.enum(["generated", "repaired", "fallback"]),
    degraded: z.boolean(),
    completedAt: z.date(),
  })
  .strict();

export type SemanticProviderInvocationMetadataV1 = z.infer<
  typeof SemanticProviderInvocationMetadataV1Schema
>;

interface RepairableSemanticProvider<TInput> {
  readonly descriptor: SemanticProviderDescriptorV1;
  generate(
    input: TInput,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1>;
  repair(
    input: TInput,
    instruction: SemanticProviderRepairInstructionV1,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1>;
}

export interface LearningMaterialProvider extends RepairableSemanticProvider<LearningMaterialProviderInputV1> {
  /** Marker keeps accidental port substitution visible to TypeScript. */
  readonly outputContract?: LearningBundleCandidateV1;
}

export interface PracticeCoachProvider extends RepairableSemanticProvider<PracticeCoachProviderInputV1> {
  readonly outputContract?: PracticeFeedbackCandidateV1;
}

export interface ProofQuestionProvider extends RepairableSemanticProvider<ProofQuestionProviderInputV1> {
  readonly outputContract?: readonly ProofQuestionCandidateV2[];
}

export type SemanticProviderInputV1 =
  | LearningMaterialProviderInputV1
  | PracticeCoachProviderInputV1
  | ProofQuestionProviderInputV1;

export function generationMaterialForSemanticProviderV1(
  material: GenerationProviderMaterialV1,
): GenerationProviderMaterialV1 {
  return GenerationProviderMaterialV1Schema.parse(material);
}
