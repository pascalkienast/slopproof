import { notFound } from "next/navigation";
import { z } from "zod";
import { RetryAttempt } from "../../../retry-attempt";
import { ProofHandoff } from "../../../demo/pr/[number]/proof-handoff";
import { readPageSession } from "../../../../lib/http-auth";
import { getWebRuntime } from "../../../../lib/runtime";
import { contributorPreparationState } from "./contributor-preparation-state";

export const dynamic = "force-dynamic";

type ContributorView = {
  owner: string;
  name: string;
  pull_request_number: number;
  head_sha: string;
  is_current: boolean;
  attempt_id: string | null;
  status: string | null;
  question_budget: number | null;
  check_status: "queued" | "in_progress" | "completed";
  check_conclusion:
    "action_required" | "success" | "neutral" | "cancelled" | null;
  check_reason: string | null;
  public_summary: string;
  risk_explanation: null | {
    title?: string;
    riskLevel?: string;
    rationale?: string[];
  };
};

const RETRYABLE_STATUSES = new Set([
  "technical_retry",
  "retry_required",
  "expired",
]);

export default async function ContributorPage({
  params,
}: {
  params: Promise<{ revisionId: string }>;
}) {
  const revisionId = z
    .string()
    .uuid()
    .safeParse((await params).revisionId);
  if (!revisionId.success) notFound();
  const app = await getWebRuntime();
  const session = app.config.DEMO_MODE ? null : await readPageSession(app);
  if (
    !app.config.DEMO_MODE &&
    (!session || session.actorRole !== "author" || !session.repositoryId)
  ) {
    return <ContributorLogin revisionId={revisionId.data} practice={false} />;
  }
  const result = await app.database.pool.query<ContributorView>(
    `SELECT repository.owner, repository.name,
            pull_request.number AS pull_request_number,
            revision.head_sha, revision.is_current,
            attempt.id AS attempt_id, attempt.status,
            COALESCE(proof_plan.question_budget, semantic_budget.question_budget)
              AS question_budget,
            proof_plan.risk_explanation,
            check_run.status AS check_status,
            check_run.conclusion AS check_conclusion,
            check_run.intent_reason AS check_reason,
            check_run.public_summary
     FROM pull_request_revisions revision
     JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
     JOIN repositories repository ON repository.id = pull_request.repository_id
     JOIN check_runs check_run ON check_run.revision_id = revision.id
     LEFT JOIN LATERAL (
       SELECT candidate.* FROM attempts candidate
       WHERE candidate.revision_id = revision.id
       ORDER BY candidate.created_at DESC, candidate.id DESC
       LIMIT 1
     ) attempt ON true
     LEFT JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
     LEFT JOIN LATERAL (
       SELECT candidate.question_budget
         FROM semantic_generation_budgets candidate
        WHERE candidate.revision_id = revision.id
        ORDER BY candidate.created_at DESC, candidate.generation_context_id DESC
        LIMIT 1
     ) semantic_budget ON true
     WHERE revision.id = $1
       AND ($2::boolean OR (
         repository.id = $3::uuid
         AND pull_request.author_id = $4
       ))
     LIMIT 1`,
    [
      revisionId.data,
      app.config.DEMO_MODE,
      session?.repositoryId ?? "00000000-0000-0000-0000-000000000000",
      session?.actorId ?? "",
    ],
  );
  const view = result.rows[0];
  if (!view) notFound();
  const preparationState = contributorPreparationState({
    questionBudget: view.question_budget,
    checkStatus: view.check_status,
    checkConclusion: view.check_conclusion,
    checkReason: view.check_reason,
  });
  const attemptStatus = view.status ?? "preparing";

  return (
    <main className="shell flow-shell">
      <a className="back-link" href={`/revisions/${revisionId.data}`}>
        ← Understanding check
      </a>
      <div className="check-header">
        <div>
          <p className="eyebrow">
            {view.owner}/{view.name} · PR #{view.pull_request_number}
          </p>
          <h1 className="flow-title">
            {view.risk_explanation?.title ?? "Contributor proof"}
          </h1>
        </div>
        <span className="status-pill">
          {attemptStatus.replaceAll("_", " ")}
        </span>
      </div>
      <div className="sha-row">
        <span>Bound head SHA</span>
        <code>{view.head_sha}</code>
      </div>
      {!view.is_current ? (
        <section className="notice-card">
          This revision is historical. Open the check for the current head SHA
          before creating another proof.
        </section>
      ) : preparationState === "failed" ? (
        <section className="notice-card">
          <h2>Proof preparation failed.</h2>
          <p>{view.public_summary}</p>
          <p>
            This is a SlopProof system failure, not a contributor result. The
            required check stays closed until a maintainer retries a repaired
            pipeline.
          </p>
        </section>
      ) : preparationState === "preparing" ? (
        <section className="notice-card">
          <h2>Preparing patch-bound questions.</h2>
          <p>
            SlopProof is still analyzing this exact revision. Refresh this page
            after the GitHub check advances; no proof attempt has started.
          </p>
        </section>
      ) : (
        <div className="choice-grid">
          <section className="choice-card practice-card">
            <p className="eyebrow">Optional learning space</p>
            <h2>Practice your understanding.</h2>
            <p>
              Review a separate prompt set without revealing the immutable live
              proof questions.
            </p>
            <a
              className="button"
              href={`/revisions/${revisionId.data}/contribute/practice`}
            >
              Open practice
            </a>
          </section>
          <section className="choice-card proof-card">
            <p className="eyebrow">Current attempt</p>
            <h2>Prove you know what you ship.</h2>
            <p>
              {view.question_budget} focused live question
              {view.question_budget === 1 ? "" : "s"} are bound to this exact
              SHA.
            </p>
            {attemptStatus === "preparing" ? (
              <p>
                Patch-bound proof questions are being prepared. Practice is
                optional and can be opened independently while this completes.
              </p>
            ) : null}
            {attemptStatus === "ready" && view.attempt_id ? (
              <ProofHandoff
                attemptId={view.attempt_id}
                establishDemoSession={app.config.DEMO_MODE}
              />
            ) : null}
            {view.attempt_id && RETRYABLE_STATUSES.has(attemptStatus) ? (
              <RetryAttempt
                attemptId={view.attempt_id}
                headSha={view.head_sha}
                establishDemoSession={app.config.DEMO_MODE}
              />
            ) : null}
            {["active", "uploading", "processing", "review_required"].includes(
              attemptStatus,
            ) ? (
              <p>The proof is already in progress or awaiting review.</p>
            ) : null}
            {attemptStatus === "passed" ? (
              <p>This exact revision has already been approved.</p>
            ) : null}
          </section>
        </div>
      )}
      <section className="notice-card">
        Browser recording data is encrypted before upload. Technical failures
        create a fresh attempt; they never become a model decision.
      </section>
    </main>
  );
}

function ContributorLogin({
  revisionId,
  practice,
}: {
  revisionId: string;
  practice: boolean;
}) {
  const returnTo = `/revisions/${revisionId}/contribute${practice ? "/practice" : ""}`;
  return (
    <main className="shell flow-shell">
      <p className="eyebrow">Contributor authorization</p>
      <h1 className="flow-title">Continue with GitHub.</h1>
      <p>
        SlopProof verifies that your GitHub account is the author of this
        current pull request before showing private proof material.
      </p>
      <div className="actions compact-actions">
        <a
          className="button primary"
          href={`/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`}
        >
          Authorize with GitHub
        </a>
      </div>
    </main>
  );
}
