import { MaintainerAuthorizationError } from "../../lib/maintainer-authorization";
import { loadReviewQueue } from "../../lib/maintainer-review";
import { readPageSessionRequest } from "../../lib/http-auth";
import { getWebRuntime } from "../../lib/runtime";
import { WebRequestRateLimitExceededError } from "../../lib/request-rate-limit";
import {
  listActiveMaintainerRepositories,
  type ActiveMaintainerRepositoryV1,
} from "../../lib/github-oauth-production";
import { DemoMaintainerLogin } from "./demo-maintainer-login";

export const dynamic = "force-dynamic";

export default async function ReviewQueuePage() {
  const app = await getWebRuntime();
  const pageAuth = await readPageSessionRequest(app, "/review");
  if (!pageAuth) {
    return (
      <ReviewShell demoMode={app.config.DEMO_MODE}>
        <section className="notice-card review-empty">
          <p className="eyebrow">Protected review</p>
          <h2>Maintainer authorization required.</h2>
          {app.config.DEMO_MODE ? (
            <p>
              Evidence and review decisions are repository-bound. This local
              environment exposes a demo maintainer session for offline use.
            </p>
          ) : (
            <p>
              Evidence and review decisions are repository-bound. Authorize with
              GitHub to open the protected maintainer queue.
            </p>
          )}
          {app.config.DEMO_MODE ? (
            <DemoMaintainerLogin />
          ) : (
            <GithubMaintainerLogin
              repositories={await loadReviewLoginRepositories(app)}
            />
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
      <ReviewShell demoMode={app.config.DEMO_MODE}>
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
        <ReviewShell demoMode={app.config.DEMO_MODE}>
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
      <ReviewShell demoMode={app.config.DEMO_MODE}>
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
            <GithubMaintainerLogin
              repositories={await loadReviewLoginRepositories(app)}
            />
          )}
        </section>
      </ReviewShell>
    );
  }
}

async function loadReviewLoginRepositories(
  app: Awaited<ReturnType<typeof getWebRuntime>>,
): Promise<readonly ActiveMaintainerRepositoryV1[]> {
  try {
    return await listActiveMaintainerRepositories(app.database.pool);
  } catch {
    return [];
  }
}

function GithubMaintainerLogin({
  repositories,
}: {
  repositories: readonly ActiveMaintainerRepositoryV1[];
}) {
  if (repositories.length === 0) {
    return (
      <p className="review-login">
        Maintainer authorization is temporarily unavailable.
      </p>
    );
  }
  if (repositories.length === 1) {
    return (
      <a
        className="button primary review-login"
        href={reviewAuthorizationHref(repositories[0]!.id)}
      >
        Authorize with GitHub
      </a>
    );
  }
  return (
    <nav className="review-login review-repo-choice" aria-label="Choose repository">
      <p>Choose the repository to review.</p>
      <ul>
        {repositories.map((repository) => (
          <li key={repository.id}>
            <a
              className="button primary"
              href={reviewAuthorizationHref(repository.id)}
            >
              Authorize {repository.owner}/{repository.name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function reviewAuthorizationHref(repositoryId: string): string {
  return `/api/auth/github/start?returnTo=${encodeURIComponent("/review")}&repositoryId=${encodeURIComponent(repositoryId)}`;
}

function ReviewShell({
  children,
  demoMode,
}: {
  children: React.ReactNode;
  demoMode: boolean;
}) {
  return (
    <main className="shell flow-shell review-shell">
      {demoMode ? (
        <a className="back-link" href="/demo">
          ← Local demo
        </a>
      ) : null}
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
