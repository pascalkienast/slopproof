import type { AnalysisSnapshot } from "@slopproof/analysis";
import { createPracticeSet } from "@slopproof/questions";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getWebRuntime } from "../../../../../lib/runtime";

export const dynamic = "force-dynamic";

type PracticeView = {
  head_sha: string;
  snapshot: AnalysisSnapshot;
};

export default async function PracticePage({
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
  const result = await app.database.pool.query<PracticeView>(
    `SELECT revision.head_sha, analysis.snapshot
     FROM pull_request_revisions revision
     JOIN analysis_snapshots analysis ON analysis.revision_id = revision.id
     WHERE revision.id = $1 AND revision.is_current = true
     ORDER BY analysis.created_at DESC LIMIT 1`,
    [revisionId.data],
  );
  const view = result.rows[0];
  if (!view) notFound();
  const practice = createPracticeSet(
    {
      analysis: view.snapshot,
      practiceSeed: `practice-revision-${revisionId.data}-${"p".repeat(32)}`,
      maximumItems: 3,
    },
    { clock: { now: () => new Date() } },
  );

  return (
    <main className="shell flow-shell">
      <a
        className="back-link"
        href={`/revisions/${revisionId.data}/contribute`}
      >
        ← Contributor proof
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
        <p className="eyebrow">Separate practice prompt pool</p>
        {practice.questions.map((question) => (
          <article key={question.id}>
            <span>{question.order}</span>
            <p>{question.prompt}</p>
          </article>
        ))}
      </section>
      <div className="actions compact-actions">
        <a
          className="button primary"
          href={`/revisions/${revisionId.data}/contribute`}
        >
          Return and prove
        </a>
      </div>
    </main>
  );
}
