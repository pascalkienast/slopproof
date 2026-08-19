import { cookies } from "next/headers";
import { MaintainerAuthorizationError } from "../../lib/maintainer-authorization";
import {
  loadSealedMaintainerDirectory,
  MAINTAINER_DIRECTORY_COOKIE,
} from "../../lib/maintainer-directory";
import { loadReviewQueue } from "../../lib/maintainer-review";
import { readPageSessionRequest } from "../../lib/http-auth";
import { getWebRuntime } from "../../lib/runtime";
import { WebRequestRateLimitExceededError } from "../../lib/request-rate-limit";
import {
  loadActiveMaintainerRepository,
  type ActiveMaintainerRepositoryV1,
} from "../../lib/github-oauth-production";
import { formatAuthorLabel, isGithubHandle } from "../../lib/review-page-model";
import { DemoMaintainerLogin } from "./demo-maintainer-login";
import { z } from "zod";

export const dynamic = "force-dynamic";

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ repositoryId?: string | string[] }>;
}) {
  const app = await getWebRuntime();
  const requestedRepository = await loadRequestedReviewRepository(
    app,
    await searchParams,
  );
  const pageAuth = await readPageSessionRequest(app, "/review");
  const sessionMatchesRequestedRepository =
    requestedRepository === undefined ||
    (requestedRepository !== "invalid" &&
      pageAuth?.session.repositoryId === requestedRepository.id);
  if (
    requestedRepository === "invalid" ||
    !pageAuth ||
    !sessionMatchesRequestedRepository
  ) {
    return (
      <ReviewShell demoMode={app.config.DEMO_MODE}>
        <ReviewAuthWall
          demoMode={app.config.DEMO_MODE}
          directory={
            app.config.DEMO_MODE || requestedRepository !== undefined
              ? null
              : await loadPageMaintainerDirectory(app)
          }
          pageAuth={Boolean(pageAuth)}
          requestedRepository={requestedRepository}
          sessionMismatch={Boolean(
            pageAuth && !sessionMatchesRequestedRepository,
          )}
        />
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
                  <span>
                    {authorQueueLabel(item.authorId, item.authorLogin)}
                  </span>
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
              repositories={
                requestedRepository
                  ? [requestedRepository]
                  : pageAuth.session.repositoryId
                    ? await loadBoundLoginRepository(
                        app,
                        pageAuth.session.repositoryId,
                      )
                    : []
              }
            />
          )}
        </section>
      </ReviewShell>
    );
  }
}

export function ReviewAuthWall({
  demoMode,
  directory,
  pageAuth,
  requestedRepository,
  sessionMismatch,
}: {
  demoMode: boolean;
  directory: readonly ActiveMaintainerRepositoryV1[] | null;
  pageAuth: boolean;
  requestedRepository: ActiveMaintainerRepositoryV1 | "invalid" | undefined;
  sessionMismatch: boolean;
}) {
  const identified =
    !demoMode && requestedRepository === undefined && directory !== null;
  const identifiedRepositories = directory ?? [];
  return (
    <section className="notice-card review-empty">
      <p className="eyebrow">Protected review</p>
      <h2>
        {sessionMismatch
          ? "This session cannot review this repository."
          : identified
            ? identifiedRepositories.length === 0
              ? "No repositories available."
              : "Choose a repository to review."
            : "Maintainer authorization required."}
      </h2>
      {demoMode ? (
        <p>
          Evidence and review decisions are repository-bound. This local
          environment exposes a demo maintainer session for offline use.
        </p>
      ) : requestedRepository && requestedRepository !== "invalid" ? (
        <p>
          Evidence and review decisions stay bound to{" "}
          {requestedRepository.owner}/{requestedRepository.name}. Authorize with
          GitHub for this repository.
        </p>
      ) : identified && identifiedRepositories.length === 0 ? (
        <p>
          This GitHub account is not a live maintainer on an active SlopProof
          installation.
        </p>
      ) : identified ? (
        <p>
          Evidence and review decisions are repository-bound. Choose a
          repository this GitHub account can review.
        </p>
      ) : (
        <p>
          Evidence and review decisions are repository-bound. Authorize with
          GitHub to open the protected maintainer queue.
        </p>
      )}
      {demoMode ? (
        <DemoMaintainerLogin />
      ) : (
        <GithubMaintainerLogin
          identify={
            requestedRepository === undefined &&
            (directory === null || directory.length === 0) &&
            !pageAuth
          }
          repositories={
            requestedRepository === "invalid"
              ? []
              : requestedRepository
                ? [requestedRepository]
                : (directory ?? [])
          }
        />
      )}
    </section>
  );
}

async function loadRequestedReviewRepository(
  app: Awaited<ReturnType<typeof getWebRuntime>>,
  searchParams: { repositoryId?: string | string[] },
): Promise<ActiveMaintainerRepositoryV1 | "invalid" | undefined> {
  const raw = searchParams.repositoryId;
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || !z.uuid().safeParse(raw).success) return "invalid";
  try {
    return await loadActiveMaintainerRepository(app.database.pool, raw);
  } catch {
    return "invalid";
  }
}

async function loadPageMaintainerDirectory(
  app: Awaited<ReturnType<typeof getWebRuntime>>,
): Promise<readonly ActiveMaintainerRepositoryV1[] | null> {
  const cookieStore = await cookies();
  return loadSealedMaintainerDirectory(
    app,
    cookieStore.get(MAINTAINER_DIRECTORY_COOKIE)?.value,
  );
}

async function loadBoundLoginRepository(
  app: Awaited<ReturnType<typeof getWebRuntime>>,
  repositoryId: string,
): Promise<readonly ActiveMaintainerRepositoryV1[]> {
  try {
    return [
      await loadActiveMaintainerRepository(app.database.pool, repositoryId),
    ];
  } catch {
    return [];
  }
}

export function GithubMaintainerLogin({
  identify = false,
  repositories,
}: {
  identify?: boolean;
  repositories: readonly ActiveMaintainerRepositoryV1[];
}) {
  if (identify) {
    return (
      <a className="button primary review-login" href={reviewIdentifyHref()}>
        Authorize with GitHub
      </a>
    );
  }
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
    <nav
      className="review-login review-repo-choice"
      aria-label="Choose repository"
    >
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

function reviewIdentifyHref(): string {
  return `/api/auth/github/start?returnTo=${encodeURIComponent("/review")}`;
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

function authorQueueLabel(
  authorId: string,
  authorLogin: string | null,
): string {
  const label = formatAuthorLabel({ authorId, authorLogin });
  return isGithubHandle(label) ? `@${label}` : label;
}

function formatAge(value: Date): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - value.getTime()) / 60_000),
  );
  if (minutes < 60) return `${String(minutes)} min waiting`;
  return `${String(Math.round(minutes / 60))} h waiting`;
}
