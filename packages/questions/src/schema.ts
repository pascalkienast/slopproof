import {
  AnalysisSnapshotSchema,
  DiffAnchorSchema,
  GitShaSchema,
  RiskLevelSchema,
  RiskVectorSchema,
} from "@slopproof/analysis";
import { RepositoryPolicyV1Schema } from "@slopproof/policy";
import { z } from "zod";

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const PlannerVersionsSchema = z
  .object({
    planner: z.literal("proof-planner-v1"),
    questionTemplates: z.literal("proof-questions-v1"),
  })
  .strict();

export const PlanProofInputSchema = z
  .object({
    analysis: AnalysisSnapshotSchema,
    policy: RepositoryPolicyV1Schema,
    serverSeed: z.string().min(32).max(512),
    versions: PlannerVersionsSchema,
  })
  .strict();

export type PlanProofInput = z.infer<typeof PlanProofInputSchema>;

export const PlanProofBudgetInputSchema = PlanProofInputSchema.pick({
  analysis: true,
  policy: true,
}).strict();

export type PlanProofBudgetInput = z.infer<typeof PlanProofBudgetInputSchema>;

export const QuestionIntentSchema = z.enum([
  "explain",
  "predict",
  "tradeoff",
  "failure_path",
  "test_and_rollback",
]);

export type QuestionIntent = z.infer<typeof QuestionIntentSchema>;

export const ProofQuestionSchema = z
  .object({
    id: UuidSchema,
    order: z.number().int().min(1).max(5),
    intent: QuestionIntentSchema,
    focus: z.string().min(1).max(100),
    prompt: z.string().min(20).max(600),
    anchor: DiffAnchorSchema,
    rubric: z
      .object({
        requiredPoints: z.array(z.string().min(5).max(300)).min(2).max(5),
        rejectsGenericAnswer: z.literal(true),
      })
      .strict(),
    maximumAnswerSeconds: z.number().int().min(30).max(180),
  })
  .strict();

export type ProofQuestion = z.infer<typeof ProofQuestionSchema>;

export const ProofPlanSchema = z
  .object({
    id: UuidSchema,
    schemaVersion: z.literal("1"),
    plannerVersion: z.literal("proof-planner-v1"),
    questionTemplateVersion: z.literal("proof-questions-v1"),
    analysisSchemaVersion: z.literal("1"),
    headSha: GitShaSchema,
    riskLevel: RiskLevelSchema,
    riskVector: RiskVectorSchema,
    status: z.enum(["ready", "split_recommended"]),
    questionBudget: z.number().int().min(0).max(5),
    rationale: z.array(z.string().min(1).max(300)).min(1),
    splitRecommendation: z.string().min(1).max(500).optional(),
    seedCommitment: Sha256Schema,
    questions: z.array(ProofQuestionSchema).max(5),
    createdAt: z.date(),
    planHash: Sha256Schema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.questionBudget !== plan.questions.length) {
      context.addIssue({
        code: "custom",
        path: ["questionBudget"],
        message: "questionBudget must equal the immutable question count",
      });
    }
    if (
      new Set(plan.questions.map((question) => question.id)).size !==
      plan.questions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Proof question IDs must be unique",
      });
    }
    if (
      new Set(plan.questions.map((question) => question.prompt)).size !==
      plan.questions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Proof question prompts must be unique",
      });
    }
    if (plan.status === "ready" && plan.questions.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "A ready proof plan requires at least one question",
      });
    }
    if (
      plan.status === "split_recommended" &&
      plan.splitRecommendation === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["splitRecommendation"],
        message: "A split recommendation requires an explanation",
      });
    }
  });

export type ProofPlan = z.infer<typeof ProofPlanSchema>;

export const PracticeInputSchema = z
  .object({
    analysis: AnalysisSnapshotSchema,
    practiceSeed: z.string().min(32).max(512),
    maximumItems: z.number().int().min(1).max(5),
  })
  .strict();

export type PracticeInput = z.infer<typeof PracticeInputSchema>;

export const PracticeQuestionSchema = z
  .object({
    id: UuidSchema,
    order: z.number().int().min(1).max(5),
    focus: z.enum(["patch_map", "behavior", "risk", "testing", "rollback"]),
    prompt: z.string().min(20).max(500),
    privateToPracticeSession: z.literal(true),
  })
  .strict();

export const PracticeSetSchema = z
  .object({
    id: UuidSchema,
    schemaVersion: z.literal("1"),
    practiceVersion: z.literal("practice-questions-v1"),
    headSha: GitShaSchema,
    seedCommitment: Sha256Schema,
    questions: z.array(PracticeQuestionSchema).min(1).max(5),
    createdAt: z.date(),
  })
  .strict();

export type PracticeSet = z.infer<typeof PracticeSetSchema>;

export const SupportedPlannerInputSchema = PlanProofInputSchema;
