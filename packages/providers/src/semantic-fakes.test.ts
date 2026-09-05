import type { GenerationProviderMaterialV1 } from "@understandproof/analysis";
import { describe, expect, it } from "vitest";
import {
  LocalFakeLearningMaterialProvider,
  LocalFakePracticeCoachProvider,
  LocalFakeProofQuestionProvider,
} from "./semantic-fakes";
import type {
  LearningMaterialProviderInputV1,
  PracticeCoachProviderInputV1,
  ProofQuestionProviderInputV1,
  SemanticProviderCallContextV1,
} from "./learning-proof";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const clock = { now: () => NOW };

describe("local fake semantic providers", () => {
  it("generates deterministic offline Learning, Practice and Proof candidates", async () => {
    const learningProvider = new LocalFakeLearningMaterialProvider(clock);
    const learning = await learningProvider.generate(
      learningInput(),
      context("learning_material"),
    );
    expect(learning.output).toMatchObject({
      schemaVersion: "1",
      practiceQuestions: expect.any(Array),
    });
    expect(
      (learning.output as { practiceQuestions: unknown[] }).practiceQuestions,
    ).toHaveLength(3);

    const practice = await new LocalFakePracticeCoachProvider(clock).generate(
      practiceInput(),
      context("practice_feedback"),
    );
    expect(practice.output).toMatchObject({
      scoreIncluded: false,
      modelAnswerIncluded: false,
    });

    const proofProvider = new LocalFakeProofQuestionProvider(clock);
    const first = await proofProvider.generate(
      proofInput(),
      context("proof_questions"),
    );
    const second = await proofProvider.generate(
      proofInput(),
      context("proof_questions"),
    );
    expect(first).toEqual(second);
    expect(first.output).toHaveLength(2);
    expect(first.tokenUsage).toBeNull();
  });

  it("uses the same strict phase, purpose and deadline contracts", async () => {
    const provider = new LocalFakeProofQuestionProvider(clock);
    await expect(
      provider.generate(proofInput(), {
        ...context("proof_questions"),
        phase: "repair",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.generate(proofInput(), {
        ...context("proof_questions"),
        deadlineAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
  });
});

function context(
  purpose: SemanticProviderCallContextV1["purpose"],
): SemanticProviderCallContextV1 {
  return {
    schemaVersion: "1",
    callId: "10000000-0000-4000-8000-000000000001",
    revisionId: "10000000-0000-4000-8000-000000000002",
    headSha: "a".repeat(40),
    contextHash: "b".repeat(64),
    purpose,
    phase: "initial",
    deadlineAt: new Date(NOW.getTime() + 30_000),
  };
}

function learningInput(): LearningMaterialProviderInputV1 {
  return {
    schemaVersion: "1",
    inputVersion: "learning-material-input-v1",
    generationMaterial: MATERIAL,
    practiceQuestionCount: 3,
    versions: {
      promptVersion: "learning-system-v1",
      outputSchemaVersion: "learning-bundle-v1",
      plannerVersion: "proof-planner-v2",
    },
  };
}

function practiceInput(): PracticeCoachProviderInputV1 {
  return {
    schemaVersion: "1",
    inputVersion: "practice-coach-input-v1",
    generationMaterial: MATERIAL,
    practiceQuestion: {
      schemaVersion: "2",
      questionVersion: "practice-question-v2",
      focus: "changed_behavior",
      prompt: "Explain the changed behavior at this bounded patch hunk.",
      anchorIds: ["a0"],
      patchReferences: [reference()],
      privateToPracticeSession: true,
    },
    contributorAnswer: {
      trust: "untrusted",
      source: "contributor_answer",
      content: "The route returns a different result.",
    },
    versions: {
      promptVersion: "practice-coach-system-v1",
      outputSchemaVersion: "practice-feedback-v1",
      plannerVersion: "proof-planner-v2",
    },
  };
}

function proofInput(): ProofQuestionProviderInputV1 {
  return {
    schemaVersion: "1",
    inputVersion: "proof-question-input-v1",
    generationMaterial: MATERIAL,
    exactCandidateCount: 2,
    permittedIntents: ["explain", "failure_path"],
    versions: {
      promptVersion: "proof-question-system-v2",
      outputSchemaVersion: "proof-question-candidate-v2",
      plannerVersion: "proof-planner-v2",
    },
  };
}

const MATERIAL: GenerationProviderMaterialV1 = {
  schemaVersion: "1",
  trust: "untrusted_github_revision",
  title: {
    trust: "untrusted",
    source: "pull_request_title",
    content: "Change a route",
  },
  body: null,
  files: [],
  anchors: [
    {
      id: "a0",
      filename: {
        trust: "untrusted",
        source: "pull_request_filename",
        content: "apps/api/route.ts",
      },
      hunkHeader: {
        trust: "untrusted",
        source: "analysis_hunk_header",
        content: "@@ -1,1 +1,1 @@",
      },
      oldStart: 1,
      newStart: 1,
      changedLines: 2,
      evidence: {
        trust: "untrusted",
        source: "analysis_anchor_evidence",
        content: "-old\n+new",
      },
    },
  ],
  excerpts: [],
  deterministicTestFiles: [],
  allowedAnchorIds: ["a0"],
  limits: {
    maximumFiles: 120,
    maximumHunks: 400,
    maximumTotalBytes: 512 * 1_024,
    maximumFileBytes: 64 * 1_024,
    maximumTitleBytes: 2 * 1_024,
    maximumBodyBytes: 16 * 1_024,
    maximumExcerpts: 12,
    maximumExcerptBytes: 4_096,
  },
  limitsHit: [],
  exclusions: [],
};

function reference() {
  return {
    anchorId: "a0" as const,
    file: "apps/api/route.ts",
    oldStart: 1,
    newStart: 1,
  };
}
