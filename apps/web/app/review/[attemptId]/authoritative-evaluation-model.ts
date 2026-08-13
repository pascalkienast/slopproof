import type { AuthoritativeMultimodalEvaluationV1 } from "@slopproof/providers";

export function buildAuthoritativeEvaluationViewModel(
  evaluation: AuthoritativeMultimodalEvaluationV1,
) {
  return {
    privateReason: evaluation.candidate.privateReason,
    provider: evaluation.invocationMetadata.provider,
    model: evaluation.invocationMetadata.model,
    recommendation: evaluation.candidate.recommendation,
    manualReviewNotice:
      "This result cannot decide the attempt; only the maintainer action can.",
    questions: evaluation.candidate.questionEvaluations.map((question) => ({
      questionId: question.questionId,
      criterionResults: question.criterionResults.map((criterion) => ({
        criterionId: criterion.criterionId,
        result: criterion.result,
        reason: criterion.reason,
        supportedPatchAnchorIds: [...criterion.supportedPatchAnchorIds],
        anchorLabel:
          criterion.supportedPatchAnchorIds.length > 0
            ? "anchors"
            : "no supporting anchor",
      })),
      contradictions: [...question.contradictions],
      uncertainty: [...question.uncertainty],
    })),
    warnings: [...evaluation.candidate.warnings],
  } as const;
}
