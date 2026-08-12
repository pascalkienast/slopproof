import type { AuthenticatedSession } from "@slopproof/auth";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { WebRuntime } from "./runtime";

export class PracticeAuthorizationError extends Error {
  readonly code = "PRACTICE_AUTHORIZATION_REQUIRED" as const;

  constructor() {
    super("Current pull-request author authorization is required.");
    this.name = "PracticeAuthorizationError";
  }
}

export type PracticeAuthorAccess = Readonly<{
  revisionId: string;
  repositoryId: string;
  actorId: string;
  headSha: string;
}>;

type PracticeSqlExecutor = Pick<
  WebRuntime["database"]["pool"] | PoolClient,
  "query"
>;

const PracticeAuthorRowSchema = z
  .object({
    revision_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    author_id: z.string().min(1).max(255),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .strict();

/**
 * Rechecks the complete server-side binding immediately before a private
 * practice capability is minted. A session role or repository cookie alone is
 * never enough: the revision must still be current, its PR open, the exact
 * actor must still be the stored PR author, and repository plus installation
 * must both remain active.
 */
export async function requirePracticeAuthorAccess(
  session: AuthenticatedSession,
  revisionId: string,
  executor: PracticeSqlExecutor,
): Promise<PracticeAuthorAccess> {
  try {
    const parsedRevisionId = z.string().uuid().parse(revisionId);
    if (
      session.actorRole !== "author" ||
      session.repositoryId === null ||
      !z.string().uuid().safeParse(session.repositoryId).success ||
      session.actorId.length < 1 ||
      session.actorId.length > 255
    ) {
      throw new PracticeAuthorizationError();
    }
    const result = await executor.query<{
      revision_id: string;
      repository_id: string;
      author_id: string;
      head_sha: string;
    }>(
      `SELECT revision.id AS revision_id,
              repository.id AS repository_id,
              pull_request.author_id,
              revision.head_sha
         FROM pull_request_revisions revision
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE revision.id = $1
          AND repository.id = $2
          AND pull_request.author_id = $3
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
        LIMIT 1
        FOR SHARE OF revision, pull_request, repository, installation`,
      [parsedRevisionId, session.repositoryId, session.actorId],
    );
    const row = PracticeAuthorRowSchema.parse(result.rows[0]);
    if (
      row.revision_id !== parsedRevisionId ||
      row.repository_id !== session.repositoryId ||
      row.author_id !== session.actorId
    ) {
      throw new PracticeAuthorizationError();
    }
    return Object.freeze({
      revisionId: row.revision_id,
      repositoryId: row.repository_id,
      actorId: row.author_id,
      headSha: row.head_sha,
    });
  } catch {
    throw new PracticeAuthorizationError();
  }
}
