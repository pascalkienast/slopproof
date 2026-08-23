import { createHash } from "node:crypto";
import type { AnalysisSnapshot, DiffAnchor } from "@slopproof/analysis";
import {
  PlanProofInputSchema,
  PlanProofBudgetInputSchema,
  PracticeInputSchema,
  PracticeSetSchema,
  ProofPlanSchema,
  type PlanProofBudgetInput,
  type PracticeSet,
  type ProofPlan,
  type ProofQuestion,
  type QuestionIntent,
} from "./schema";

export interface PlannerClock {
  now(): Date;
}

export type PlannerDependencies = {
  clock: PlannerClock;
};

type Candidate = {
  anchor: DiffAnchor;
  focus: string;
  intent: QuestionIntent;
};

const INTENTS: readonly QuestionIntent[] = [
  "explain",
  "predict",
  "failure_path",
  "test_and_rollback",
  "tradeoff",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("SHA-256 did not produce enough bytes");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stableOrder<T>(
  items: readonly T[],
  seed: string,
  key: (item: T) => string,
): T[] {
  return [...items].sort((left, right) =>
    sha256(`${seed}:${key(left)}`).localeCompare(
      sha256(`${seed}:${key(right)}`),
    ),
  );
}

export type ProofBudgetPlan =
  | {
      status: "ready";
      questionBudget: number;
      rationale: string[];
    }
  | {
      status: "split_recommended";
      questionBudget: 0;
      rationale: string[];
      splitRecommendation: string;
    };

function requestedBudget(input: PlanProofBudgetInput): number {
  const { analysis, policy } = input;
  if (analysis.riskLevel === "mega" || analysis.anchors.length === 0) {
    return 0;
  }

  let budget: number;
  switch (analysis.riskLevel) {
    case "small":
      budget = 1;
      break;
    case "medium":
      budget = analysis.riskVector.total >= 8 ? 3 : 2;
      break;
    case "high_risk":
      budget = analysis.riskVector.total >= 15 ? 5 : 4;
      break;
  }

  return Math.min(
    policy.proof.maximumQuestions,
    Math.max(policy.proof.minimumQuestions, budget),
  );
}

function candidatePool(analysis: AnalysisSnapshot): Candidate[] {
  const anchorById = new Map(
    analysis.anchors.map((anchor) => [anchor.id, anchor]),
  );
  const focusByAnchor = new Map<string, string[]>();

  for (const change of analysis.behavioralChanges) {
    const current = focusByAnchor.get(change.anchorId) ?? [];
    current.push(change.kind);
    focusByAnchor.set(change.anchorId, current);
  }
  for (const risk of analysis.risks) {
    const current = focusByAnchor.get(risk.anchorId) ?? [];
    current.push(risk.kind);
    focusByAnchor.set(risk.anchorId, current);
  }

  const candidates: Candidate[] = [];
  for (const [anchorId, rawFocuses] of focusByAnchor) {
    const anchor = anchorById.get(anchorId);
    if (anchor === undefined) {
      continue;
    }
    const focuses = [...new Set(rawFocuses)].sort();
    for (const [index, intent] of INTENTS.entries()) {
      const focus = focuses[index % Math.max(1, focuses.length)] ?? "behavior";
      candidates.push({ anchor, focus, intent });
    }
  }

  if (candidates.length === 0) {
    for (const anchor of analysis.anchors) {
      for (const intent of INTENTS) {
        candidates.push({ anchor, focus: "behavior", intent });
      }
    }
  }
  return candidates;
}

function promptFor(candidate: Candidate): string {
  const location = `the supplied ${candidate.focus} anchor ${candidate.anchor.id} in ${boundedDisplayPath(candidate.anchor.file)} near new line ${String(candidate.anchor.newStart)}`;
  switch (candidate.intent) {
    case "explain":
      return `Explain the observable before-and-after behavior at ${location}, and why the new behavior is intended.`;
    case "predict":
      return `Predict what a caller or user observes at ${location} in both the normal case and one boundary case.`;
    case "tradeoff":
      return `Describe the main implementation tradeoff at ${location} and one reasonable alternative you rejected.`;
    case "failure_path":
      return `Walk through a realistic failure path at ${location}, including the resulting state and recovery behavior.`;
    case "test_and_rollback":
      return `Give a focused verification and rollback plan for ${location}, naming the signal that would trigger rollback.`;
  }
}

function rubricFor(candidate: Candidate): ProofQuestion["rubric"] {
  const behaviorPoint = `Identifies the concrete behavior represented by anchor ${candidate.anchor.id}.`;
  switch (candidate.intent) {
    case "explain":
      return {
        requiredPoints: [
          behaviorPoint,
          "Explains the before-and-after effect and why it is intentional.",
        ],
        rejectsGenericAnswer: true,
      };
    case "predict":
      return {
        requiredPoints: [
          behaviorPoint,
          "Predicts both a normal outcome and a relevant boundary outcome.",
        ],
        rejectsGenericAnswer: true,
      };
    case "tradeoff":
      return {
        requiredPoints: [
          behaviorPoint,
          "Names a concrete tradeoff and a plausible alternative.",
        ],
        rejectsGenericAnswer: true,
      };
    case "failure_path":
      return {
        requiredPoints: [
          behaviorPoint,
          "Explains failure state, containment, and recovery or retry behavior.",
        ],
        rejectsGenericAnswer: true,
      };
    case "test_and_rollback":
      return {
        requiredPoints: [
          behaviorPoint,
          "Proposes an observable test and a specific rollback trigger.",
        ],
        rejectsGenericAnswer: true,
      };
  }
}

function rationale(input: PlanProofBudgetInput, budget: number): string[] {
  const output = [
    `Risk class ${input.analysis.riskLevel} maps to ${String(budget)} proof question${budget === 1 ? "" : "s"} under the repository proof policy.`,
    `Risk vector: scope=${String(input.analysis.riskVector.scope)}, sensitive=${String(input.analysis.riskVector.sensitiveSurface)}, migration=${String(input.analysis.riskVector.migration)}, concurrency=${String(input.analysis.riskVector.concurrency)}.`,
  ];
  if (input.analysis.generatedChangedLines > 0) {
    output.push(
      `${String(input.analysis.generatedChangedLines)} generated changed lines were excluded from proof-budget inflation.`,
    );
  }
  return output;
}

export function planProofBudget(rawInput: unknown): ProofBudgetPlan {
  const input = PlanProofBudgetInputSchema.parse(rawInput);
  const questionBudget = requestedBudget(input);
  const reasons = rationale(input, questionBudget);
  if (input.analysis.riskLevel === "mega") {
    return {
      status: "split_recommended",
      questionBudget: 0,
      rationale: reasons,
      splitRecommendation:
        "Split or narrow the pull request so each proof can be grounded in a bounded, reviewable behavior set.",
    };
  }
  if (input.analysis.anchors.length === 0) {
    return {
      status: "split_recommended",
      questionBudget: 0,
      rationale: reasons,
      splitRecommendation:
        "Provide a text patch with visible hunk anchors before creating proof questions.",
    };
  }
  return { status: "ready", questionBudget, rationale: reasons };
}

export function planProof(
  rawInput: unknown,
  dependencies: PlannerDependencies,
): ProofPlan {
  const input = PlanProofInputSchema.parse(rawInput);
  const budgetPlan = planProofBudget({
    analysis: input.analysis,
    policy: input.policy,
  });
  const budget = budgetPlan.questionBudget;
  const domainSeed = `proof:${input.serverSeed}:${input.analysis.headSha}:${input.versions.planner}:${input.versions.questionTemplates}`;
  const seedCommitment = sha256(domainSeed);
  const splitRecommended = budgetPlan.status === "split_recommended";
  const candidates = stableOrder(
    candidatePool(input.analysis),
    domainSeed,
    (candidate) =>
      `${candidate.anchor.id}:${candidate.focus}:${candidate.intent}`,
  ).slice(0, budget);
  const questions = candidates.map((candidate, index) => ({
    id: deterministicUuid(
      `${domainSeed}:question:${candidate.anchor.id}:${candidate.focus}:${candidate.intent}`,
    ),
    order: index + 1,
    intent: candidate.intent,
    focus: candidate.focus,
    prompt: promptFor(candidate),
    anchor: {
      ...candidate.anchor,
      evidence:
        "Patch content remains external data; resolve this bounded anchor when presenting the question.",
    },
    rubric: rubricFor(candidate),
    maximumAnswerSeconds: input.analysis.riskLevel === "high_risk" ? 120 : 90,
  }));
  const createdAt = dependencies.clock.now();
  const planWithoutHash = {
    id: deterministicUuid(`${domainSeed}:plan`),
    schemaVersion: "1" as const,
    plannerVersion: input.versions.planner,
    questionTemplateVersion: input.versions.questionTemplates,
    analysisSchemaVersion: input.analysis.schemaVersion,
    headSha: input.analysis.headSha,
    riskLevel: input.analysis.riskLevel,
    riskVector: input.analysis.riskVector,
    status: splitRecommended
      ? ("split_recommended" as const)
      : ("ready" as const),
    questionBudget: questions.length,
    rationale: budgetPlan.rationale,
    ...(splitRecommended
      ? {
          splitRecommendation: budgetPlan.splitRecommendation,
        }
      : {}),
    seedCommitment,
    questions,
    createdAt,
  };
  const planHash = sha256(
    JSON.stringify({
      ...planWithoutHash,
      createdAt: createdAt.toISOString(),
    }),
  );
  return ProofPlanSchema.parse({ ...planWithoutHash, planHash });
}

function boundedDisplayPath(path: string): string {
  if (path.length <= 240) return path;
  return `${path.slice(0, 118)}…${path.slice(-118)}`;
}

const PRACTICE_POOL = [
  {
    focus: "patch_map" as const,
    prompt:
      "Summarize the purpose of this patch in one sentence, then name the component boundaries it crosses.",
  },
  {
    focus: "behavior" as const,
    prompt:
      "Describe one user-visible behavior that changed and one input for which that difference matters.",
  },
  {
    focus: "risk" as const,
    prompt:
      "Identify the riskiest assumption in the patch and explain how you would notice that assumption failing.",
  },
  {
    focus: "testing" as const,
    prompt:
      "Sketch a minimal test matrix covering the normal path, one boundary case, and one failure path.",
  },
  {
    focus: "rollback" as const,
    prompt:
      "Choose an observable rollback signal and describe the safest first response if that signal appears.",
  },
] as const;

export function createPracticeSet(
  rawInput: unknown,
  dependencies: PlannerDependencies,
): PracticeSet {
  const input = PracticeInputSchema.parse(rawInput);
  const domainSeed = `practice:${input.practiceSeed}:${input.analysis.headSha}:practice-questions-v1`;
  const selected = stableOrder(
    PRACTICE_POOL,
    domainSeed,
    (item) => item.focus,
  ).slice(0, input.maximumItems);
  return PracticeSetSchema.parse({
    id: deterministicUuid(`${domainSeed}:set`),
    schemaVersion: "1",
    practiceVersion: "practice-questions-v1",
    headSha: input.analysis.headSha,
    seedCommitment: sha256(domainSeed),
    questions: selected.map((item, index) => ({
      id: deterministicUuid(`${domainSeed}:question:${item.focus}`),
      order: index + 1,
      focus: item.focus,
      prompt: item.prompt,
      privateToPracticeSession: true,
    })),
    createdAt: dependencies.clock.now(),
  });
}

export function practiceAndProofAreSeparated(
  practice: PracticeSet,
  proof: ProofPlan,
): boolean {
  const proofIds = new Set(proof.questions.map((question) => question.id));
  const proofPrompts = new Set(
    proof.questions.map((question) => question.prompt),
  );
  return practice.questions.every(
    (question) =>
      !proofIds.has(question.id) && !proofPrompts.has(question.prompt),
  );
}
