import { notFound, redirect } from "next/navigation";
import { readPageSessionRequest } from "../../../lib/http-auth";
import { MaintainerAuthorizationError } from "../../../lib/maintainer-authorization";
import {
  loadReviewDetail,
  ReviewNotFoundError,
} from "../../../lib/maintainer-review";
import {
  hasPrivateReviewContextMetadata,
  loadPrivateReviewContext,
} from "../../../lib/private-review-context";
import {
  buildMaintainerReviewView,
  JUDGE_DID_NOT_FINISH,
} from "../../../lib/review-page-model";
import { ReviewAttemptIdSchema } from "../../../lib/review-http";
import { getWebRuntime } from "../../../lib/runtime";
import { WebRequestRateLimitExceededError } from "../../../lib/request-rate-limit";
import { EvidencePlayer } from "./evidence-player";
import { QuestionReviewList } from "./question-review";
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
  if (evidenceReviewable && hasPrivateReviewContextMetadata(detail)) {
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
  const review = buildMaintainerReviewView({
    authorId: detail.authorId,
    authorLogin: detail.authorLogin,
    recommendation: detail.recommendation,
    evaluationModel: detail.evaluationModel,
    evaluationProvider: detail.evaluationProvider,
    questions: detail.questions,
    privateContext,
  });

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
          {review.authorIsHandle
            ? `@${review.authorLabel}`
            : review.authorLabel}
          {" · "}
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
          The spoken answers are temporarily limited. Try again in{" "}
          {privateContextRetryAfter} second
          {privateContextRetryAfter === 1 ? "" : "s"}. You can still watch the
          video and decide.
        </section>
      ) : null}

      <div className="review-proof-layout">
        <QuestionReviewList questions={review.questions} />

        <div className="review-video-column">
          {review.judgeUnavailable ? (
            <section className="notice-card">{JUDGE_DID_NOT_FINISH}</section>
          ) : review.recommendationLabel ? (
            <section className="model-context-card">
              <p className="eyebrow">Judge</p>
              <h2>Recommendation</h2>
              <strong>{review.recommendationLabel}</strong>
              <p className="review-help">{review.githubCheckNotice}</p>
            </section>
          ) : null}

          {evidenceReviewable ? (
            <EvidencePlayer
              attemptId={detail.attemptId}
              markers={review.videoMarkers}
            />
          ) : (
            <section className="notice-card">
              Video is unavailable because this proof is no longer open for
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
              This review is complete with status {humanStatus(detail.status)}.
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function humanStatus(value: string): string {
  return value.replaceAll("_", " ");
}
