import { notFound, redirect } from "next/navigation";
import { readPageSessionRequest } from "../../../lib/http-auth";
import { MaintainerAuthorizationError } from "../../../lib/maintainer-authorization";
import {
  loadReviewDetail,
  ReviewNotFoundError,
} from "../../../lib/maintainer-review";
import { loadPrivateReviewContext } from "../../../lib/private-review-context";
import { ReviewAttemptIdSchema } from "../../../lib/review-http";
import { getWebRuntime } from "../../../lib/runtime";
import { WebRequestRateLimitExceededError } from "../../../lib/request-rate-limit";
import { AuthoritativeEvaluation } from "./authoritative-evaluation";
import { EvidencePlayer } from "./evidence-player";
import { ReviewDecisionForm } from "./review-decision-form";

export const dynamic = "force-dynamic";

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const parsedAttemptId = ReviewAttemptIdSchema.safeParse(
    (await params).attemptId,
  );
  if (!parsedAttemptId.success) notFound();
  const app = await getWebRuntime();
  const pageAuth = await readPageSessionRequest(
    app,
    `/review/${parsedAttemptId.data}`,
  );
  if (!pageAuth) redirect("/review");

  let detail: Awaited<ReturnType<typeof loadReviewDetail>>;
  try {
    detail = await loadReviewDetail(
      app,
      pageAuth.request,
      pageAuth.session,
      parsedAttemptId.data,
    );
  } catch (error) {
    if (error instanceof WebRequestRateLimitExceededError) {
      return (
        <main className="shell flow-shell review-shell">
          <a className="back-link" href="/review">
            ← Review queue
          </a>
          <section className="notice-card review-empty">
            <p className="eyebrow">Protected review</p>
            <h2>Review refresh is temporarily limited.</h2>
            <p>
              Try again in {error.retryAfterSeconds} second
              {error.retryAfterSeconds === 1 ? "" : "s"}. No private evidence
              was returned by this request.
            </p>
          </section>
        </main>
      );
    }
    if (error instanceof MaintainerAuthorizationError) redirect("/review");
    if (error instanceof ReviewNotFoundError) notFound();
    throw error;
  }

  const evidenceReviewable =
    detail.status === "review_required" &&
    detail.isCurrent &&
    detail.recordingObjectId !== null &&
    detail.deletedAt === null &&
    detail.deleteAfter !== null &&
    detail.deleteAfter.getTime() > Date.now();
  let privateContext: Awaited<ReturnType<typeof loadPrivateReviewContext>> =
    null;
  let privateContextRetryAfter: number | null = null;
  if (evidenceReviewable) {
    try {
      privateContext = await loadPrivateReviewContext(
        app,
        pageAuth.request,
        pageAuth.session,
        detail.attemptId,
      );
    } catch (error) {
      if (error instanceof WebRequestRateLimitExceededError) {
        privateContextRetryAfter = error.retryAfterSeconds;
      } else if (error instanceof MaintainerAuthorizationError) {
        redirect("/review");
      } else {
        throw error;
      }
    }
  }
  const authoritativeEvaluation =
    privateContext?.schemaVersion === "2"
      ? privateContext.authoritativeEvaluation
      : null;
  const modelRecommendation =
    privateContext?.schemaVersion === "2"
      ? authoritativeEvaluation?.candidate.recommendation
      : detail.recommendation;
  const modelIdentity =
    privateContext?.schemaVersion === "2"
      ? authoritativeEvaluation === null
        ? null
        : `${authoritativeEvaluation.invocationMetadata.provider} · ${authoritativeEvaluation.invocationMetadata.model}`
      : detail.evaluationProvider && detail.evaluationModel
        ? `${detail.evaluationProvider} · ${detail.evaluationModel}`
        : null;

  return (
    <main className="shell flow-shell review-shell">
      <a className="back-link" href="/review">
        ← Review queue
      </a>
      <div className="check-header">
        <div>
          <p className="eyebrow">
            {detail.repository} · PR #{detail.pullRequestNumber}
          </p>
          <h1 className="flow-title">Review the proof, not a score.</h1>
        </div>
        <span className="status-pill">{humanStatus(detail.status)}</span>
      </div>
      <div className="sha-row">
        <span>
          {detail.isCurrent ? "Current head SHA" : "Historical head SHA"}
        </span>
        <code>{detail.headSha}</code>
      </div>
      {!detail.isCurrent ? (
        <section className="notice-card error-card">
          This revision is no longer current. Its historical proof cannot
          authorize the new SHA, and no new decision is available here.
        </section>
      ) : null}
      {privateContextRetryAfter !== null ? (
        <section className="notice-card">
          Private model context is temporarily limited. Try again in{" "}
          {privateContextRetryAfter} second
          {privateContextRetryAfter === 1 ? "" : "s"}. Manual review and the
          stored proof plan remain available.
        </section>
      ) : null}

      <div className="review-detail-grid">
        <section className="review-facts-card">
          <p className="eyebrow">Bound review facts</p>
          <h2>Proof context</h2>
          <dl className="review-facts">
            <div>
              <dt>Author</dt>
              <dd>{detail.authorId}</dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>{detail.submittedAt.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Recording</dt>
              <dd>{formatRecording(detail)}</dd>
            </div>
            <div>
              <dt>Transcript</dt>
              <dd>{detail.transcriptProvider ?? "Not available"}</dd>
            </div>
            <div>
              <dt>Selected frames</dt>
              <dd>{detail.frameCount}</dd>
            </div>
            <div>
              <dt>Deletion deadline</dt>
              <dd>
                {detail.deleteAfter?.toLocaleString() ?? "No retained evidence"}
              </dd>
            </div>
          </dl>
        </section>

        <section className="model-context-card">
          <p className="eyebrow">Assistive context · never automatic</p>
          <h2>Model recommendation</h2>
          <strong>
            {modelRecommendation ?? "No recommendation available"}
          </strong>
          <p>
            {modelIdentity ??
              "Authoritative provider output is unavailable; manual review remains possible."}
          </p>
          <p className="review-help">
            This recommendation cannot update the attempt or GitHub check. Only
            the explicit maintainer action below can do so.
          </p>
        </section>
      </div>

      <section className="review-questions" aria-labelledby="questions-heading">
        <p className="eyebrow">Stored proof plan</p>
        <h2 id="questions-heading">Questions and rubrics</h2>
        <div className="question-list">
          {detail.questions.map((question) => (
            <article key={question.id}>
              <span>{question.ordinal + 1}</span>
              <div>
                <p>{question.prompt}</p>
                <details>
                  <summary>Review rubric</summary>
                  <pre>{JSON.stringify(question.rubric, null, 2)}</pre>
                </details>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section
        className="review-questions"
        aria-labelledby="transcript-heading"
      >
        <p className="eyebrow">Private review context · audited access</p>
        <h2 id="transcript-heading">Transcript and timestamps</h2>
        {privateContext ? (
          <div className="question-list transcript-list">
            {privateContext.transcript.segments.map((segment) => (
              <article key={segment.id}>
                <span>{formatTimestamp(segment.startMs)}</span>
                <div>
                  <p>{segment.text.content}</p>
                  <small>
                    {formatTimestamp(segment.startMs)}–
                    {formatTimestamp(segment.endMs)} · {segment.speaker}
                  </small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="review-help">
            The encrypted transcript is currently unavailable. Manual review can
            continue with the private video and stored rubric.
          </p>
        )}
      </section>

      {privateContext ? (
        <section className="review-questions" aria-labelledby="frames-heading">
          <p className="eyebrow">Worker-selected evidence</p>
          <h2 id="frames-heading">Transcript-aligned frames</h2>
          {privateContext.frames.length > 0 ? (
            <div className="review-frame-grid">
              {privateContext.frames.map((frame) => (
                <figure key={frame.id}>
                  {/* The worker returns a bounded, capability-protected JPEG data URL. */}
                  <img
                    alt={`Selected review frame at ${formatTimestamp(frame.timestampMs)}`}
                    height={frame.height}
                    src={`data:${frame.mediaType};base64,${frame.imageBase64}`}
                    width={frame.width}
                  />
                  <figcaption>
                    {formatTimestamp(frame.timestampMs)} · {frame.reasonCode}
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="review-help">
              No frame derivative was selected; use the private recording.
            </p>
          )}
        </section>
      ) : null}

      {privateContext ? (
        <section
          className="review-questions"
          aria-labelledby="evaluation-heading"
        >
          {privateContext.schemaVersion === "2" ? (
            privateContext.authoritativeEvaluation === null ? (
              <>
                <p className="eyebrow">
                  Authoritative private V2 evaluation unavailable
                </p>
                <h2 id="evaluation-heading">Manual review remains required</h2>
                <p className="review-help">
                  The legacy compatibility projection is intentionally not used
                  as authoritative model reasoning. Review the transcript,
                  frames, recording and stored rubric directly.
                </p>
              </>
            ) : (
              <AuthoritativeEvaluation
                evaluation={privateContext.authoritativeEvaluation}
              />
            )
          ) : (
            <LegacyEvaluation evaluation={privateContext.evaluation} />
          )}
        </section>
      ) : null}

      {evidenceReviewable ? (
        <EvidencePlayer
          attemptId={detail.attemptId}
          markers={[
            ...(privateContext?.transcript.segments.map((segment, index) => ({
              id: `transcript:${segment.id}`,
              label: `Transcript segment ${String(index + 1)}`,
              timestampMs: segment.startMs,
            })) ?? []),
            ...(privateContext?.frames.map((frame, index) => ({
              id: `frame:${frame.id}`,
              label: `Selected frame ${String(index + 1)}`,
              timestampMs: frame.timestampMs,
            })) ?? []),
          ].sort((left, right) => left.timestampMs - right.timestampMs)}
        />
      ) : (
        <section className="notice-card">
          Private video is unavailable because this proof is no longer open for
          review, has expired, or has already been deleted.
        </section>
      )}

      {detail.status === "review_required" && detail.isCurrent ? (
        <ReviewDecisionForm
          attemptId={detail.attemptId}
          headSha={detail.headSha}
        />
      ) : (
        <section className="notice-card reviewing-card">
          This append-only review is complete with status{" "}
          {humanStatus(detail.status)}.
        </section>
      )}
    </main>
  );
}

function LegacyEvaluation({
  evaluation,
}: {
  evaluation: Extract<
    NonNullable<Awaited<ReturnType<typeof loadPrivateReviewContext>>>,
    { schemaVersion: "1" }
  >["evaluation"];
}) {
  return (
    <>
      <p className="eyebrow">Legacy structured assistive evaluation</p>
      <h2 id="evaluation-heading">Reasoning for maintainer review</h2>
      <p>{evaluation.privateReason}</p>
      <div className="question-list evaluation-list">
        {evaluation.questionEvaluations.map((question) => (
          <article key={question.questionId}>
            <span>{question.outcome}</span>
            <div>
              <p>{question.reason}</p>
              <ul>
                {question.rubricFindings.map((finding) => (
                  <li key={finding.criterionId}>
                    <strong>{finding.result.replaceAll("_", " ")}</strong>
                    {": "}
                    {finding.reason}
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </div>
      {evaluation.warnings.length > 0 ? (
        <div className="notice-card reviewing-card">
          {evaluation.warnings.join(" · ")}
        </div>
      ) : null}
    </>
  );
}

function humanStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function formatRecording(detail: {
  recordingCodec: string | null;
  recordingBytes: number | null;
  recordingDurationMs: number | null;
}): string {
  if (detail.recordingCodec === null) return "Not available";
  const duration = detail.recordingDurationMs
    ? `${String(Math.round(detail.recordingDurationMs / 1_000))} s`
    : "unknown duration";
  const size = detail.recordingBytes
    ? `${(detail.recordingBytes / 1_048_576).toFixed(1)} MiB`
    : "unknown size";
  return `${duration} · ${size} · ${detail.recordingCodec}`;
}

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
