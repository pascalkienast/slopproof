import { describe, expect, it } from "vitest";
import {
  AuthoritativeMultimodalEvaluationV1Schema,
  PrivateReviewContextV2Schema,
} from "./contracts";

const ids = {
  attempt: "81000000-0000-4000-8000-000000000001",
  revision: "81000000-0000-4000-8000-000000000002",
  transcript: "81000000-0000-4000-8000-000000000003",
  question: "81000000-0000-4000-8000-000000000004",
  criterion: "81000000-0000-4000-8000-000000000005",
};

describe("private authoritative review contracts", () => {
  it("revives exact dates and preserves not_evaluable evidence codes", () => {
    const context = PrivateReviewContextV2Schema.parse(contextFixture());

    expect(context.authoritativeEvaluation?.createdAt).toBeInstanceOf(Date);
    expect(
      context.authoritativeEvaluation?.invocationMetadata.completedAt,
    ).toBeInstanceOf(Date);
    expect(
      context.authoritativeEvaluation?.candidate.questionEvaluations[0],
    ).toMatchObject({
      criterionResults: [
        {
          criterionId: ids.criterion,
          result: "not_evaluable",
          supportedPatchAnchorIds: [],
          reason: "question_evidence_insufficient",
        },
      ],
      contradictions: ["transcript_conflicts_with_patch_evidence"],
      uncertainty: ["criterion_requires_maintainer_assessment"],
    });
  });

  it.each([
    ["non-exact date", "2026-08-13T00:00:00Z"],
    ["future provider completion", "2026-08-13T00:00:02.000Z"],
  ])("rejects %s", (_name, completedAt) => {
    const authoritative = authoritativeFixture();
    authoritative.invocationMetadata.completedAt = completedAt;
    expect(() =>
      AuthoritativeMultimodalEvaluationV1Schema.parse(authoritative),
    ).toThrow();
  });

  it("rejects compatibility and authoritative artifacts bound to different heads", () => {
    const context = contextFixture();
    context.authoritativeEvaluation.headSha = "c".repeat(40);
    expect(() => PrivateReviewContextV2Schema.parse(context)).toThrow();
  });

  it("rejects not_met without an exact conflicting patch anchor", () => {
    const authoritative = authoritativeFixture();
    authoritative.candidate.questionEvaluations[0]!.criterionResults = [
      {
        criterionId: ids.criterion,
        result: "not_met",
        supportedPatchAnchorIds: [],
        reason: "patch_evidence_conflicts_with_criterion",
      },
    ];

    expect(() =>
      AuthoritativeMultimodalEvaluationV1Schema.parse(authoritative),
    ).toThrow();
  });

  it.each(["contradictions", "uncertainty"] as const)(
    "rejects pass while %s remain",
    (field) => {
      const authoritative = authoritativeFixture();
      const question = authoritative.candidate.questionEvaluations[0]!;
      authoritative.candidate.recommendation = "pass";
      question.criterionResults = [
        {
          criterionId: ids.criterion,
          result: "met",
          supportedPatchAnchorIds: ["a0"],
          reason: "patch_evidence_supports_criterion",
        },
      ];
      question.contradictions =
        field === "contradictions"
          ? ["transcript_conflicts_with_patch_evidence"]
          : [];
      question.uncertainty =
        field === "uncertainty"
          ? ["criterion_requires_maintainer_assessment"]
          : [];

      expect(() =>
        AuthoritativeMultimodalEvaluationV1Schema.parse(authoritative),
      ).toThrow();
    },
  );
});

function contextFixture() {
  return {
    schemaVersion: "2",
    attemptId: ids.attempt,
    transcript: {
      schemaVersion: "1",
      transcriptVersion: "transcript-v1",
      id: ids.transcript,
      attemptId: ids.attempt,
      provider: "openrouter",
      model: "whisper",
      language: "en",
      durationMs: 1_000,
      sourceSha256: "a".repeat(64),
      segments: [
        {
          id: "81000000-0000-4000-8000-000000000006",
          questionId: ids.question,
          startMs: 0,
          endMs: 1_000,
          speaker: "contributor",
          text: { trust: "untrusted", source: "transcript", content: "answer" },
        },
      ],
      createdAt: "2026-08-13T00:00:00.000Z",
    },
    compatibilityEvaluation: {
      schemaVersion: "1",
      evaluationVersion: "proof-evaluation-v1",
      attemptId: ids.attempt,
      revisionId: ids.revision,
      headSha: "b".repeat(40),
      provider: "multimodal-compatibility-v1",
      model: "manual-review-projection-v1",
      systemInstructionVersion: "proof-judge-system-v1",
      recommendation: "review_required",
      questionEvaluations: [
        {
          questionId: ids.question,
          outcome: "not_evaluable",
          rubricFindings: [
            {
              criterionId: ids.criterion,
              result: "met",
              reason: "Compatibility sentinel only",
            },
          ],
          supportedPatchAnchorIds: [],
          reason: "Consult authoritative sidecar",
        },
      ],
      privateReason: "Compatibility-only projection",
      warnings: ["authoritative_multimodal_sidecar_required"],
      createdAt: "2026-08-13T00:00:01.000Z",
    },
    authoritativeEvaluation: authoritativeFixture(),
    frames: [],
  };
}

function authoritativeFixture() {
  return {
    schemaVersion: "1",
    evaluationVersion: "multimodal-proof-evaluation-v1",
    attemptId: ids.attempt,
    revisionId: ids.revision,
    headSha: "b".repeat(40),
    candidate: {
      schemaVersion: "1",
      candidateVersion: "multimodal-judge-candidate-v1",
      recommendation: "review_required",
      questionEvaluations: [
        {
          questionId: ids.question,
          criterionResults: [
            {
              criterionId: ids.criterion,
              result: "not_evaluable",
              supportedPatchAnchorIds: [] as string[],
              reason: "question_evidence_insufficient",
            },
          ],
          contradictions: ["transcript_conflicts_with_patch_evidence"],
          uncertainty: ["criterion_requires_maintainer_assessment"],
        },
      ],
      privateReason: "stored_criteria_not_fully_supported",
      warnings: ["frames_unavailable"],
    },
    invocationMetadata: {
      schemaVersion: "1",
      provider: "hetzner-inference",
      model: "judge-model",
      promptVersion: "proof-judge-system-v2",
      outputSchemaVersion: "multimodal-judge-candidate-v1",
      inputHash: "c".repeat(64),
      outputHash: "d".repeat(64),
      tokenUsage: null,
      latencyMs: 100,
      invocationCount: 1,
      outcome: "generated",
      degraded: false,
      completedAt: "2026-08-13T00:00:00.000Z",
    },
    frameWarnings: [],
    workflowOutcome: "review_required",
    manualReviewRequired: true,
    createdAt: "2026-08-13T00:00:01.000Z",
  };
}
