import {
  REQUIRED_POINTS_UNAVAILABLE,
  type MaintainerQuestionReview,
} from "../../../lib/review-page-model";

export function QuestionReviewList({
  questions,
}: {
  questions: readonly MaintainerQuestionReview[];
}) {
  return (
    <section className="review-questions" aria-labelledby="questions-heading">
      <p className="eyebrow">The proof</p>
      <h2 id="questions-heading">Questions and answers</h2>
      <div className="review-question-stack">
        {questions.map((question) => (
          <article
            className="review-question-block"
            data-question-id={question.questionId}
            key={question.questionId}
          >
            <p className="eyebrow">{question.heading}</p>
            <h3>{question.prompt}</h3>

            <div className="review-question-section">
              <h4>Spoken answer</h4>
              <p>{question.spokenAnswer}</p>
            </div>

            <div className="review-question-section">
              <h4>Needed in the answer</h4>
              {question.requiredPoints.length > 0 ? (
                <ul>
                  {question.requiredPoints.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              ) : (
                <p>{REQUIRED_POINTS_UNAVAILABLE}</p>
              )}
            </div>

            <div
              className="review-question-section"
              data-judge-finished={question.judgeFinished ? "true" : "false"}
            >
              <h4>Judge opinion</h4>
              <p>{question.judgeOpinion}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
