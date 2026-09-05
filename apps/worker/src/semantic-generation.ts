import { createHash } from "node:crypto";
import {
  GenerationContextV1Schema,
  projectGenerationProviderMaterialV1,
  type GenerationContextV1,
} from "@understandproof/analysis";
import {
  ContributorPracticeAnswerV1Schema,
  LearningMaterialProviderInputV1Schema,
  PracticeCoachProviderInputV1Schema,
  ProviderError,
  ProofQuestionProviderInputV1Schema,
  safeHttpStatus,
  SemanticProviderCallContextV1Schema,
  SemanticProviderDescriptorV1Schema,
  SemanticProviderInvocationMetadataV1Schema,
  SemanticProviderRawResponseV1Schema,
  SemanticProviderRepairInstructionV1Schema,
  type LearningMaterialProvider,
  type PracticeCoachProvider,
  type ProofQuestionProvider,
  type SemanticProviderCallContextV1,
  type SemanticProviderDescriptorV1,
  type SemanticProviderFailureV1,
  type SemanticProviderInputV1,
  type SemanticProviderInvocationMetadataV1,
  type SemanticMalformedOutputKindV1,
  type SemanticProviderPurposeV1,
  type SemanticProviderRawResponseV1,
  type SemanticTokenUsageV1,
} from "@understandproof/providers";
import {
  ForbiddenProofContentV1Schema,
  LearningBundleV1Schema,
  PracticeFeedbackV1Schema,
  PracticeQuestionV2Schema,
  ProofQuestionPlanV2Schema,
  SemanticContentValidationError,
  deterministicLearningFallbackV1,
  deterministicPracticeFeedbackFallbackV1,
  deterministicProofFallbackV2,
  validateLearningBundleCandidateV1,
  validatePracticeFeedbackCandidateV1,
  validatePracticeQuestionV2AgainstContext,
  validateProofQuestionCandidatesV2,
  type LearningBundleCandidateV1,
  type LearningBundleV1,
  type PracticeFeedbackCandidateV1,
  type PracticeFeedbackV1,
  type PracticeQuestionV2,
  type ProofQuestionCandidateV2,
  type ProofQuestionPlanV2,
  type SemanticContentValidationCode,
} from "@understandproof/questions";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const MAX_PROVIDER_OUTPUT_HASH_BYTES = 2 * 1_024 * 1_024;
const MAX_GENERATION_DEADLINE_MS = 10 * 60_000;
const MAX_PRIVATE_RETENTION_MS = 24 * 60 * 60_000;

const SemanticGenerationRequestBaseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    generationContext: GenerationContextV1Schema,
    artifactSeed: Sha256Schema,
    artifactCreatedAt: z.date(),
    deadlineAt: z.date(),
    deleteAfter: z.date(),
  })
  .strict();

export const GenerateLearningBundleRequestV1Schema =
  SemanticGenerationRequestBaseSchema.extend({
    requestVersion: z.literal("generate-learning-bundle-v1"),
    practiceQuestionCount: z.number().int().min(3).max(5),
    forbiddenProofContent: ForbiddenProofContentV1Schema,
  })
    .strict()
    .superRefine(validateServerTimingAndAnchors);

export type GenerateLearningBundleRequestV1 = z.infer<
  typeof GenerateLearningBundleRequestV1Schema
>;

export const GeneratePracticeFeedbackRequestV1Schema =
  SemanticGenerationRequestBaseSchema.extend({
    requestVersion: z.literal("generate-practice-feedback-v1"),
    practiceQuestion: PracticeQuestionV2Schema,
    contributorAnswer: ContributorPracticeAnswerV1Schema,
    forbiddenProofContent: ForbiddenProofContentV1Schema,
  })
    .strict()
    .superRefine((request, context) => {
      validateServerTimingAndAnchors(request, context);
      if (
        request.practiceQuestion.revisionId !==
          request.generationContext.revisionId ||
        request.practiceQuestion.headSha !==
          request.generationContext.headSha ||
        request.practiceQuestion.contextHash !==
          request.generationContext.contextHash
      ) {
        context.addIssue({
          code: "custom",
          path: ["practiceQuestion"],
          message: "Practice question does not match the generation context",
        });
      }
    });

export type GeneratePracticeFeedbackRequestV1 = z.infer<
  typeof GeneratePracticeFeedbackRequestV1Schema
>;

export const GenerateProofQuestionPlanRequestV1Schema =
  SemanticGenerationRequestBaseSchema.extend({
    requestVersion: z.literal("generate-proof-question-plan-v1"),
    questionBudget: z.number().int().min(1).max(5),
  })
    .strict()
    .superRefine(validateServerTimingAndAnchors);

export type GenerateProofQuestionPlanRequestV1 = z.infer<
  typeof GenerateProofQuestionPlanRequestV1Schema
>;

export type SemanticGenerationResultV1<TArtifact> = {
  artifact: TArtifact;
  providerMetadata: SemanticProviderInvocationMetadataV1;
  providerFailure: SemanticProviderFailureV1 | null;
  degraded: boolean;
};

export interface SemanticGenerationClock {
  now(): Date;
  monotonicNowMs(): number;
}

export type SemanticGenerationDependencies = {
  learningMaterialProvider: LearningMaterialProvider;
  practiceCoachProvider: PracticeCoachProvider;
  proofQuestionProvider: ProofQuestionProvider;
  clock: SemanticGenerationClock;
};

export type SemanticGenerationService = {
  generateLearningBundle(
    request: unknown,
  ): Promise<SemanticGenerationResultV1<LearningBundleV1>>;
  generatePracticeFeedback(
    request: unknown,
  ): Promise<SemanticGenerationResultV1<PracticeFeedbackV1>>;
  generateProofQuestionPlan(
    request: unknown,
  ): Promise<SemanticGenerationResultV1<ProofQuestionPlanV2>>;
};

type RepairableProvider<TInput extends SemanticProviderInputV1> = {
  readonly descriptor: SemanticProviderDescriptorV1;
  generate(
    input: TInput,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1>;
  repair(
    input: TInput,
    instruction: z.infer<typeof SemanticProviderRepairInstructionV1Schema>,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1>;
};

type InvocationOutcome<TOutput> = {
  output: TOutput;
  metadata: SemanticProviderInvocationMetadataV1;
  failure: SemanticProviderFailureV1 | null;
};

export function createSemanticGenerationService(
  dependencies: SemanticGenerationDependencies,
): SemanticGenerationService {
  return {
    async generateLearningBundle(rawRequest) {
      const request = GenerateLearningBundleRequestV1Schema.parse(rawRequest);
      const providerInput = LearningMaterialProviderInputV1Schema.parse({
        schemaVersion: "1",
        inputVersion: "learning-material-input-v1",
        generationMaterial: projectGenerationProviderMaterialV1(
          request.generationContext,
        ),
        practiceQuestionCount: request.practiceQuestionCount,
        versions: {
          promptVersion: "learning-system-v1",
          outputSchemaVersion: "learning-bundle-v1",
          plannerVersion: "proof-planner-v2",
        },
      });
      const invocation = await invokeWithOneRepair({
        provider: dependencies.learningMaterialProvider,
        input: providerInput,
        generationContext: request.generationContext,
        purpose: "learning_material",
        artifactSeed: request.artifactSeed,
        deadlineAt: request.deadlineAt,
        promptVersion: providerInput.versions.promptVersion,
        outputSchemaVersion: providerInput.versions.outputSchemaVersion,
        validate: (output) =>
          validateLearningBundleCandidateV1(
            output,
            request.generationContext,
            request.practiceQuestionCount,
            request.forbiddenProofContent,
          ),
        fallback: () =>
          deterministicLearningFallbackV1(
            request.generationContext,
            request.practiceQuestionCount,
            request.forbiddenProofContent,
          ),
        clock: dependencies.clock,
      });
      const artifact = bindLearningBundle(
        request,
        invocation.output,
        invocation.metadata,
      );
      return {
        artifact,
        providerMetadata: invocation.metadata,
        providerFailure: invocation.failure,
        degraded: invocation.metadata.degraded,
      };
    },

    async generatePracticeFeedback(rawRequest) {
      const request = GeneratePracticeFeedbackRequestV1Schema.parse(rawRequest);
      validatePracticeQuestionV2AgainstContext(
        request.practiceQuestion,
        request.generationContext,
      );
      const providerInput = PracticeCoachProviderInputV1Schema.parse({
        schemaVersion: "1",
        inputVersion: "practice-coach-input-v1",
        generationMaterial: projectGenerationProviderMaterialV1(
          request.generationContext,
        ),
        practiceQuestion: practiceQuestionForProvider(request.practiceQuestion),
        contributorAnswer: request.contributorAnswer,
        versions: {
          promptVersion: "practice-coach-system-v1",
          outputSchemaVersion: "practice-feedback-v1",
          plannerVersion: "proof-planner-v2",
        },
      });
      const invocation = await invokeWithOneRepair({
        provider: dependencies.practiceCoachProvider,
        input: providerInput,
        generationContext: request.generationContext,
        purpose: "practice_feedback",
        artifactSeed: request.artifactSeed,
        deadlineAt: request.deadlineAt,
        promptVersion: providerInput.versions.promptVersion,
        outputSchemaVersion: providerInput.versions.outputSchemaVersion,
        validate: (output) =>
          validatePracticeFeedbackCandidateV1(
            output,
            request.generationContext,
            request.practiceQuestion,
            request.forbiddenProofContent,
          ),
        fallback: () =>
          deterministicPracticeFeedbackFallbackV1(
            request.generationContext,
            request.practiceQuestion,
            request.forbiddenProofContent,
          ),
        clock: dependencies.clock,
      });
      const artifact = bindPracticeFeedback(
        request,
        invocation.output,
        invocation.metadata,
      );
      return {
        artifact,
        providerMetadata: invocation.metadata,
        providerFailure: invocation.failure,
        degraded: invocation.metadata.degraded,
      };
    },

    async generateProofQuestionPlan(rawRequest) {
      const request =
        GenerateProofQuestionPlanRequestV1Schema.parse(rawRequest);
      const providerInput = ProofQuestionProviderInputV1Schema.parse({
        schemaVersion: "1",
        inputVersion: "proof-question-input-v1",
        generationMaterial: projectGenerationProviderMaterialV1(
          request.generationContext,
        ),
        exactCandidateCount: request.questionBudget,
        permittedIntents: [
          "explain",
          "predict",
          "tradeoff",
          "failure_path",
          "test_and_rollback",
        ],
        versions: {
          promptVersion: "proof-question-system-v2",
          outputSchemaVersion: "proof-question-candidate-v2",
          plannerVersion: "proof-planner-v2",
        },
      });
      const invocation = await invokeWithOneRepair({
        provider: dependencies.proofQuestionProvider,
        input: providerInput,
        generationContext: request.generationContext,
        purpose: "proof_questions",
        artifactSeed: request.artifactSeed,
        deadlineAt: request.deadlineAt,
        promptVersion: providerInput.versions.promptVersion,
        outputSchemaVersion: providerInput.versions.outputSchemaVersion,
        validate: (output) =>
          validateProofQuestionCandidatesV2(
            output,
            request.generationContext,
            request.questionBudget,
          ),
        fallback: () =>
          deterministicProofFallbackV2(
            request.generationContext,
            request.questionBudget,
          ),
        clock: dependencies.clock,
      });
      const artifact = bindProofQuestionPlan(
        request,
        invocation.output,
        invocation.metadata,
      );
      return {
        artifact,
        providerMetadata: invocation.metadata,
        providerFailure: invocation.failure,
        degraded: invocation.metadata.degraded,
      };
    },
  };
}

async function invokeWithOneRepair<
  TInput extends SemanticProviderInputV1,
  TOutput,
>(input: {
  provider: RepairableProvider<TInput>;
  input: TInput;
  generationContext: GenerationContextV1;
  purpose: SemanticProviderPurposeV1;
  artifactSeed: string;
  deadlineAt: Date;
  promptVersion: string;
  outputSchemaVersion: string;
  validate(output: unknown): TOutput;
  fallback(): TOutput;
  clock: SemanticGenerationClock;
}): Promise<InvocationOutcome<TOutput>> {
  const descriptor = SemanticProviderDescriptorV1Schema.safeParse(
    input.provider.descriptor,
  );
  const startedAt = input.clock.monotonicNowMs();
  const callId = deterministicUuid(
    `${input.artifactSeed}:${input.purpose}:provider-call`,
  );
  let invocationCount: 0 | 1 | 2 = 0;
  let tokenUsage: SemanticTokenUsageV1 | null = null;
  let accepted: TOutput | undefined;
  let outcome: "generated" | "repaired" | "fallback" = "fallback";
  let rejectedOutput: unknown = null;
  let validationCode: SemanticContentValidationCode = "schema_invalid";
  let repairEligible = false;
  let malformedOutputKind: SemanticMalformedOutputKindV1 | null = null;
  let knownTransportAttemptCount: number | null = null;
  let failure: SemanticProviderFailureV1 | undefined;
  let answeredBy = descriptor.success ? descriptor.data : undefined;

  if (
    descriptor.success &&
    input.clock.now().getTime() < input.deadlineAt.getTime()
  ) {
    invocationCount = 1;
    try {
      const rawResponse: unknown = await input.provider.generate(
        input.input,
        providerCallContext(input, callId, "initial"),
      );
      const response =
        SemanticProviderRawResponseV1Schema.safeParse(rawResponse);
      if (
        response.success &&
        response.data.transportAttemptCount !== undefined
      ) {
        knownTransportAttemptCount = addTransportAttempts(
          knownTransportAttemptCount,
          response.data.transportAttemptCount,
        );
      }
      rejectedOutput = response.success ? response.data.output : rawResponse;
      if (response.success) {
        tokenUsage = addUsage(tokenUsage, response.data.tokenUsage);
        malformedOutputKind = response.data.malformedOutputKind ?? null;
        if (response.data.answeredBy !== undefined) {
          answeredBy = response.data.answeredBy;
        }
      }
      if (!response.success) {
        throw new SemanticContentValidationError("schema_invalid");
      }
      accepted = input.validate(response.data.output);
      outcome = "generated";
    } catch (error) {
      if (error instanceof SemanticContentValidationError) {
        validationCode = error.validationCode;
        repairEligible = true;
      } else {
        const captured = captureProviderFailure(
          error,
          knownTransportAttemptCount,
        );
        knownTransportAttemptCount = captured.transportAttemptCount;
        failure = captured.failure;
      }
    }

    if (
      accepted === undefined &&
      repairEligible &&
      input.clock.now().getTime() < input.deadlineAt.getTime()
    ) {
      invocationCount = 2;
      try {
        const instruction = SemanticProviderRepairInstructionV1Schema.parse({
          schemaVersion: "1",
          invalidOutputHash: hashUnknown(rejectedOutput),
          validationCode,
          maximumAdditionalAttempts: 1,
        });
        const rawRepair: unknown = await input.provider.repair(
          input.input,
          instruction,
          providerCallContext(input, callId, "repair"),
        );
        const repair = SemanticProviderRawResponseV1Schema.safeParse(rawRepair);
        if (repair.success && repair.data.transportAttemptCount !== undefined) {
          knownTransportAttemptCount = addTransportAttempts(
            knownTransportAttemptCount,
            repair.data.transportAttemptCount,
          );
        }
        if (repair.success) {
          tokenUsage = addUsage(tokenUsage, repair.data.tokenUsage);
          malformedOutputKind = repair.data.malformedOutputKind ?? null;
          if (repair.data.answeredBy !== undefined) {
            answeredBy = repair.data.answeredBy;
          }
        }
        if (!repair.success) {
          throw new SemanticContentValidationError("schema_invalid");
        }
        accepted = input.validate(repair.data.output);
        outcome = "repaired";
      } catch (error) {
        if (error instanceof SemanticContentValidationError) {
          failure = semanticValidationFailure(
            knownTransportAttemptCount,
            malformedOutputKind,
          );
        } else {
          const captured = captureProviderFailure(
            error,
            knownTransportAttemptCount,
          );
          knownTransportAttemptCount = captured.transportAttemptCount;
          failure = captured.failure;
        }
        accepted = undefined;
      }
    }
  }

  const output = accepted ?? input.fallback();
  if (accepted === undefined) outcome = "fallback";
  if (outcome === "fallback" && failure === undefined) {
    failure = !descriptor.success
      ? {
          schemaVersion: "semantic-provider-failure-v1",
          failureCode: "PROVIDER_DESCRIPTOR_INVALID",
          lastFailureKind: "provider_descriptor_invalid",
          httpStatusClass: null,
          transportAttemptCount: 0,
        }
      : invocationCount === 0
        ? {
            schemaVersion: "semantic-provider-failure-v1",
            failureCode: "DEADLINE_EXCEEDED",
            lastFailureKind: "deadline_exceeded",
            httpStatusClass: null,
            transportAttemptCount: 0,
          }
        : semanticValidationFailure(knownTransportAttemptCount);
  }
  const completedAt = input.clock.now();
  const safeDescriptor =
    outcome === "fallback"
      ? descriptor.success
        ? descriptor.data
        : { provider: "unavailable", model: "unavailable" }
      : (answeredBy ??
        (descriptor.success
          ? descriptor.data
          : { provider: "unavailable", model: "unavailable" }));
  const metadata = SemanticProviderInvocationMetadataV1Schema.parse({
    schemaVersion: "1",
    metadataVersion: "semantic-provider-metadata-v1",
    callId,
    purpose: input.purpose,
    provider: safeDescriptor.provider,
    model: safeDescriptor.model,
    promptVersion: input.promptVersion,
    outputSchemaVersion: input.outputSchemaVersion,
    plannerVersion: "proof-planner-v2",
    inputHash: hashUnknown(input.input),
    outputHash: hashUnknown(output),
    tokenUsage,
    latencyMs: Math.min(
      15 * 60_000,
      Math.max(0, Math.floor(input.clock.monotonicNowMs() - startedAt)),
    ),
    invocationCount,
    outcome,
    degraded: outcome === "fallback",
    completedAt,
  });
  return {
    output,
    metadata,
    failure: outcome === "fallback" ? (failure ?? null) : null,
  };
}

function addTransportAttempts(
  current: number | null,
  additional: number,
): number {
  return Math.min(6, (current ?? 0) + additional);
}

function captureProviderFailure(
  error: unknown,
  currentTransportAttemptCount: number | null,
): {
  failure: SemanticProviderFailureV1;
  transportAttemptCount: number | null;
} {
  if (error instanceof ProviderError) {
    const transportAttemptCount =
      error.telemetry === undefined
        ? currentTransportAttemptCount
        : addTransportAttempts(
            currentTransportAttemptCount,
            error.telemetry.transportAttemptCount,
          );
    return {
      failure: providerErrorFailure(error, transportAttemptCount),
      transportAttemptCount,
    };
  }
  return {
    failure: {
      schemaVersion: "semantic-provider-failure-v1",
      failureCode: "UNKNOWN",
      lastFailureKind: "unknown",
      httpStatusClass: null,
      transportAttemptCount: currentTransportAttemptCount,
    },
    transportAttemptCount: currentTransportAttemptCount,
  };
}

function providerErrorFailure(
  error: ProviderError,
  transportAttemptCount: number | null,
): SemanticProviderFailureV1 {
  const httpStatus = safeHttpStatus(error.telemetry?.httpStatus);
  return {
    schemaVersion: "semantic-provider-failure-v1",
    failureCode: error.code,
    lastFailureKind:
      error.telemetry?.lastFailureKind ??
      (error.code === "DEADLINE_EXCEEDED"
        ? "deadline_exceeded"
        : error.code === "INVALID_OUTPUT"
          ? "invalid_output"
          : "unknown"),
    httpStatusClass: error.telemetry?.httpStatusClass ?? null,
    transportAttemptCount,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function semanticValidationFailure(
  transportAttemptCount: number | null,
  malformedOutputKind: SemanticMalformedOutputKindV1 | null = null,
): SemanticProviderFailureV1 {
  if (malformedOutputKind !== null) {
    return {
      schemaVersion: "semantic-provider-failure-v1",
      failureCode: "INVALID_OUTPUT",
      lastFailureKind: malformedOutputKind,
      httpStatusClass: null,
      transportAttemptCount,
    };
  }
  return {
    schemaVersion: "semantic-provider-failure-v1",
    failureCode: "SEMANTIC_VALIDATION_FAILED",
    lastFailureKind: "semantic_validation",
    httpStatusClass: null,
    transportAttemptCount,
  };
}

function providerCallContext(
  input: {
    generationContext: GenerationContextV1;
    purpose: SemanticProviderPurposeV1;
    deadlineAt: Date;
  },
  callId: string,
  phase: "initial" | "repair",
): SemanticProviderCallContextV1 {
  return SemanticProviderCallContextV1Schema.parse({
    schemaVersion: "1",
    callId,
    revisionId: input.generationContext.revisionId,
    headSha: input.generationContext.headSha,
    contextHash: input.generationContext.contextHash,
    purpose: input.purpose,
    phase,
    deadlineAt: input.deadlineAt,
  });
}

function bindLearningBundle(
  request: GenerateLearningBundleRequestV1,
  content: LearningBundleCandidateV1,
  metadata: SemanticProviderInvocationMetadataV1,
): LearningBundleV1 {
  const binding = artifactBinding(
    request,
    "learning-bundle",
    content,
    metadata,
  );
  return LearningBundleV1Schema.parse({
    ...binding,
    schemaVersion: content.schemaVersion,
    learningVersion: content.learningVersion,
    patchIntent: content.patchIntent,
    changedAreas: content.changedAreas,
    behaviors: content.behaviors,
    interfaces: content.interfaces,
    risks: content.risks,
    testGaps: content.testGaps,
    testIdeas: content.testIdeas,
    rollbackSignals: content.rollbackSignals,
    practiceQuestions: content.practiceQuestions.map((question, index) =>
      PracticeQuestionV2Schema.parse({
        ...question,
        id: deterministicUuid(
          `${request.artifactSeed}:practice-question:${String(index)}`,
        ),
        order: index + 1,
        revisionId: request.generationContext.revisionId,
        headSha: request.generationContext.headSha,
        contextHash: request.generationContext.contextHash,
      }),
    ),
  });
}

function bindPracticeFeedback(
  request: GeneratePracticeFeedbackRequestV1,
  content: PracticeFeedbackCandidateV1,
  metadata: SemanticProviderInvocationMetadataV1,
): PracticeFeedbackV1 {
  return PracticeFeedbackV1Schema.parse({
    ...artifactBinding(request, "practice-feedback", content, metadata),
    ...content,
    practiceQuestionId: request.practiceQuestion.id,
    privateToPracticeSession: true,
  });
}

function practiceQuestionForProvider(question: PracticeQuestionV2) {
  return {
    schemaVersion: question.schemaVersion,
    questionVersion: question.questionVersion,
    focus: question.focus,
    prompt: question.prompt,
    anchorIds: question.anchorIds,
    patchReferences: question.patchReferences,
    privateToPracticeSession: question.privateToPracticeSession,
  } as const;
}

function bindProofQuestionPlan(
  request: GenerateProofQuestionPlanRequestV1,
  content: ProofQuestionCandidateV2[],
  metadata: SemanticProviderInvocationMetadataV1,
): ProofQuestionPlanV2 {
  const binding = artifactBinding(
    request,
    "proof-question-plan",
    content,
    metadata,
  );
  const questions = content.map((question, index) => ({
    ...question,
    id: deterministicUuid(
      `${request.artifactSeed}:proof-question:${String(index)}`,
    ),
    order: index + 1,
    revisionId: request.generationContext.revisionId,
    headSha: request.generationContext.headSha,
    contextHash: request.generationContext.contextHash,
  }));
  const withoutPlanHash = {
    ...binding,
    schemaVersion: "2" as const,
    planVersion: "proof-question-plan-v2" as const,
    plannerVersion: "proof-planner-v2" as const,
    questionBudget: request.questionBudget,
    questions,
  };
  return ProofQuestionPlanV2Schema.parse({
    ...withoutPlanHash,
    planHash: hashUnknown(withoutPlanHash),
  });
}

function artifactBinding(
  request: {
    artifactSeed: string;
    artifactCreatedAt: Date;
    deleteAfter: Date;
    generationContext: GenerationContextV1;
  },
  kind: string,
  content: unknown,
  metadata: SemanticProviderInvocationMetadataV1,
) {
  return {
    id: deterministicUuid(`${request.artifactSeed}:${kind}`),
    revisionId: request.generationContext.revisionId,
    headSha: request.generationContext.headSha,
    contextHash: request.generationContext.contextHash,
    contentHash: hashUnknown(content),
    generationOutcome: metadata.outcome,
    createdAt: request.artifactCreatedAt,
    deleteAfter: request.deleteAfter,
  } as const;
}

function addUsage(
  current: SemanticTokenUsageV1 | null,
  additional: SemanticTokenUsageV1 | null,
): SemanticTokenUsageV1 | null {
  if (additional === null) return current;
  return {
    inputTokens: Math.min(
      10_000_000,
      (current?.inputTokens ?? 0) + additional.inputTokens,
    ),
    outputTokens: Math.min(
      10_000_000,
      (current?.outputTokens ?? 0) + additional.outputTokens,
    ),
  };
}

function hashUnknown(value: unknown): string {
  try {
    const serialized = stableJson(value);
    if (
      Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_OUTPUT_HASH_BYTES
    ) {
      return sha256("provider-output-exceeded-hash-bound-v1");
    }
    return sha256(serialized);
  } catch {
    return sha256("provider-output-was-not-canonical-json-v1");
  }
}

function stableJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (candidate: unknown): unknown => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new TypeError("non-finite number");
      return candidate;
    }
    if (candidate instanceof Date) return candidate.toISOString();
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate === "object") {
      if (seen.has(candidate)) throw new TypeError("cyclic JSON");
      seen.add(candidate);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(candidate).sort()) {
        const item = (candidate as Record<string, unknown>)[key];
        if (item !== undefined) output[key] = normalize(item);
      }
      seen.delete(candidate);
      return output;
    }
    throw new TypeError("non-JSON value");
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("SHA-256 did not produce enough UUID bytes");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function validateServerTimingAndAnchors(
  request: {
    artifactCreatedAt: Date;
    deadlineAt: Date;
    deleteAfter: Date;
    generationContext: GenerationContextV1;
  },
  context: z.RefinementCtx,
): void {
  const created = request.artifactCreatedAt.getTime();
  const deadline = request.deadlineAt.getTime();
  const deletion = request.deleteAfter.getTime();
  if (deadline <= created || deadline - created > MAX_GENERATION_DEADLINE_MS) {
    context.addIssue({
      code: "custom",
      path: ["deadlineAt"],
      message: "Generation deadline must be server-bounded to ten minutes",
    });
  }
  if (deletion <= created || deletion - created > MAX_PRIVATE_RETENTION_MS) {
    context.addIssue({
      code: "custom",
      path: ["deleteAfter"],
      message: "Private semantic material must expire within 24 hours",
    });
  }
  if (request.generationContext.allowedAnchorIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["generationContext", "allowedAnchorIds"],
      message: "Semantic generation requires at least one analyzer anchor",
    });
  }
}
