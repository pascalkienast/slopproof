import { MaintainerAuthorizationError } from "../../lib/maintainer-authorization";
import { loadReviewQueue } from "../../lib/maintainer-review";
import { readPageSessionRequest } from "../../lib/http-auth";
import { getWebRuntime } from "../../lib/runtime";
import { WebRequestRateLimitExceededError } from "../../lib/request-rate-limit";
import { DemoMaintainerLogin } from "./demo-maintainer-login";

export const dynamic = "force-dynamic";

export default async function ReviewQueuePage() {
  const app = await getWebRuntime();
  const pageAuth = await readPageSessionRequest(app, "/review");
  if (!pageAuth) {
    return (
      <ReviewShell>
        <section className="notice-card review-empty">
          <p className="eyebrow">Protected review</p>
          <h2>Maintainer authorization required.</h2>
          <p>
            Evidence and review decisions are repository-bound. The local MVP
            exposes a demo maintainer session only while offline demo mode is
            enabled.
          </p>
          {app.config.DEMO_MODE ? (
            <DemoMaintainerLogin />
          ) : (
            <GithubMaintainerLogin />
          )}
        </section>
      </ReviewShell>
    );
  }

  try {
    const queue = await loadReviewQueue(
      app,
      pageAuth.request,
      pageAuth.session,
    );
    return (
      <ReviewShell>
        <div className="check-header">
          <div>
            <p className="eyebrow">
              Protected queue · {queue.authorization.owner}/
              {queue.authorization.name}
            </p>
            <h1 className="flow-title">
              Human review, bound to the current SHA.
            </h1>
          </div>
          <span className="status-pill">{queue.items.length} open</span>
        </div>
        <p className="lede">
          Model output is context, never the decision. Every detail view,
          evidence stream and maintainer action is authorized again and audited.
        </p>
        {queue.items.length === 0 ? (
          <section className="notice-card review-empty">
            <h2>Nothing waiting.</h2>
            <p>No current proof in this repository requires review.</p>
          </section>
        ) : (
          <div className="review-queue" aria-label="Proofs awaiting review">
            {queue.items.map((item) => (
              <a
                className="review-row"
                href={`/review/${item.attemptId}`}
                key={item.attemptId}
              >
                <div>
                  <span className="eyebrow">PR #{item.pullRequestNumber}</span>
                  <strong>
                    {item.questionCount} question
                    {item.questionCount === 1 ? "" : "s"}
                  </strong>
                  <span>Author {item.authorId}</span>
                </div>
                <div className="review-row-facts">
                  <code>{item.headSha}</code>
                  <span>{item.hasRecording ? "Video ready" : "No video"}</span>
                  <span>
                    {item.hasTranscript ? "Transcript ready" : "No transcript"}
                  </span>
                  <span>{formatAge(item.submittedAt)}</span>
                </div>
                <span className="status-pill">review required</span>
              </a>
            ))}
          </div>
        )}
      </ReviewShell>
    );
  } catch (error) {
    if (error instanceof WebRequestRateLimitExceededError) {
      return (
        <ReviewShell>
          <section className="notice-card review-empty">
            <p className="eyebrow">Protected review</p>
            <h2>Review refresh is temporarily limited.</h2>
            <p>
              Try again in {error.retryAfterSeconds} second
              {error.retryAfterSeconds === 1 ? "" : "s"}. No private review data
              was returned by this request.
            </p>
          </section>
        </ReviewShell>
      );
    }
    if (!(error instanceof MaintainerAuthorizationError)) throw error;
    return (
      <ReviewShell>
        <section className="notice-card error-card review-empty">
          <p className="eyebrow">Access denied</p>
          <h2>This session cannot review this repository.</h2>
          <p>
            A fresh, repository-bound GitHub maintainer authorization is
            required. No evidence metadata was returned.
          </p>
          {app.config.DEMO_MODE ? (
            <DemoMaintainerLogin />
          ) : (
            <GithubMaintainerLogin />
          )}
        </section>
      </ReviewShell>
    );
  }
}

function GithubMaintainerLogin() {
  return (
    <a
      className="button primary"
      href="/api/auth/github/start?returnTo=%2Freview"
    >
      Authorize with GitHub
    </a>
  );
}

function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="shell flow-shell review-shell">
      <a className="back-link" href="/demo">
        ← Local demo
      </a>
      {children}
    </main>
  );
}

function formatAge(value: Date): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - value.getTime()) / 60_000),
  );
  if (minutes < 60) return `${String(minutes)} min waiting`;
  return `${String(Math.round(minutes / 60))} h waiting`;
}
