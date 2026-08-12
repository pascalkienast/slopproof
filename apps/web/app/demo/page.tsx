import { getWebRuntime } from "../../lib/runtime";

export const dynamic = "force-dynamic";

type DemoPullRequest = {
  number: number;
  head_sha: string;
  status: string;
  question_budget: number;
  risk_level: string;
};

export default async function DemoPage() {
  const app = await getWebRuntime();
  const result = await app.database.pool.query<DemoPullRequest>(`
    SELECT pull_request.number, revision.head_sha, attempt.status,
           proof_plan.question_budget,
           proof_plan.risk_explanation->>'riskLevel' AS risk_level
    FROM repositories repository
    JOIN pull_requests pull_request ON pull_request.repository_id = repository.id
    JOIN pull_request_revisions revision
      ON revision.pull_request_id = pull_request.id AND revision.is_current = true
    JOIN proof_plans proof_plan ON proof_plan.revision_id = revision.id
    JOIN attempts attempt
      ON attempt.revision_id = revision.id AND attempt.proof_plan_id = proof_plan.id
    WHERE repository.owner = 'acme' AND repository.name = 'cachekit'
    ORDER BY pull_request.number
  `);

  return (
    <main className="shell flow-shell">
      <a className="back-link" href="/">
        ← SlopProof
      </a>
      <p className="eyebrow">Offline golden path · acme/cachekit</p>
      <h1 className="flow-title">Three patches. Three proof budgets.</h1>
      <p className="lede">
        These pull requests are generated locally. GitHub, transcription and the
        model are replaceable fake adapters; SHA binding, sessions, recording
        encryption and maintainer review stay real.
      </p>
      <div className="actions compact-actions">
        <a className="button primary" href="/review">
          Open maintainer review
        </a>
      </div>
      <div className="pr-grid">
        {result.rows.map((pullRequest) => (
          <a
            className="pr-card"
            href={`/demo/pr/${String(pullRequest.number)}`}
            key={pullRequest.number}
          >
            <span className="eyebrow">PR #{pullRequest.number}</span>
            <strong>{riskLabel(pullRequest.risk_level)}</strong>
            <span>
              {pullRequest.question_budget} live question
              {pullRequest.question_budget === 1 ? "" : "s"}
            </span>
            <code>{pullRequest.head_sha.slice(0, 10)}</code>
            <span className="status-pill">
              {pullRequest.status.replaceAll("_", " ")}
            </span>
          </a>
        ))}
      </div>
      {result.rows.length === 0 ? (
        <section className="notice-card">
          Run <code>pnpm db:migrate</code> and <code>pnpm db:seed</code> first.
        </section>
      ) : null}
    </main>
  );
}

function riskLabel(value: string): string {
  switch (value) {
    case "small":
      return "Small behavior fix";
    case "medium":
      return "Multi-component change";
    case "high_risk":
      return "Auth + migration risk";
    default:
      return "Bounded patch";
  }
}
