import type { AuthenticatedSession } from "@slopproof/auth";
import type { WebRuntime } from "./runtime";

export type SqlExecutor = Pick<WebRuntime["database"]["pool"], "query">;

export type MaintainerAuthorization = {
  actorId: string;
  sessionId: string;
  repositoryId: string;
  owner: string;
  name: string;
  githubRepositoryId: string;
  githubInstallationId: string;
  source: "local-demo";
};

export class MaintainerAuthorizationError extends Error {
  readonly code = "MAINTAINER_AUTHORIZATION_REQUIRED" as const;
}

/**
 * This is deliberately fresh and uncached. The offline MVP has only the local
 * fake GitHub authority. A live Octokit adapter must replace this branch with a
 * current installation/repository permission lookup; it must never trust the
 * persisted session role alone.
 */
export async function requireFreshMaintainerAuthorization(
  app: WebRuntime,
  session: AuthenticatedSession,
  executor: SqlExecutor = app.database.pool,
): Promise<MaintainerAuthorization> {
  if (
    session.actorRole !== "maintainer" ||
    session.repositoryId === null ||
    app.config.GITHUB_ADAPTER !== "fake" ||
    !app.config.DEMO_MODE ||
    session.actorId !== "demo-maintainer"
  ) {
    throw new MaintainerAuthorizationError();
  }

  const result = await executor.query<{
    repository_id: string;
    owner: string;
    name: string;
    github_repository_id: string;
    github_installation_id: string;
    installation_status: string;
  }>(
    `SELECT repository.id AS repository_id, repository.owner, repository.name,
            repository.github_repository_id,
            installation.github_installation_id,
            installation.status AS installation_status
     FROM repositories repository
     JOIN installations installation ON installation.id = repository.installation_id
     WHERE repository.id = $1`,
    [session.repositoryId],
  );
  const repository = result.rows[0];
  if (!repository || repository.installation_status !== "active") {
    throw new MaintainerAuthorizationError();
  }

  return {
    actorId: session.actorId,
    sessionId: session.id,
    repositoryId: repository.repository_id,
    owner: repository.owner,
    name: repository.name,
    githubRepositoryId: repository.github_repository_id,
    githubInstallationId: repository.github_installation_id,
    source: "local-demo",
  };
}
