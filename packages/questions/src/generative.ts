import {
  GenerationContextV1Schema,
  type GenerationContextV1,
} from "@slopproof/analysis";
import { z } from "zod";

const UuidSchema = z.string().uuid();
const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ForbiddenProofContentV1Schema = z
  .array(z.string().trim().min(1).max(2_000))
  .min(1)
  .max(60);

export type ForbiddenProofContentV1 = z.infer<
  typeof ForbiddenProofContentV1Schema
>;

export const SemanticAnchorIdV1Schema = z
  .string()
  .max(4)
  .regex(/^a(?:0|[1-9][0-9]{0,2})$/u);

const AnchorIdsSchema = z
  .array(SemanticAnchorIdV1Schema)
  .min(1)
  .max(10)
  .superRefine((anchorIds, context) => {
    if (new Set(anchorIds).size !== anchorIds.length) {
      context.addIssue({
        code: "custom",
        message: "Semantic anchor IDs must be unique",
      });
    }
  });

export const SemanticPatchReferenceV1Schema = z
  .object({
    anchorId: SemanticAnchorIdV1Schema,
    file: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes("\0")),
    oldStart: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
  })
  .strict();

export type SemanticPatchReferenceV1 = z.infer<
  typeof SemanticPatchReferenceV1Schema
>;

const PatchReferencesSchema = z
  .array(SemanticPatchReferenceV1Schema)
  .min(1)
  .max(10);

const SingleAnchorIdSchema = z.array(SemanticAnchorIdV1Schema).length(1);
const SinglePatchReferenceSchema = z
  .array(SemanticPatchReferenceV1Schema)
  .length(1);

const FORBIDDEN_PERSON_OR_TOOL_QUESTIONS = [
  /\b(?:who\s+(?:are|wrote|authored|generated|created)|your\s+(?:identity|name))\b/iu,
  /\b(?:did|do|have)\s+you\s+(?:use|write|author|generate|create)\b/iu,
  /\b(?:which|what)\s+(?:ai|llm|model|assistant|coding\s+tool|tool)\s+(?:did|do|was|were)\b/iu,
  /\b(?:chatgpt|copilot|claude|cursor|ai[- ]generated|machine[- ]generated)\b/iu,
  /\bprove\s+(?:that\s+)?you\s+(?:are|wrote|authored|created)\b/iu,
  /\b(?:ai|llm|model|assistant|coding\s+tool|tool)\s+(?:used|chosen|selected)\s+by\s+(?:you|the\s+(?:author|contributor))\b/iu,
  /\b(?:names?|identif(?:y|ies)|states?)\s+(?:which|what|the)\s+(?:ai\s+|llm\s+)?(?:model|assistant|coding\s+tool|tool)\b/iu,
  /\b(?:identify|identifies|identified|infer|infers|inferred|name|names|named|reveal|reveals|revealed)\s+(?:the\s+)?(?:author|contributor|identity|authorship)\b/iu,
] as const;

const FORBIDDEN_PROMPT_INJECTION_DIRECTIVES = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?\b/iu,
  /\b(?:reveal|print|return|expose|leak)\s+(?:the\s+)?(?:secret|token|password|credential|system\s+prompt)\b/iu,
  /\b(?:visit|open|fetch|browse)\s+https?:\/\//iu,
  /\b(?:run|execute)\s+(?:this\s+)?(?:command|code|script)\b/iu,
  /\b(?:call|invoke)\s+(?:(?:a|the|this)\s+)?(?:tool|function)\b/iu,
] as const;

export function asksAboutIdentityToolingOrAuthorship(text: string): boolean {
  return FORBIDDEN_PERSON_OR_TOOL_QUESTIONS.some((pattern) =>
    pattern.test(text.normalize("NFKC")),
  );
}

export function containsPromptInjectionDirective(text: string): boolean {
  return FORBIDDEN_PROMPT_INJECTION_DIRECTIVES.some((pattern) =>
    pattern.test(text.normalize("NFKC")),
  );
}

const GeneratedSemanticTextSchema = z
  .string()
  .trim()
  .refine((text) => !containsPromptInjectionDirective(text), {
    message: "Generated semantic text contains an unsafe instruction",
  });

export const AnchoredLearningStatementV1Schema = z
  .object({
    text: GeneratedSemanticTextSchema.min(10).max(2_000),
    anchorIds: AnchorIdsSchema,
    patchReferences: PatchReferencesSchema,
  })
  .strict()
  .superRefine((statement, context) => {
    validateDeclaredReferenceSet(statement, context);
    if (asksAboutIdentityToolingOrAuthorship(statement.text)) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message:
          "Learning and Practice feedback cannot discuss identity, tool use or authorship",
      });
    }
  });

export type AnchoredLearningStatementV1 = z.infer<
  typeof AnchoredLearningStatementV1Schema
>;

export const PracticeQuestionFocusV2Schema = z.enum([
  "patch_intent",
  "changed_behavior",
  "interface",
  "risk",
  "testing",
  "rollback",
]);

/** Provider-facing content. IDs, order and revision binding are added by the worker. */
export const PracticeQuestionCandidateV2Schema = z
  .object({
    schemaVersion: z.literal("2"),
    questionVersion: z.literal("practice-question-v2"),
    focus: PracticeQuestionFocusV2Schema,
    prompt: GeneratedSemanticTextSchema.min(20).max(700),
    anchorIds: AnchorIdsSchema,
    patchReferences: PatchReferencesSchema,
    privateToPracticeSession: z.literal(true),
  })
  .strict()
  .superRefine((question, context) => {
    validateDeclaredReferenceSet(question, context);
    if (asksAboutIdentityToolingOrAuthorship(question.prompt)) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message:
          "Practice questions cannot ask about identity, tool use or authorship",
      });
    }
  });

export type PracticeQuestionCandidateV2 = z.infer<
  typeof PracticeQuestionCandidateV2Schema
>;

export const LearningBundleCandidateV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    learningVersion: z.literal("learning-bundle-v1"),
    patchIntent: AnchoredLearningStatementV1Schema,
    changedAreas: z.array(AnchoredLearningStatementV1Schema).min(1).max(12),
    behaviors: z.array(AnchoredLearningStatementV1Schema).min(1).max(12),
    interfaces: z.array(AnchoredLearningStatementV1Schema).max(12),
    risks: z.array(AnchoredLearningStatementV1Schema).min(1).max(12),
    testGaps: z.array(AnchoredLearningStatementV1Schema).min(1).max(8),
    testIdeas: z.array(AnchoredLearningStatementV1Schema).min(1).max(8),
    rollbackSignals: z.array(AnchoredLearningStatementV1Schema).min(1).max(8),
    practiceQuestions: z.array(PracticeQuestionCandidateV2Schema).min(3).max(5),
  })
  .strict()
  .superRefine((bundle, context) => {
    const prompts = bundle.practiceQuestions.map((question) =>
      normalize(question.prompt),
    );
    if (new Set(prompts).size !== prompts.length) {
      context.addIssue({
        code: "custom",
        path: ["practiceQuestions"],
        message: "Practice question prompts must be unique",
      });
    }
  });

export type LearningBundleCandidateV1 = z.infer<
  typeof LearningBundleCandidateV1Schema
>;

const ServerArtifactBindingV1Schema = z
  .object({
    id: UuidSchema,
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    contextHash: Sha256Schema,
    contentHash: Sha256Schema,
    generationOutcome: z.enum(["generated", "repaired", "fallback"]),
    createdAt: z.date(),
    deleteAfter: z.date(),
  })
  .strict();

export const PracticeQuestionV2Schema =
  PracticeQuestionCandidateV2Schema.extend({
    id: UuidSchema,
    order: z.number().int().min(1).max(5),
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    contextHash: Sha256Schema,
  }).strict();

export type PracticeQuestionV2 = z.infer<typeof PracticeQuestionV2Schema>;

export const LearningBundleV1Schema = ServerArtifactBindingV1Schema.extend({
  schemaVersion: z.literal("1"),
  learningVersion: z.literal("learning-bundle-v1"),
  patchIntent: AnchoredLearningStatementV1Schema,
  changedAreas: z.array(AnchoredLearningStatementV1Schema).min(1).max(12),
  behaviors: z.array(AnchoredLearningStatementV1Schema).min(1).max(12),
  interfaces: z.array(AnchoredLearningStatementV1Schema).max(12),
  risks: z.array(AnchoredLearningStatementV1Schema).min(1).max(12),
  testGaps: z.array(AnchoredLearningStatementV1Schema).min(1).max(8),
  testIdeas: z.array(AnchoredLearningStatementV1Schema).min(1).max(8),
  rollbackSignals: z.array(AnchoredLearningStatementV1Schema).min(1).max(8),
  practiceQuestions: z.array(PracticeQuestionV2Schema).min(3).max(5),
})
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.deleteAfter.getTime() <= bundle.createdAt.getTime()) {
      context.addIssue({
        code: "custom",
        path: ["deleteAfter"],
        message: "Learning material expiry must be after creation",
      });
    }
    const ids = bundle.practiceQuestions.map((question) => question.id);
    const orders = bundle.practiceQuestions.map((question) => question.order);
    const expectedOrders = bundle.practiceQuestions.map(
      (_, index) => index + 1,
    );
    if (
      new Set(ids).size !== ids.length ||
      JSON.stringify(orders) !== JSON.stringify(expectedOrders) ||
      bundle.practiceQuestions.some(
        (question) =>
          question.revisionId !== bundle.revisionId ||
          question.headSha !== bundle.headSha ||
          question.contextHash !== bundle.contextHash,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["practiceQuestions"],
        message:
          "Practice questions require unique server IDs, contiguous order and the bundle binding",
      });
    }
  });

export type LearningBundleV1 = z.infer<typeof LearningBundleV1Schema>;

export const PracticeFeedbackCandidateV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    feedbackVersion: z.literal("practice-feedback-v1"),
    understood: AnchoredLearningStatementV1Schema,
    missingPatchDetail: AnchoredLearningStatementV1Schema,
    hint: AnchoredLearningStatementV1Schema,
    scoreIncluded: z.literal(false),
    modelAnswerIncluded: z.literal(false),
  })
  .strict();

export type PracticeFeedbackCandidateV1 = z.infer<
  typeof PracticeFeedbackCandidateV1Schema
>;

export const PracticeFeedbackV1Schema = ServerArtifactBindingV1Schema.extend({
  schemaVersion: z.literal("1"),
  feedbackVersion: z.literal("practice-feedback-v1"),
  practiceQuestionId: UuidSchema,
  understood: AnchoredLearningStatementV1Schema,
  missingPatchDetail: AnchoredLearningStatementV1Schema,
  hint: AnchoredLearningStatementV1Schema,
  scoreIncluded: z.literal(false),
  modelAnswerIncluded: z.literal(false),
  privateToPracticeSession: z.literal(true),
}).strict();

export type PracticeFeedbackV1 = z.infer<typeof PracticeFeedbackV1Schema>;

export const ProofQuestionIntentV2Schema = z.enum([
  "explain",
  "predict",
  "tradeoff",
  "failure_path",
  "test_and_rollback",
]);

const AnchoredRubricStatementV2Schema = z
  .object({
    description: GeneratedSemanticTextSchema.min(8).max(300),
    anchorIds: SingleAnchorIdSchema,
    patchReferences: SinglePatchReferenceSchema,
  })
  .strict()
  .superRefine(validateDeclaredReferenceSet);

export const ProofRubricV2Schema = z
  .object({
    schemaVersion: z.literal("2"),
    rubricVersion: z.literal("proof-rubric-v2"),
    requiredPoints: z.array(AnchoredRubricStatementV2Schema).min(2).max(5),
    observableSignals: z.array(AnchoredRubricStatementV2Schema).min(1).max(5),
    rejectsGenericAnswer: z.literal(true),
    antiGenericReason: AnchoredRubricStatementV2Schema,
  })
  .strict()
  .superRefine((rubric, context) => {
    const points = rubric.requiredPoints.map((point) =>
      normalize(point.description),
    );
    if (new Set(points).size !== points.length) {
      context.addIssue({
        code: "custom",
        path: ["requiredPoints"],
        message: "Proof rubric points must be unique",
      });
    }
  });

export type ProofRubricV2 = z.infer<typeof ProofRubricV2Schema>;

/** Provider-facing candidate. The worker owns IDs, order and revision binding. */
export const ProofQuestionCandidateV2Schema = z
  .object({
    schemaVersion: z.literal("2"),
    questionVersion: z.literal("proof-question-candidate-v2"),
    intent: ProofQuestionIntentV2Schema,
    focus: GeneratedSemanticTextSchema.min(3).max(120),
    prompt: GeneratedSemanticTextSchema.min(20).max(1_000),
    anchorIds: SingleAnchorIdSchema,
    patchReferences: SinglePatchReferenceSchema,
    rubric: ProofRubricV2Schema,
  })
  .strict()
  .superRefine((question, context) => {
    validateDeclaredReferenceSet(question, context);
    const personOrToolContent = [
      ["focus", question.focus] as const,
      ["prompt", question.prompt] as const,
      ...question.rubric.requiredPoints.map(
        (point) => ["rubric", point.description] as const,
      ),
      ...question.rubric.observableSignals.map(
        (signal) => ["rubric", signal.description] as const,
      ),
      ["rubric", question.rubric.antiGenericReason.description] as const,
    ];
    const forbiddenContent = personOrToolContent.find(([, text]) =>
      asksAboutIdentityToolingOrAuthorship(text),
    );
    if (forbiddenContent !== undefined) {
      context.addIssue({
        code: "custom",
        path: [forbiddenContent[0]],
        message:
          "Proof content cannot ask about identity, tool use or authorship",
      });
    }
    const questionAnchor = question.anchorIds[0];
    const questionReference = question.patchReferences[0];
    const rubricItems = [
      ...question.rubric.requiredPoints,
      ...question.rubric.observableSignals,
      question.rubric.antiGenericReason,
    ];
    if (
      questionAnchor === undefined ||
      questionReference === undefined ||
      rubricItems.some(
        (item) =>
          item.anchorIds[0] !== questionAnchor ||
          !samePatchReference(item.patchReferences[0], questionReference),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["rubric"],
        message:
          "Every rubric item must use the question's single structured patch reference",
      });
    }
  });

export type ProofQuestionCandidateV2 = z.infer<
  typeof ProofQuestionCandidateV2Schema
>;

export const FrozenProofQuestionV2Schema =
  ProofQuestionCandidateV2Schema.extend({
    id: UuidSchema,
    order: z.number().int().min(1).max(5),
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    contextHash: Sha256Schema,
  }).strict();

export type FrozenProofQuestionV2 = z.infer<typeof FrozenProofQuestionV2Schema>;

export const ProofQuestionPlanV2Schema = ServerArtifactBindingV1Schema.extend({
  schemaVersion: z.literal("2"),
  planVersion: z.literal("proof-question-plan-v2"),
  plannerVersion: z.literal("proof-planner-v2"),
  questionBudget: z.number().int().min(1).max(5),
  questions: z.array(FrozenProofQuestionV2Schema).min(1).max(5),
  planHash: Sha256Schema,
})
  .strict()
  .superRefine((plan, context) => {
    if (
      plan.questionBudget !== plan.questions.length ||
      new Set(plan.questions.map((question) => question.id)).size !==
        plan.questions.length ||
      plan.questions.some(
        (question, index) =>
          question.order !== index + 1 ||
          question.revisionId !== plan.revisionId ||
          question.headSha !== plan.headSha ||
          question.contextHash !== plan.contextHash,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message:
          "Frozen proof questions must exactly match their server-owned plan binding",
      });
    }
  });

export type ProofQuestionPlanV2 = z.infer<typeof ProofQuestionPlanV2Schema>;

export type SemanticContentValidationCode =
  | "schema_invalid"
  | "anchor_invalid"
  | "count_invalid"
  | "content_policy_invalid";

export class SemanticContentValidationError extends Error {
  readonly code = "SEMANTIC_CONTENT_INVALID" as const;

  constructor(readonly validationCode: SemanticContentValidationCode) {
    super("Generated semantic content failed its bounded contract.");
    this.name = "SemanticContentValidationError";
  }
}

export function validateLearningBundleCandidateV1(
  rawCandidate: unknown,
  rawContext: unknown,
  expectedPracticeQuestionCount?: number,
  forbiddenProofContent: readonly string[] = [],
): LearningBundleCandidateV1 {
  const candidate = LearningBundleCandidateV1Schema.safeParse(rawCandidate);
  const generationContext = GenerationContextV1Schema.safeParse(rawContext);
  if (!candidate.success || !generationContext.success) {
    throw new SemanticContentValidationError("schema_invalid");
  }
  if (
    expectedPracticeQuestionCount !== undefined &&
    candidate.data.practiceQuestions.length !== expectedPracticeQuestionCount
  ) {
    throw new SemanticContentValidationError("count_invalid");
  }
  const statements = [
    candidate.data.patchIntent,
    ...candidate.data.changedAreas,
    ...candidate.data.behaviors,
    ...candidate.data.interfaces,
    ...candidate.data.risks,
    ...candidate.data.testGaps,
    ...candidate.data.testIdeas,
    ...candidate.data.rollbackSignals,
    ...candidate.data.practiceQuestions,
  ];
  assertKnownConcreteAnchors(statements, generationContext.data);
  if (
    forbiddenProofContent.length > 0 &&
    !learningBundleExcludesProofContentV1({
      learning: candidate.data,
      forbiddenProofContent,
    })
  ) {
    throw new SemanticContentValidationError("content_policy_invalid");
  }
  return candidate.data;
}

export function validatePracticeFeedbackCandidateV1(
  rawCandidate: unknown,
  rawContext: unknown,
  rawQuestion: unknown,
  forbiddenProofContent: readonly string[] = [],
): PracticeFeedbackCandidateV1 {
  const candidate = PracticeFeedbackCandidateV1Schema.safeParse(rawCandidate);
  const generationContext = GenerationContextV1Schema.safeParse(rawContext);
  const question = PracticeQuestionV2Schema.safeParse(rawQuestion);
  if (!candidate.success || !generationContext.success || !question.success) {
    throw new SemanticContentValidationError("schema_invalid");
  }
  const statements = [
    candidate.data.understood,
    candidate.data.missingPatchDetail,
    candidate.data.hint,
  ];
  assertKnownConcreteAnchors(statements, generationContext.data);
  const questionAnchors = new Set(question.data.anchorIds);
  if (
    statements.some((statement) =>
      statement.anchorIds.some((anchorId) => !questionAnchors.has(anchorId)),
    )
  ) {
    throw new SemanticContentValidationError("anchor_invalid");
  }
  if (
    forbiddenProofContent.length > 0 &&
    !practiceFeedbackExcludesProofContentV1({
      practiceFeedback: candidate.data,
      forbiddenProofContent,
    })
  ) {
    throw new SemanticContentValidationError("content_policy_invalid");
  }
  return candidate.data;
}

export function validatePracticeQuestionV2AgainstContext(
  rawQuestion: unknown,
  rawContext: unknown,
): PracticeQuestionV2 {
  const question = PracticeQuestionV2Schema.safeParse(rawQuestion);
  const generationContext = GenerationContextV1Schema.safeParse(rawContext);
  if (!question.success || !generationContext.success) {
    throw new SemanticContentValidationError("schema_invalid");
  }
  assertKnownConcreteAnchors([question.data], generationContext.data);
  if (
    question.data.revisionId !== generationContext.data.revisionId ||
    question.data.headSha !== generationContext.data.headSha ||
    question.data.contextHash !== generationContext.data.contextHash
  ) {
    throw new SemanticContentValidationError("anchor_invalid");
  }
  return question.data;
}

export function validateProofQuestionCandidatesV2(
  rawCandidates: unknown,
  rawContext: unknown,
  expectedCount: number,
): ProofQuestionCandidateV2[] {
  const candidates = z
    .array(ProofQuestionCandidateV2Schema)
    .min(1)
    .max(5)
    .safeParse(rawCandidates);
  const generationContext = GenerationContextV1Schema.safeParse(rawContext);
  if (!candidates.success || !generationContext.success) {
    throw new SemanticContentValidationError("schema_invalid");
  }
  if (candidates.data.length !== expectedCount) {
    throw new SemanticContentValidationError("count_invalid");
  }
  if (
    new Set(candidates.data.map((candidate) => normalize(candidate.prompt)))
      .size !== candidates.data.length
  ) {
    throw new SemanticContentValidationError("content_policy_invalid");
  }
  for (const candidate of candidates.data) {
    assertKnownConcreteAnchors(
      [
        candidate,
        ...candidate.rubric.requiredPoints,
        ...candidate.rubric.observableSignals,
        candidate.rubric.antiGenericReason,
      ],
      generationContext.data,
    );
  }
  return candidates.data;
}

export function practiceArtifactsExcludeProofContentV1(input: {
  practiceQuestions: readonly PracticeQuestionCandidateV2[];
  practiceFeedback?: readonly PracticeFeedbackCandidateV1[];
  proofQuestions: readonly ProofQuestionCandidateV2[];
}): boolean {
  const proofContent = proofQuestionsContentV1(input.proofQuestions);
  const practiceContent = [
    ...input.practiceQuestions.map((question) => question.prompt),
    ...(input.practiceFeedback ?? []).flatMap((feedback) => [
      feedback.understood.text,
      feedback.missingPatchDetail.text,
      feedback.hint.text,
    ]),
  ];
  return practiceContentExcludesProofContentV1(practiceContent, proofContent);
}

export function proofQuestionsContentV1(
  proofQuestions: readonly ProofQuestionCandidateV2[],
): string[] {
  return proofQuestions.flatMap((question) => [
    question.prompt,
    ...question.rubric.requiredPoints.map((point) => point.description),
    ...question.rubric.observableSignals.map((signal) => signal.description),
    question.rubric.antiGenericReason.description,
  ]);
}

export function learningBundleExcludesProofContentV1(input: {
  learning: LearningBundleCandidateV1;
  forbiddenProofContent: readonly string[];
}): boolean {
  const learning = input.learning;
  return practiceContentExcludesProofContentV1(
    [
      learning.patchIntent.text,
      ...learning.changedAreas.map((statement) => statement.text),
      ...learning.behaviors.map((statement) => statement.text),
      ...learning.interfaces.map((statement) => statement.text),
      ...learning.risks.map((statement) => statement.text),
      ...learning.testGaps.map((statement) => statement.text),
      ...learning.testIdeas.map((statement) => statement.text),
      ...learning.rollbackSignals.map((statement) => statement.text),
      ...learning.practiceQuestions.map((question) => question.prompt),
    ],
    input.forbiddenProofContent,
  );
}

export function practiceFeedbackExcludesProofContentV1(input: {
  practiceFeedback: PracticeFeedbackCandidateV1;
  forbiddenProofContent: readonly string[];
}): boolean {
  return practiceContentExcludesProofContentV1(
    [
      input.practiceFeedback.understood.text,
      input.practiceFeedback.missingPatchDetail.text,
      input.practiceFeedback.hint.text,
    ],
    input.forbiddenProofContent,
  );
}

function practiceContentExcludesProofContentV1(
  practiceContent: readonly string[],
  forbiddenProofContent: readonly string[],
): boolean {
  if (forbiddenProofContent.length === 0) return true;
  const parsed = ForbiddenProofContentV1Schema.safeParse(forbiddenProofContent);
  if (!parsed.success) return false;
  const normalizedProof = parsed.data.map(normalize).filter(Boolean);
  return practiceContent.every((practiceValue) => {
    const normalizedPractice = normalize(practiceValue);
    return normalizedProof.every(
      (proofValue) =>
        normalizedPractice !== proofValue &&
        (proofValue.length < 20 || !normalizedPractice.includes(proofValue)),
    );
  });
}

function makeLearningFallbackCollisionFree(
  candidate: LearningBundleCandidateV1,
  forbiddenProofContent: readonly string[],
): LearningBundleCandidateV1 {
  if (forbiddenProofContent.length === 0) return candidate;
  let statementIndex = 0;
  const statement = (value: AnchoredLearningStatementV1) => ({
    ...value,
    text: collisionFreeFallbackText(
      value.text,
      forbiddenProofContent,
      (counter) => {
        const anchorId = value.anchorIds[0] ?? "unknown";
        const reference = value.patchReferences[0];
        const tag = `P${String(statementIndex * 100 + counter).padStart(4, "0")}`;
        return `${tag}[${anchorId}] compare-${tag}[before@${String(reference?.oldStart ?? 0)}:after@${String(reference?.newStart ?? 0)}] explain-${tag}[observable-effect] boundary-${tag}[one-case]`;
      },
    ),
  });
  const statements = (values: readonly AnchoredLearningStatementV1[]) =>
    values.map((value) => {
      statementIndex += 1;
      return statement(value);
    });
  const patchIntent = statement(candidate.patchIntent);
  statementIndex += 1;
  return LearningBundleCandidateV1Schema.parse({
    ...candidate,
    patchIntent,
    changedAreas: statements(candidate.changedAreas),
    behaviors: statements(candidate.behaviors),
    interfaces: statements(candidate.interfaces),
    risks: statements(candidate.risks),
    testGaps: statements(candidate.testGaps),
    testIdeas: statements(candidate.testIdeas),
    rollbackSignals: statements(candidate.rollbackSignals),
    practiceQuestions: candidate.practiceQuestions.map((question, index) => ({
      ...question,
      prompt: collisionFreeFallbackText(
        question.prompt,
        forbiddenProofContent,
        (counter) => {
          const anchorId = question.anchorIds[0] ?? "unknown";
          const reference = question.patchReferences[0];
          const tag = `Q${String(index * 100 + counter).padStart(4, "0")}`;
          return `${tag}[${anchorId}] compare-${tag}[before@${String(reference?.oldStart ?? 0)}:after@${String(reference?.newStart ?? 0)}] explain-${tag}[changed-behavior] test-${tag}[one-boundary]`;
        },
      ),
    })),
  });
}

function makeFeedbackFallbackCollisionFree(
  candidate: PracticeFeedbackCandidateV1,
  forbiddenProofContent: readonly string[],
): PracticeFeedbackCandidateV1 {
  if (forbiddenProofContent.length === 0) return candidate;
  const safe = (
    value: AnchoredLearningStatementV1,
    format: (counter: number) => string,
  ) => ({
    ...value,
    text: collisionFreeFallbackText(value.text, forbiddenProofContent, format),
  });
  return PracticeFeedbackCandidateV1Schema.parse({
    ...candidate,
    understood: safe(candidate.understood, (counter) => {
      const anchorId = candidate.understood.anchorIds[0] ?? "unknown";
      const tag = `U${String(counter).padStart(4, "0")}`;
      return `${tag}[${anchorId}] recognized-${tag}[changed-behavior] response-${tag}[engaged]`;
    }),
    missingPatchDetail: safe(candidate.missingPatchDetail, (counter) => {
      const anchorId = candidate.missingPatchDetail.anchorIds[0] ?? "unknown";
      const reference = candidate.missingPatchDetail.patchReferences[0];
      const tag = `M${String(counter).padStart(4, "0")}`;
      return `${tag}[${anchorId}] missing-${tag}[before@${String(reference?.oldStart ?? 0)}:after@${String(reference?.newStart ?? 0)}] boundary-${tag}[one-effect]`;
    }),
    hint: safe(candidate.hint, (counter) => {
      const anchorId = candidate.hint.anchorIds[0] ?? "unknown";
      const reference = candidate.hint.patchReferences[0];
      const tag = `H${String(counter).padStart(4, "0")}`;
      return `${tag}[${anchorId}] compare-${tag}[before@${String(reference?.oldStart ?? 0)}:after@${String(reference?.newStart ?? 0)}] name-${tag}[observable-consequence]`;
    }),
  });
}

function collisionFreeFallbackText(
  preferred: string,
  forbiddenProofContent: readonly string[],
  alternative: (counter: number) => string,
): string {
  if (
    practiceContentExcludesProofContentV1([preferred], forbiddenProofContent)
  ) {
    return preferred;
  }
  for (let counter = 0; counter < 100; counter += 1) {
    const candidate = alternative(counter);
    if (
      practiceContentExcludesProofContentV1([candidate], forbiddenProofContent)
    ) {
      return candidate;
    }
  }
  throw new SemanticContentValidationError("content_policy_invalid");
}

export function deterministicLearningFallbackV1(
  rawContext: unknown,
  practiceQuestionCount: number,
  forbiddenProofContent: readonly string[] = [],
): LearningBundleCandidateV1 {
  const context = GenerationContextV1Schema.safeParse(rawContext);
  if (
    !context.success ||
    practiceQuestionCount < 3 ||
    practiceQuestionCount > 5 ||
    context.data.allowedAnchorIds.length === 0
  ) {
    throw new SemanticContentValidationError("schema_invalid");
  }
  const anchors = context.data.allowedAnchorIds;
  const firstAnchor = anchors[0];
  if (firstAnchor === undefined) {
    throw new SemanticContentValidationError("anchor_invalid");
  }
  const statement = (text: string, anchorId = firstAnchor) => ({
    text,
    anchorIds: [anchorId],
    patchReferences: [patchReference(context.data, anchorId)],
  });
  const prompts = [
    "Explain the before-and-after behavior at the referenced changed hunk.",
    "Describe one boundary or failure case affected by the referenced changed hunk.",
    "Propose a focused test that observes the behavior at the referenced changed hunk.",
    "Name a rollback signal tied to the behavior at the referenced changed hunk.",
    "Trace one caller or consumer affected by the referenced changed hunk.",
  ];
  const focuses = [
    "changed_behavior",
    "risk",
    "testing",
    "rollback",
    "interface",
  ] as const;
  const candidate: LearningBundleCandidateV1 = {
    schemaVersion: "1" as const,
    learningVersion: "learning-bundle-v1" as const,
    patchIntent: statement(
      "Understand the observable behavior changed by the bounded patch before proving it.",
    ),
    changedAreas: anchors
      .slice(0, 12)
      .map((anchorId) =>
        statement(
          "Map this changed hunk to the component responsibility it modifies.",
          anchorId,
        ),
      ),
    behaviors: [
      statement(
        "Compare removed and added lines to identify the concrete behavior change.",
      ),
    ],
    interfaces: [
      statement(
        "Trace the nearest caller or consumer affected by this changed hunk.",
      ),
    ],
    risks: [
      statement(
        "Check the boundary and failure behavior introduced by this changed hunk.",
      ),
    ],
    testGaps: [
      statement(
        context.data.deterministicTestFiles.length === 0
          ? "No changed test file is present for the behavior at this changed hunk."
          : "Confirm the changed tests cover a boundary and failure case for this changed hunk.",
      ),
    ],
    testIdeas: [
      statement(
        "Exercise the normal path and one failing boundary at this changed hunk.",
      ),
    ],
    rollbackSignals: [
      statement(
        "Use a regression in the observable behavior at this changed hunk as a rollback signal.",
      ),
    ],
    practiceQuestions: Array.from(
      { length: practiceQuestionCount },
      (_, index) => {
        const anchorId = anchors[index % anchors.length];
        const prompt = prompts[index];
        const focus = focuses[index];
        if (
          anchorId === undefined ||
          prompt === undefined ||
          focus === undefined
        ) {
          throw new SemanticContentValidationError("count_invalid");
        }
        return {
          schemaVersion: "2" as const,
          questionVersion: "practice-question-v2" as const,
          focus,
          prompt,
          anchorIds: [anchorId],
          patchReferences: [patchReference(context.data, anchorId)],
          privateToPracticeSession: true as const,
        };
      },
    ),
  };
  const collisionFree = makeLearningFallbackCollisionFree(
    candidate,
    forbiddenProofContent,
  );
  return validateLearningBundleCandidateV1(
    collisionFree,
    context.data,
    practiceQuestionCount,
    forbiddenProofContent,
  );
}

export function deterministicPracticeFeedbackFallbackV1(
  rawContext: unknown,
  rawQuestion: unknown,
  forbiddenProofContent: readonly string[] = [],
): PracticeFeedbackCandidateV1 {
  const context = GenerationContextV1Schema.safeParse(rawContext);
  const question = PracticeQuestionV2Schema.safeParse(rawQuestion);
  if (!context.success || !question.success) {
    throw new SemanticContentValidationError("schema_invalid");
  }
  const anchorId = question.data.anchorIds[0];
  if (anchorId === undefined) {
    throw new SemanticContentValidationError("anchor_invalid");
  }
  const candidate: PracticeFeedbackCandidateV1 = {
    schemaVersion: "1",
    feedbackVersion: "practice-feedback-v1",
    understood: {
      text: `Your response engages with the behavior at anchor ${anchorId}.`,
      anchorIds: [anchorId],
      patchReferences: [patchReference(context.data, anchorId)],
    },
    missingPatchDetail: {
      text: `The explanation still needs an explicit before-and-after comparison at anchor ${anchorId}.`,
      anchorIds: [anchorId],
      patchReferences: [patchReference(context.data, anchorId)],
    },
    hint: {
      text: `At anchor ${anchorId}, compare the removed line with the added line and describe one observable consequence.`,
      anchorIds: [anchorId],
      patchReferences: [patchReference(context.data, anchorId)],
    },
    scoreIncluded: false,
    modelAnswerIncluded: false,
  };
  const collisionFree = makeFeedbackFallbackCollisionFree(
    candidate,
    forbiddenProofContent,
  );
  return validatePracticeFeedbackCandidateV1(
    collisionFree,
    context.data,
    question.data,
    forbiddenProofContent,
  );
}

export function deterministicProofFallbackV2(
  rawContext: unknown,
  questionCount: number,
): ProofQuestionCandidateV2[] {
  const context = GenerationContextV1Schema.safeParse(rawContext);
  if (
    !context.success ||
    questionCount < 1 ||
    questionCount > 5 ||
    context.data.allowedAnchorIds.length === 0
  ) {
    throw new SemanticContentValidationError("schema_invalid");
  }
  const intents = [
    "explain",
    "predict",
    "failure_path",
    "test_and_rollback",
    "tradeoff",
  ] as const;
  const prompts = [
    "Explain the before-and-after behavior at this changed hunk and why the new behavior is intended.",
    "Predict the normal outcome and one boundary outcome caused by this changed hunk.",
    "Walk through a realistic failure path at this changed hunk, including recovery behavior.",
    "Give a focused test and rollback plan for the behavior at this changed hunk.",
    "Describe the main implementation tradeoff at this changed hunk and one plausible alternative.",
  ];
  const candidates = Array.from({ length: questionCount }, (_, index) => {
    const anchorId =
      context.data.allowedAnchorIds[
        index % context.data.allowedAnchorIds.length
      ];
    const intent = intents[index];
    const prompt = prompts[index];
    if (
      anchorId === undefined ||
      intent === undefined ||
      prompt === undefined
    ) {
      throw new SemanticContentValidationError("count_invalid");
    }
    const anchorIds = [anchorId];
    return {
      schemaVersion: "2" as const,
      questionVersion: "proof-question-candidate-v2" as const,
      intent,
      focus: `behavior at ${anchorId}`,
      prompt,
      anchorIds,
      patchReferences: [patchReference(context.data, anchorId)],
      rubric: {
        schemaVersion: "2" as const,
        rubricVersion: "proof-rubric-v2" as const,
        requiredPoints: [
          {
            description: `Identifies the concrete behavior represented by anchor ${anchorId}.`,
            anchorIds,
            patchReferences: [patchReference(context.data, anchorId)],
          },
          {
            description:
              "Explains an observable consequence and a relevant boundary or failure case.",
            anchorIds,
            patchReferences: [patchReference(context.data, anchorId)],
          },
        ],
        observableSignals: [
          {
            description:
              "The explanation distinguishes removed behavior from added behavior.",
            anchorIds,
            patchReferences: [patchReference(context.data, anchorId)],
          },
        ],
        rejectsGenericAnswer: true as const,
        antiGenericReason: {
          description: `A generic answer would not account for the concrete change at anchor ${anchorId}.`,
          anchorIds,
          patchReferences: [patchReference(context.data, anchorId)],
        },
      },
    };
  });
  return validateProofQuestionCandidatesV2(
    candidates,
    context.data,
    questionCount,
  );
}

function assertKnownConcreteAnchors(
  statements: readonly {
    anchorIds: readonly string[];
    patchReferences: readonly SemanticPatchReferenceV1[];
  }[],
  context: GenerationContextV1,
): void {
  const allowed = new Set(context.allowedAnchorIds);
  const descriptors = new Map(
    context.anchors.map((anchor) => [anchor.id, anchor] as const),
  );
  for (const statement of statements) {
    if (
      statement.anchorIds.length === 0 ||
      statement.anchorIds.some((anchorId) => !allowed.has(anchorId))
    ) {
      throw new SemanticContentValidationError("anchor_invalid");
    }
    if (statement.patchReferences.length !== statement.anchorIds.length) {
      throw new SemanticContentValidationError("anchor_invalid");
    }
    for (const reference of statement.patchReferences) {
      const descriptor = descriptors.get(reference.anchorId);
      if (
        descriptor === undefined ||
        descriptor.filename.content !== reference.file ||
        descriptor.oldStart !== reference.oldStart ||
        descriptor.newStart !== reference.newStart
      ) {
        throw new SemanticContentValidationError("anchor_invalid");
      }
    }
  }
}

function validateDeclaredReferenceSet(
  value: {
    anchorIds: readonly string[];
    patchReferences: readonly SemanticPatchReferenceV1[];
  },
  context: z.RefinementCtx,
): void {
  const declared = [...value.anchorIds].sort();
  const referenced = value.patchReferences
    .map((reference) => reference.anchorId)
    .sort();
  if (
    new Set(referenced).size !== referenced.length ||
    JSON.stringify(declared) !== JSON.stringify(referenced)
  ) {
    context.addIssue({
      code: "custom",
      path: ["patchReferences"],
      message: "Structured patch references must exactly match anchor IDs",
    });
  }
}

function samePatchReference(
  left: SemanticPatchReferenceV1 | undefined,
  right: SemanticPatchReferenceV1,
): boolean {
  return (
    left !== undefined &&
    left.anchorId === right.anchorId &&
    left.file === right.file &&
    left.oldStart === right.oldStart &&
    left.newStart === right.newStart
  );
}

function patchReference(
  context: GenerationContextV1,
  anchorId: string,
): SemanticPatchReferenceV1 {
  const anchor = context.anchors.find((candidate) => candidate.id === anchorId);
  if (anchor === undefined) {
    throw new SemanticContentValidationError("anchor_invalid");
  }
  return SemanticPatchReferenceV1Schema.parse({
    anchorId: anchor.id,
    file: anchor.filename.content,
    oldStart: anchor.oldStart,
    newStart: anchor.newStart,
  });
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}
