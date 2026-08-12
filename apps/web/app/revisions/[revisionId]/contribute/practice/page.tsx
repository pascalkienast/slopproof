import { notFound } from "next/navigation";
import { z } from "zod";
import { readPageSession } from "../../../../../lib/http-auth";
import { requirePracticeAuthorAccess } from "../../../../../lib/practice-authorization";
import { getWebRuntime } from "../../../../../lib/runtime";
import { PracticeClient } from "./practice-client";

export const dynamic = "force-dynamic";

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
  const session = await readPageSession(app);
  const authorSession = session?.actorRole === "author" ? session : null;

  if (!authorSession && !app.config.DEMO_MODE) {
    return <PracticeLogin revisionId={revisionId.data} />;
  }
  if (authorSession) {
    await requirePracticeAuthorAccess(
      authorSession,
      revisionId.data,
      app.database.pool,
    ).catch(() => notFound());
  } else {
    const currentDemoRevision = await app.database.pool.query(
      `SELECT 1
         FROM pull_request_revisions revision
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE revision.id = $1
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
        LIMIT 1`,
      [revisionId.data],
    );
    if ((currentDemoRevision.rowCount ?? 0) !== 1) notFound();
  }

  return (
    <main className="shell flow-shell practice-shell">
      <a
        className="back-link"
        href={`/revisions/${revisionId.data}/contribute`}
      >
        ← Contributor proof
      </a>
      <p className="eyebrow">Private practice · optional · short-lived</p>
      <h1 className="flow-title">Practice your understanding.</h1>
      <p className="lede">
        Learn the exact patch, try a separate practice prompt, and get a
        concrete hint. This space never reveals or changes the live proof.
      </p>
      <PracticeClient
        revisionId={revisionId.data}
        establishDemoSession={!authorSession && app.config.DEMO_MODE}
      />
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

function PracticeLogin({ revisionId }: { revisionId: string }) {
  const returnTo = `/revisions/${revisionId}/contribute/practice`;
  return (
    <main className="shell flow-shell">
      <p className="eyebrow">Contributor authorization</p>
      <h1 className="flow-title">Continue with GitHub.</h1>
      <p>
        Learning and practice material is private to the current pull-request
        author and remains separate from proof and review.
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
