import { describe, expect, it } from "vitest";
import { parsePrivateReviewContextResponse } from "./private-review-context";

describe("private review response parsing", () => {
  it("preserves the exact authoritative V2 result instead of the compatibility sentinel", () => {
    const parsed = parsePrivateReviewContextResponse(
      JSON.stringify(v2Fixture()),
    );
    expect(parsed.schemaVersion).toBe("2");
    if (parsed.schemaVersion !== "2") throw new Error("expected V2 context");
    expect(parsed.compatibilityEvaluation.questionEvaluations[0]).toMatchObject(
      {
        outcome: "not_evaluable",
        rubricFindings: [expect.objectContaining({ result: "met" })],
      },
    );
    expect(
      parsed.authoritativeEvaluation?.candidate.questionEvaluations[0],
    ).toMatchObject({
      criterionResults: [expect.objectContaining({ result: "not_evaluable" })],
      contradictions: ["transcript_conflicts_with_patch_evidence"],
      uncertainty: ["criterion_requires_maintainer_assessment"],
    });
  });

  it("fails closed on an invalid authoritative date", () => {
    const fixture = v2Fixture();
    fixture.authoritativeEvaluation.invocationMetadata.completedAt =
      "2026-08-13T00:00:00Z";
    expect(() =>
      parsePrivateReviewContextResponse(JSON.stringify(fixture)),
    ).toThrow();
  });
});

function v2Fixture() {
  const attemptId = "82000000-0000-4000-8000-000000000001";
  const revisionId = "82000000-0000-4000-8000-000000000002";
  const questionId = "82000000-0000-4000-8000-000000000003";
  const criterionId = "82000000-0000-4000-8000-000000000004";
  return {
    schemaVersion: "2",
    attemptId,
    transcript: {
      schemaVersion: "1",
      transcriptVersion: "transcript-v1",
      id: "82000000-0000-4000-8000-000000000005",
      attemptId,
      provider: "openrouter",
      model: "whisper",
      language: "en",
      durationMs: 1_000,
      sourceSha256: "a".repeat(64),
      segments: [
        {
          id: "82000000-0000-4000-8000-000000000006",
          questionId,
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
      attemptId,
      revisionId,
      headSha: "b".repeat(40),
      provider: "multimodal-compatibility-v1",
      model: "manual-review-projection-v1",
      systemInstructionVersion: "proof-judge-system-v1",
      recommendation: "review_required",
      questionEvaluations: [
        {
          questionId,
          outcome: "not_evaluable",
          rubricFindings: [
            {
              criterionId,
              result: "met",
              reason: "Compatibility sentinel",
            },
          ],
          supportedPatchAnchorIds: [],
          reason: "Consult sidecar",
        },
      ],
      privateReason: "Compatibility-only projection",
      warnings: ["authoritative_multimodal_sidecar_required"],
      createdAt: "2026-08-13T00:00:01.000Z",
    },
    authoritativeEvaluation: {
      schemaVersion: "1",
      evaluationVersion: "multimodal-proof-evaluation-v1",
      attemptId,
      revisionId,
      headSha: "b".repeat(40),
      candidate: {
        schemaVersion: "1",
        candidateVersion: "multimodal-judge-candidate-v1",
        recommendation: "review_required",
        questionEvaluations: [
          {
            questionId,
            criterionResults: [
              {
                criterionId,
                result: "not_evaluable",
                supportedPatchAnchorIds: [],
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
    },
    frames: [],
  };
}
