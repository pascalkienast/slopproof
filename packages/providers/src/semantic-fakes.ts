import {
  LearningBundleCandidateV1Schema,
  PracticeFeedbackCandidateV1Schema,
  ProofQuestionCandidateV2Schema,
  type SemanticPatchReferenceV1,
} from "@slopproof/questions";
import { ProviderError } from "./errors";
import {
  LearningMaterialProviderInputV1Schema,
  PracticeCoachProviderInputV1Schema,
  ProofQuestionProviderInputV1Schema,
  SemanticProviderCallContextV1Schema,
  SemanticProviderRawResponseV1Schema,
  SemanticProviderRepairInstructionV1Schema,
  type LearningMaterialProvider,
  type LearningMaterialProviderInputV1,
  type PracticeCoachProvider,
  type PracticeCoachProviderInputV1,
  type ProofQuestionProvider,
  type ProofQuestionProviderInputV1,
  type SemanticProviderCallContextV1,
  type SemanticProviderRawResponseV1,
  type SemanticProviderRepairInstructionV1,
} from "./learning-proof";
import type { z } from "zod";

export type LocalFakeSemanticClock = { now(): Date };

const defaultClock: LocalFakeSemanticClock = { now: () => new Date() };

export class LocalFakeLearningMaterialProvider implements LearningMaterialProvider {
  readonly descriptor = {
    provider: "local-fake",
    model: "deterministic-learning-v1",
  } as const;

  constructor(private readonly clock = defaultClock) {}

  async generate(
    rawInput: LearningMaterialProviderInputV1,
    rawContext: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    const input = parseInput(LearningMaterialProviderInputV1Schema, rawInput);
    assertContext(rawContext, "learning_material", "initial", this.clock);
    return response(learningCandidate(input));
  }

  async repair(
    rawInput: LearningMaterialProviderInputV1,
    rawInstruction: SemanticProviderRepairInstructionV1,
    rawContext: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    const input = parseInput(LearningMaterialProviderInputV1Schema, rawInput);
    parseInput(SemanticProviderRepairInstructionV1Schema, rawInstruction);
    assertContext(rawContext, "learning_material", "repair", this.clock);
    return response(learningCandidate(input));
  }
}

export class LocalFakePracticeCoachProvider implements PracticeCoachProvider {
  readonly descriptor = {
    provider: "local-fake",
    model: "deterministic-practice-v1",
  } as const;

  constructor(private readonly clock = defaultClock) {}

  async generate(
    rawInput: PracticeCoachProviderInputV1,
    rawContext: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    const input = parseInput(PracticeCoachProviderInputV1Schema, rawInput);
    assertContext(rawContext, "practice_feedback", "initial", this.clock);
    return response(practiceCandidate(input));
  }

  async repair(
    rawInput: PracticeCoachProviderInputV1,
    rawInstruction: SemanticProviderRepairInstructionV1,
    rawContext: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    const input = parseInput(PracticeCoachProviderInputV1Schema, rawInput);
    parseInput(SemanticProviderRepairInstructionV1Schema, rawInstruction);
    assertContext(rawContext, "practice_feedback", "repair", this.clock);
    return response(practiceCandidate(input));
  }
}

export class LocalFakeProofQuestionProvider implements ProofQuestionProvider {
  readonly descriptor = {
    provider: "local-fake",
    model: "deterministic-proof-questions-v2",
  } as const;

  constructor(private readonly clock = defaultClock) {}

  async generate(
    rawInput: ProofQuestionProviderInputV1,
    rawContext: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    const input = parseInput(ProofQuestionProviderInputV1Schema, rawInput);
    assertContext(rawContext, "proof_questions", "initial", this.clock);
    return response(proofCandidates(input));
  }

  async repair(
    rawInput: ProofQuestionProviderInputV1,
    rawInstruction: SemanticProviderRepairInstructionV1,
    rawContext: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    const input = parseInput(ProofQuestionProviderInputV1Schema, rawInput);
    parseInput(SemanticProviderRepairInstructionV1Schema, rawInstruction);
    assertContext(rawContext, "proof_questions", "repair", this.clock);
    return response(proofCandidates(input));
  }
}

function learningCandidate(input: LearningMaterialProviderInputV1) {
  const anchors = requiredAnchors(input.generationMaterial);
  const first = anchors[0];
  if (first === undefined) throw invalidInput();
  const statement = (
    text: string,
    anchor: (typeof anchors)[number] = first,
  ) => ({
    text,
    anchorIds: [anchor.id],
    patchReferences: [reference(anchor)],
  });
  const prompts = [
    "Explain the before-and-after behavior at this changed patch hunk.",
    "Describe one boundary or failure case affected by this changed patch hunk.",
    "Propose a focused test that observes the behavior at this changed patch hunk.",
    "Name a rollback signal tied to the behavior at this changed patch hunk.",
    "Trace one caller or consumer affected by this changed patch hunk.",
  ];
  const focuses = [
    "changed_behavior",
    "risk",
    "testing",
    "rollback",
    "interface",
  ] as const;
  return LearningBundleCandidateV1Schema.parse({
    schemaVersion: "1",
    learningVersion: "learning-bundle-v1",
    patchIntent: statement(
      "Understand the observable behavior changed by this bounded patch before proving it.",
    ),
    changedAreas: anchors
      .slice(0, 12)
      .map((anchor) =>
        statement(
          "Map this changed hunk to the component responsibility it modifies.",
          anchor,
        ),
      ),
    behaviors: [
      statement(
        "Compare removed and added lines to identify the concrete behavior change.",
      ),
    ],
    interfaces: [
      statement(
        "Trace the nearest caller or consumer affected by this changed patch hunk.",
      ),
    ],
    risks: [
      statement(
        "Check the boundary and failure behavior introduced by this changed patch hunk.",
      ),
    ],
    testGaps: [
      statement(
        input.generationMaterial.deterministicTestFiles.length === 0
          ? "No changed test file is present for the behavior at this changed patch hunk."
          : "Confirm changed tests cover a boundary and failure case for this changed patch hunk.",
      ),
    ],
    testIdeas: [
      statement(
        "Exercise the normal path and one failing boundary at this changed patch hunk.",
      ),
    ],
    rollbackSignals: [
      statement(
        "Use a regression in the observable behavior at this changed patch hunk as a rollback signal.",
      ),
    ],
    practiceQuestions: Array.from(
      { length: input.practiceQuestionCount },
      (_, index) => {
        const anchor = anchors[index % anchors.length];
        const prompt = prompts[index];
        const focus = focuses[index];
        if (
          anchor === undefined ||
          prompt === undefined ||
          focus === undefined
        ) {
          throw invalidInput();
        }
        return {
          schemaVersion: "2",
          questionVersion: "practice-question-v2",
          focus,
          prompt,
          anchorIds: [anchor.id],
          patchReferences: [reference(anchor)],
          privateToPracticeSession: true,
        };
      },
    ),
  });
}

function practiceCandidate(input: PracticeCoachProviderInputV1) {
  const anchorId = input.practiceQuestion.anchorIds[0];
  const patchReference = input.practiceQuestion.patchReferences.find(
    (candidate) => candidate.anchorId === anchorId,
  );
  if (anchorId === undefined || patchReference === undefined) {
    throw invalidInput();
  }
  const statement = (text: string) => ({
    text,
    anchorIds: [anchorId],
    patchReferences: [patchReference],
  });
  return PracticeFeedbackCandidateV1Schema.parse({
    schemaVersion: "1",
    feedbackVersion: "practice-feedback-v1",
    understood: statement(
      `Your response engages with the changed behavior at anchor ${anchorId}.`,
    ),
    missingPatchDetail: statement(
      `The explanation still needs an explicit before-and-after comparison at anchor ${anchorId}.`,
    ),
    hint: statement(
      `At anchor ${anchorId}, compare the removed line with the added line and describe one observable consequence.`,
    ),
    scoreIncluded: false,
    modelAnswerIncluded: false,
  });
}

function proofCandidates(input: ProofQuestionProviderInputV1) {
  const anchors = requiredAnchors(input.generationMaterial);
  const prompts = [
    "Explain the before-and-after behavior at this changed hunk and why the new behavior is intended.",
    "Predict the normal outcome and one boundary outcome caused by this changed hunk.",
    "Walk through a realistic failure path at this changed hunk, including recovery behavior.",
    "Give a focused test and rollback plan for the behavior at this changed hunk.",
    "Describe the main implementation tradeoff at this changed hunk and one plausible alternative.",
  ];
  return Array.from({ length: input.exactCandidateCount }, (_, index) => {
    const anchor = anchors[index % anchors.length];
    const intent =
      input.permittedIntents[index % input.permittedIntents.length];
    const prompt = prompts[index];
    if (anchor === undefined || intent === undefined || prompt === undefined) {
      throw invalidInput();
    }
    const anchorIds = [anchor.id];
    const patchReferences = [reference(anchor)];
    return ProofQuestionCandidateV2Schema.parse({
      schemaVersion: "2",
      questionVersion: "proof-question-candidate-v2",
      intent,
      focus: `behavior at ${anchor.id}`,
      prompt,
      anchorIds,
      patchReferences,
      rubric: {
        schemaVersion: "2",
        rubricVersion: "proof-rubric-v2",
        requiredPoints: [
          {
            description: `Identifies the concrete behavior represented by anchor ${anchor.id}.`,
            anchorIds,
            patchReferences,
          },
          {
            description:
              "Explains an observable consequence and a relevant boundary or failure case.",
            anchorIds,
            patchReferences,
          },
        ],
        observableSignals: [
          {
            description:
              "The explanation distinguishes removed behavior from added behavior.",
            anchorIds,
            patchReferences,
          },
        ],
        rejectsGenericAnswer: true,
        antiGenericReason: {
          description: `A generic answer would not account for the concrete change at anchor ${anchor.id}.`,
          anchorIds,
          patchReferences,
        },
      },
    });
  });
}

function requiredAnchors(
  material:
    | LearningMaterialProviderInputV1["generationMaterial"]
    | ProofQuestionProviderInputV1["generationMaterial"],
) {
  const allowed = new Set(material.allowedAnchorIds);
  const anchors = material.anchors.filter((anchor) => allowed.has(anchor.id));
  if (anchors.length === 0) throw invalidInput();
  return anchors;
}

function reference(
  anchor: ReturnType<typeof requiredAnchors>[number],
): SemanticPatchReferenceV1 {
  return {
    anchorId: anchor.id,
    file: anchor.filename.content,
    oldStart: anchor.oldStart,
    newStart: anchor.newStart,
  };
}

function response(output: unknown): SemanticProviderRawResponseV1 {
  return SemanticProviderRawResponseV1Schema.parse({
    output,
    tokenUsage: null,
  });
}

function assertContext(
  rawContext: SemanticProviderCallContextV1,
  purpose: SemanticProviderCallContextV1["purpose"],
  phase: SemanticProviderCallContextV1["phase"],
  clock: LocalFakeSemanticClock,
): void {
  const context = parseInput(SemanticProviderCallContextV1Schema, rawContext);
  if (context.purpose !== purpose || context.phase !== phase) {
    throw invalidInput();
  }
  if (context.deadlineAt.getTime() <= clock.now().getTime()) {
    throw new ProviderError(
      "DEADLINE_EXCEEDED",
      "retryable",
      "Local semantic provider deadline elapsed",
    );
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}

function invalidInput(): ProviderError {
  return new ProviderError(
    "INVALID_INPUT",
    "terminal",
    "Local semantic provider input is invalid",
  );
}
