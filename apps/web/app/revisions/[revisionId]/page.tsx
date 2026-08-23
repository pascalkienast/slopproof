import { notFound } from "next/navigation";
import { z } from "zod";
import { getWebRuntime } from "../../../lib/runtime";
import { publicCheckCtas } from "./public-check-ctas";

export const dynamic = "force-dynamic";

type PublicRevision = {
  repository_id: string;
  owner: string;
  name: string;
  pull_request_number: number;
  head_sha: string;
  is_current: boolean;
  status: "queued" | "in_progress" | "completed";
  conclusion: "action_required" | "success" | "neutral" | "cancelled" | null;
  public_summary: string;
  has_attempt: boolean;
  has_preparation_budget: boolean;
};

export default async function PublicRevisionPage({
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
  const result = await app.database.pool.query<PublicRevision>(
    `SELECT repository.id AS repository_id, repository.owner, repository.name,
            pull_request.number AS pull_request_number,
            revision.head_sha, revision.is_current,
            check_run.status, check_run.conclusion, check_run.public_summary,
            EXISTS (
              SELECT 1 FROM attempts attempt
              WHERE attempt.revision_id = revision.id
            ) AS has_attempt,
            EXISTS (
              SELECT 1 FROM semantic_generation_budgets budget
              WHERE budget.revision_id = revision.id
                AND budget.head_sha = revision.head_sha
            ) AS has_preparation_budget
     FROM pull_request_revisions revision
     JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
     JOIN repositories repository ON repository.id = pull_request.repository_id
     JOIN check_runs check_run ON check_run.revision_id = revision.id
     WHERE revision.id = $1
     LIMIT 1`,
    [revisionId.data],
  );
  const revision = result.rows[0];
  if (!revision) notFound();
  const ctas = publicCheckCtas({
    isCurrent: revision.is_current,
    conclusion: revision.conclusion,
    hasAttempt: revision.has_attempt,
    preparationAvailable:
      revision.has_preparation_budget || revision.has_attempt,
  });

  return (
    <main className="shell flow-shell public-check-shell">
      <a className="back-link" href="/">
        ← SlopProof
      </a>
      <p className="eyebrow">
        {revision.owner}/{revision.name} · PR #{revision.pull_request_number}
      </p>
      <h1 className="flow-title">Understanding check</h1>
      <div className="public-check-card">
        <div className="check-header">
          <span className="status-pill">
            {revision.conclusion ?? revision.status.replaceAll("_", " ")}
          </span>
          <span>
            {revision.is_current ? "Current revision" : "Historical revision"}
          </span>
        </div>
        <div className="sha-row">
          <span>Head SHA</span>
          <code>{revision.head_sha}</code>
        </div>
        <p>{revision.public_summary}</p>
        <div className="public-check-actions">
          {ctas.showContributor ? (
            <a
              className="button primary"
              href={`/revisions/${revisionId.data}/contribute`}
            >
              Continue as contributor
            </a>
          ) : null}
          {ctas.showMaintainer ? (
            <a
              className="button maintainer-button"
              href={`/review?repositoryId=${encodeURIComponent(revision.repository_id)}`}
            >
              Protected maintainer view
            </a>
          ) : null}
        </div>
        {ctas.showContributor ? (
          <p className="public-check-guidance">
            After GitHub authorization, contributors choose between optional
            practice and the required live proof.
          </p>
        ) : null}
      </div>
      <section className="notice-card">
        This public check view contains status, SHA and a protected review link.
        It never contains video, transcript, frames, model payloads or reviewer
        notes.
      </section>
    </main>
  );
}
