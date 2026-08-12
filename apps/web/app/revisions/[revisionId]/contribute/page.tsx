import { notFound } from "next/navigation";
import { z } from "zod";
import { RetryAttempt } from "../../../retry-attempt";
import { ProofHandoff } from "../../../demo/pr/[number]/proof-handoff";
import { getWebRuntime } from "../../../../lib/runtime";

export const dynamic = "force-dynamic";

type ContributorView = {
  owner: string;
  name: string;
  pull_request_number: number;
  head_sha: string;
  is_current: boolean;
  attempt_id: string;
  status: string;
  question_budget: number;
  risk_explanation: {
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
  const result = await app.database.pool.query<ContributorView>(
    `SELECT repository.owner, repository.name,
            pull_request.number AS pull_request_number,
            revision.head_sha, revision.is_current,
            attempt.id AS attempt_id, attempt.status,
            proof_plan.question_budget, proof_plan.risk_explanation
     FROM pull_request_revisions revision
     JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
     JOIN repositories repository ON repository.id = pull_request.repository_id
     JOIN LATERAL (
       SELECT candidate.* FROM attempts candidate
       WHERE candidate.revision_id = revision.id
       ORDER BY candidate.created_at DESC, candidate.id DESC
       LIMIT 1
     ) attempt ON true
     JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
     WHERE revision.id = $1
     LIMIT 1`,
    [revisionId.data],
  );
  const view = result.rows[0];
  if (!view) notFound();

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
            {view.risk_explanation.title ?? "Contributor proof"}
          </h1>
        </div>
        <span className="status-pill">{view.status.replaceAll("_", " ")}</span>
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
            {view.status === "ready" ? (
              <ProofHandoff attemptId={view.attempt_id} />
            ) : null}
            {RETRYABLE_STATUSES.has(view.status) ? (
              <RetryAttempt
                attemptId={view.attempt_id}
                headSha={view.head_sha}
              />
            ) : null}
            {["active", "uploading", "processing", "review_required"].includes(
              view.status,
            ) ? (
              <p>The proof is already in progress or awaiting review.</p>
            ) : null}
            {view.status === "passed" ? (
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
