import type { AuthoritativeMultimodalEvaluationV1 } from "@slopproof/providers";
import { buildAuthoritativeEvaluationViewModel } from "./authoritative-evaluation-model";

export function AuthoritativeEvaluation({
  evaluation,
}: {
  evaluation: AuthoritativeMultimodalEvaluationV1;
}) {
  const view = buildAuthoritativeEvaluationViewModel(evaluation);
  return (
    <>
      <p className="eyebrow">
        Authoritative private V2 evaluation · assistive only
      </p>
      <h2 id="evaluation-heading">Reasoning for maintainer review</h2>
      <p>
        Private reason: <code>{view.privateReason}</code>
      </p>
      <p className="review-help">
        {view.provider} · {view.model}
        {" · recommendation "}
        <code>{view.recommendation}</code>. {view.manualReviewNotice}
      </p>
      <div className="question-list evaluation-list">
        {view.questions.map((question) => (
          <article key={question.questionId}>
            <span>question</span>
            <div>
              <p>
                Question ID: <code>{question.questionId}</code>
              </p>
              <ul>
                {question.criterionResults.map((criterion) => (
                  <li key={criterion.criterionId}>
                    <strong>{criterion.result}</strong>
                    {" · criterion "}
                    <code>{criterion.criterionId}</code>
                    {" · reason "}
                    <code>{criterion.reason}</code>
                    {criterion.supportedPatchAnchorIds.length > 0 ? (
                      <>
                        {` · ${criterion.anchorLabel} `}
                        {criterion.supportedPatchAnchorIds.map((anchorId) => (
                          <code key={anchorId}>{anchorId}</code>
                        ))}
                      </>
                    ) : (
                      ` · ${criterion.anchorLabel}`
                    )}
                  </li>
                ))}
              </ul>
              <CodeList
                emptyLabel="No coded contradictions."
                label="Contradictions"
                values={question.contradictions}
              />
              <CodeList
                emptyLabel="No coded uncertainty."
                label="Uncertainty"
                values={question.uncertainty}
              />
            </div>
          </article>
        ))}
      </div>
      <CodeList
        emptyLabel="No authoritative warning codes."
        label="Warnings"
        values={view.warnings}
      />
    </>
  );
}

function CodeList({
  emptyLabel,
  label,
  values,
}: {
  emptyLabel: string;
  label: string;
  values: readonly string[];
}) {
  if (values.length === 0) return <p className="review-help">{emptyLabel}</p>;
  return (
    <p className="review-help">
      {label}:{" "}
      {values.map((value) => (
        <code key={value}>{value}</code>
      ))}
    </p>
  );
}
