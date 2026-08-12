import type { AnalysisSnapshot } from "@slopproof/analysis";
import { createPracticeSet } from "@slopproof/questions";
import { notFound } from "next/navigation";
import { getWebRuntime } from "../../../../../lib/runtime";

export const dynamic = "force-dynamic";

type PracticeView = {
  head_sha: string;
  snapshot: AnalysisSnapshot;
};

export default async function PracticePage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const number = Number.parseInt((await params).number, 10);
  if (!Number.isSafeInteger(number)) notFound();
  const app = await getWebRuntime();
  const result = await app.database.pool.query<PracticeView>(
    `SELECT revision.head_sha, analysis.snapshot
     FROM pull_requests pull_request
     JOIN repositories repository ON repository.id = pull_request.repository_id
     JOIN pull_request_revisions revision
       ON revision.pull_request_id = pull_request.id AND revision.is_current = true
     JOIN analysis_snapshots analysis ON analysis.revision_id = revision.id
     WHERE repository.owner = 'acme' AND repository.name = 'cachekit'
       AND pull_request.number = $1
     ORDER BY analysis.created_at DESC LIMIT 1`,
    [number],
  );
  const view = result.rows[0];
  if (!view) notFound();
  const practice = createPracticeSet(
    {
      analysis: view.snapshot,
      practiceSeed: `practice-session-${String(number)}-${"p".repeat(32)}`,
      maximumItems: 3,
    },
    { clock: { now: () => new Date() } },
  );

  return (
    <main className="shell flow-shell">
      <a className="back-link" href={`/demo/pr/${String(number)}`}>
        ← PR #{number}
      </a>
      <p className="eyebrow">Private practice · never required</p>
      <h1 className="flow-title">Practice your understanding.</h1>
      <div className="practice-layout">
        <section className="choice-card">
          <h2>Patch map</h2>
          <p>{view.snapshot.summary}</p>
          <ul className="plain-list">
            {view.snapshot.changedAreas.map((area) => (
              <li key={area.area}>
                <strong>{area.area}</strong>
                <span>{area.files.join(", ")}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="choice-card practice-card">
          <h2>Risk signals</h2>
          <ul className="plain-list">
            {view.snapshot.risks.map((risk) => (
              <li key={`${risk.anchorId}:${risk.kind}`}>
                <strong>{risk.kind.replaceAll("_", " ")}</strong>
                <span>{risk.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="question-list">
        <p className="eyebrow">Practice prompts · separate question pool</p>
        {practice.questions.map((question) => (
          <article key={question.id}>
            <span>{question.order}</span>
            <p>{question.prompt}</p>
          </article>
        ))}
      </section>
      <div className="actions compact-actions">
        <a className="button primary" href={`/demo/pr/${String(number)}`}>
          Return and prove
        </a>
      </div>
    </main>
  );
}
