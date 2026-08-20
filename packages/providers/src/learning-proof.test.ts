import { describe, expect, it } from "vitest";
import {
  LearningMaterialProviderInputV1Schema,
  PracticeCoachProviderInputV1Schema,
  ProofQuestionProviderInputV1Schema,
  SemanticProviderFailureV1Schema,
  SemanticProviderInvocationMetadataV1Schema,
  SemanticProviderRepairInstructionV1Schema,
} from "./learning-proof";

const PROVIDER_MATERIAL = {
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
} as const;

const VERSIONS = {
  promptVersion: "proof-question-system-v2",
  outputSchemaVersion: "proof-question-candidate-v2",
  plannerVersion: "proof-planner-v2",
} as const;

describe("Gate 4 semantic provider ports", () => {
  it("passes only canonical generation material to Learning and rejects Proof leakage", () => {
    const input = {
      schemaVersion: "1",
      inputVersion: "learning-material-input-v1",
      generationMaterial: PROVIDER_MATERIAL,
      practiceQuestionCount: 3,
      versions: {
        ...VERSIONS,
        promptVersion: "learning-system-v1",
        outputSchemaVersion: "learning-bundle-v1",
      },
    };
    expect(LearningMaterialProviderInputV1Schema.parse(input)).toEqual(input);
    expect(
      LearningMaterialProviderInputV1Schema.safeParse({
        ...input,
        proofQuestions: [{ prompt: "private proof content" }],
      }).success,
    ).toBe(false);
  });

  it("caps private Practice text and rejects any Proof-plan input", () => {
    const practiceQuestion = {
      schemaVersion: "2",
      questionVersion: "practice-question-v2",
      focus: "changed_behavior",
      prompt: "Explain the behavior at the bounded changed hunk.",
      anchorIds: ["a0"],
      patchReferences: [
        {
          anchorId: "a0",
          file: "apps/api/route.ts",
          oldStart: 1,
          newStart: 1,
        },
      ],
      privateToPracticeSession: true,
    } as const;
    const input = {
      schemaVersion: "1",
      inputVersion: "practice-coach-input-v1",
      generationMaterial: PROVIDER_MATERIAL,
      practiceQuestion,
      contributorAnswer: {
        trust: "untrusted",
        source: "contributor_answer",
        content: "The route now returns the new status.",
      },
      versions: {
        ...VERSIONS,
        promptVersion: "practice-coach-system-v1",
        outputSchemaVersion: "practice-feedback-v1",
      },
    };
    expect(PracticeCoachProviderInputV1Schema.parse(input)).toEqual(input);
    expect(
      PracticeCoachProviderInputV1Schema.safeParse({
        ...input,
        proofPlan: { questions: [] },
      }).success,
    ).toBe(false);
    expect(
      PracticeCoachProviderInputV1Schema.safeParse({
        ...input,
        contributorAnswer: {
          ...input.contributorAnswer,
          content: "x".repeat(4_001),
        },
      }).success,
    ).toBe(false);
  });

  it("makes Proof input structurally incapable of carrying Practice data", () => {
    const input = {
      schemaVersion: "1",
      inputVersion: "proof-question-input-v1",
      generationMaterial: PROVIDER_MATERIAL,
      exactCandidateCount: 2,
      permittedIntents: ["explain", "failure_path"],
      versions: VERSIONS,
    } as const;
    expect(ProofQuestionProviderInputV1Schema.parse(input)).toEqual(input);
    for (const forbiddenField of [
      "practiceAnswers",
      "practiceDurationMs",
      "practiceClicks",
      "learningBundle",
    ]) {
      expect(
        ProofQuestionProviderInputV1Schema.safeParse({
          ...input,
          [forbiddenField]: [],
        }).success,
      ).toBe(false);
    }
  });

  it("stores content-free provider metadata and one bounded repair instruction", () => {
    const metadata = {
      schemaVersion: "1",
      metadataVersion: "semantic-provider-metadata-v1",
      callId: "10000000-0000-4000-8000-000000000003",
      purpose: "proof_questions",
      provider: "local-test",
      model: "bounded-model",
      promptVersion: "proof-question-system-v2",
      outputSchemaVersion: "proof-question-candidate-v2",
      plannerVersion: "proof-planner-v2",
      inputHash: "3".repeat(64),
      outputHash: "4".repeat(64),
      tokenUsage: { inputTokens: 100, outputTokens: 25 },
      latencyMs: 35,
      invocationCount: 2,
      outcome: "repaired",
      degraded: false,
      completedAt: new Date("2026-08-12T12:00:00.000Z"),
    } as const;
    expect(SemanticProviderInvocationMetadataV1Schema.parse(metadata)).toEqual(
      metadata,
    );
    expect(
      SemanticProviderInvocationMetadataV1Schema.safeParse({
        ...metadata,
        rawPrompt: "private patch",
        providerError: "secret response",
      }).success,
    ).toBe(false);

    const failure = {
      schemaVersion: "semantic-provider-failure-v1",
      failureCode: "PROVIDER_UNAVAILABLE",
      lastFailureKind: "upstream_unavailable",
      httpStatusClass: "5xx",
      transportAttemptCount: 3,
    } as const;
    expect(SemanticProviderFailureV1Schema.parse(failure)).toEqual(failure);
    expect(
      SemanticProviderFailureV1Schema.parse({
        ...failure,
        lastFailureKind: "upstream_unavailable",
        httpStatusClass: "4xx",
        httpStatus: 404,
      }),
    ).toMatchObject({ httpStatus: 404, httpStatusClass: "4xx" });
    expect(
      SemanticProviderFailureV1Schema.safeParse({
        ...failure,
        lastFailureKind: "request_rejected",
        httpStatusClass: "4xx",
        httpStatus: 403,
      }).success,
    ).toBe(true);
    expect(
      SemanticProviderFailureV1Schema.safeParse({
        ...failure,
        lastFailureKind: "request_rejected",
        httpStatusClass: "5xx",
      }).success,
    ).toBe(false);
    expect(
      SemanticProviderFailureV1Schema.safeParse({
        ...failure,
        httpStatus: 404,
      }).success,
    ).toBe(false);
    expect(
      SemanticProviderFailureV1Schema.safeParse({
        ...failure,
        providerMessage: "private upstream response",
      }).success,
    ).toBe(false);

    expect(
      SemanticProviderRepairInstructionV1Schema.safeParse({
        schemaVersion: "1",
        invalidOutputHash: "5".repeat(64),
        validationCode: "anchor_invalid",
        maximumAdditionalAttempts: 2,
      }).success,
    ).toBe(false);
  });
});
