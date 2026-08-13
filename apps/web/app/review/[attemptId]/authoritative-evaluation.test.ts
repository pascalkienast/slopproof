import { AuthoritativeMultimodalEvaluationV1Schema } from "@slopproof/providers";
import { describe, expect, it } from "vitest";
import { buildAuthoritativeEvaluationViewModel } from "./authoritative-evaluation-model";

describe("authoritative maintainer evaluation view model", () => {
  it("preserves exact unavailable-evidence codes and never presents an automatic decision", () => {
    const evaluation = AuthoritativeMultimodalEvaluationV1Schema.parse({
      schemaVersion: "1",
      evaluationVersion: "multimodal-proof-evaluation-v1",
      attemptId: "83000000-0000-4000-8000-000000000001",
      revisionId: "83000000-0000-4000-8000-000000000002",
      headSha: "a".repeat(40),
      candidate: {
        schemaVersion: "1",
        candidateVersion: "multimodal-judge-candidate-v1",
        recommendation: "review_required",
        questionEvaluations: [
          {
            questionId: "83000000-0000-4000-8000-000000000003",
            criterionResults: [
              {
                criterionId: "83000000-0000-4000-8000-000000000004",
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
        inputHash: "b".repeat(64),
        outputHash: "c".repeat(64),
        tokenUsage: null,
        latencyMs: 100,
        invocationCount: 1,
        outcome: "generated",
        degraded: false,
        completedAt: new Date("2026-08-13T00:00:00.000Z"),
      },
      frameWarnings: [],
      workflowOutcome: "review_required",
      manualReviewRequired: true,
      createdAt: new Date("2026-08-13T00:00:01.000Z"),
    });

    const view = buildAuthoritativeEvaluationViewModel(evaluation);

    expect(view.questions[0]).toMatchObject({
      questionId: "83000000-0000-4000-8000-000000000003",
      criterionResults: [
        {
          criterionId: "83000000-0000-4000-8000-000000000004",
          result: "not_evaluable",
          reason: "question_evidence_insufficient",
          supportedPatchAnchorIds: [],
          anchorLabel: "no supporting anchor",
        },
      ],
      contradictions: ["transcript_conflicts_with_patch_evidence"],
      uncertainty: ["criterion_requires_maintainer_assessment"],
    });
    expect(view.manualReviewNotice).toContain("only the maintainer action can");
    expect(JSON.stringify(view)).not.toContain("Compatibility sentinel");
  });
});
