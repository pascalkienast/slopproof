import type { AuthenticatedSession } from "@understandproof/auth";
import {
  OctokitUserAuthorizationPort,
  type GithubUserAuthorizationPort,
} from "@understandproof/github";
import { z } from "zod";
import { requireFreshGithubUserToken } from "./github-oauth-token";
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
  githubLogin: string;
  permission: "admin" | "write";
  roleName: string;
  source: "local-demo" | "github-live";
};

export type MaintainerAuthorizationBinding =
  | Readonly<{ kind: "repository"; repositoryId: string }>
  | Readonly<{ kind: "attempt"; attemptId: string }>;

export type RequestMaintainerAuthorizationInput = Readonly<{
  request: Request;
  session: AuthenticatedSession;
  binding: MaintainerAuthorizationBinding;
  executor?: SqlExecutor;
}>;

export type MaintainerAuthorizationDependencies = Readonly<{
  authorizationPort?: GithubUserAuthorizationPort;
  now?: Date;
}>;

const MaintainerBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository"), repositoryId: z.uuid() }).strict(),
  z.object({ kind: z.literal("attempt"), attemptId: z.uuid() }).strict(),
]);

const RepositoryAuthorizationRowSchema = z
  .object({
    repository_id: z.uuid(),
    owner: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/u),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/u),
    github_repository_id: z.string().regex(/^[1-9][0-9]{0,15}$/u),
    github_installation_id: z.string().regex(/^[1-9][0-9]{0,31}$/u),
  })
  .strict();

export class MaintainerAuthorizationError extends Error {
  readonly code = "MAINTAINER_AUTHORIZATION_REQUIRED" as const;

  constructor() {
    super("Maintainer authorization is required.");
    this.name = "MaintainerAuthorizationError";
  }
}

/**
 * Request-bound production authorization. Every call unseals the short-lived
 * GitHub user-token cookie for the already authenticated server session, then
 * performs fresh GitHub identity and collaborator-permission reads. Tokens are
 * method-local and never returned, logged, cached, or sent to persistence.
 */
export async function requireRequestMaintainerAuthorization(
  app: WebRuntime,
  input: RequestMaintainerAuthorizationInput,
  dependencies: MaintainerAuthorizationDependencies = {},
): Promise<MaintainerAuthorization> {
  try {
    validateMaintainerSession(input.session);
    const binding = MaintainerBindingSchema.parse(input.binding);
    const executor = input.executor ?? app.database.pool;
    const repository = await loadBoundRepository(
      executor,
      input.session.repositoryId!,
      binding,
    );

    if (
      app.config.GITHUB_ADAPTER === "fake" &&
      app.config.DEMO_MODE &&
      app.config.DEPLOYMENT_PROFILE === "local"
    ) {
      if (input.session.actorId !== "demo-maintainer") {
        throw new MaintainerAuthorizationError();
      }
      return localAuthorization(input.session, repository);
    }

    if (
      app.config.GITHUB_ADAPTER !== "octokit" ||
      app.config.DEMO_MODE ||
      app.config.DEPLOYMENT_PROFILE !== "production"
    ) {
      throw new MaintainerAuthorizationError();
    }

    const fresh = requireFreshGithubUserToken(input.request, {
      session: input.session,
      githubRepositoryId: repository.github_repository_id,
      purpose: "maintainer_reauth",
      sessionSecret: app.config.SESSION_SECRET,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    const authorizationPort =
      dependencies.authorizationPort ?? new OctokitUserAuthorizationPort();
    const identity = await authorizationPort.getAuthenticatedUser({
      userToken: fresh.accessToken,
    });
    if (identity.id !== input.session.actorId) {
      throw new MaintainerAuthorizationError();
    }
    const permission = await authorizationPort.getCollaboratorPermission({
      userToken: fresh.accessToken,
      owner: repository.owner,
      repositoryName: repository.name,
      username: identity.login,
    });
    if (!isMaintainerPermission(permission.permission, permission.roleName)) {
      throw new MaintainerAuthorizationError();
    }

    return Object.freeze({
      actorId: identity.id,
      sessionId: input.session.id,
      repositoryId: repository.repository_id,
      owner: repository.owner,
      name: repository.name,
      githubRepositoryId: repository.github_repository_id,
      githubInstallationId: repository.github_installation_id,
      githubLogin: identity.login,
      permission: permission.permission,
      roleName: permission.roleName,
      source: "github-live",
    });
  } catch {
    throw new MaintainerAuthorizationError();
  }
}

/**
 * Compatibility seam for the offline MVP. Production callers must use
 * `requireRequestMaintainerAuthorization` so request cookies and an exact
 * repository/attempt resource binding are mandatory.
 */
export async function requireFreshMaintainerAuthorization(
  app: WebRuntime,
  session: AuthenticatedSession,
  executor: SqlExecutor = app.database.pool,
): Promise<MaintainerAuthorization> {
  try {
    validateMaintainerSession(session);
    if (
      app.config.GITHUB_ADAPTER !== "fake" ||
      !app.config.DEMO_MODE ||
      app.config.DEPLOYMENT_PROFILE !== "local" ||
      session.actorId !== "demo-maintainer"
    ) {
      throw new MaintainerAuthorizationError();
    }
    const repository = await loadBoundRepository(
      executor,
      session.repositoryId!,
      { kind: "repository", repositoryId: session.repositoryId! },
    );
    return localAuthorization(session, repository);
  } catch {
    throw new MaintainerAuthorizationError();
  }
}

async function loadBoundRepository(
  executor: SqlExecutor,
  sessionRepositoryId: string,
  binding: z.infer<typeof MaintainerBindingSchema>,
): Promise<z.infer<typeof RepositoryAuthorizationRowSchema>> {
  const result =
    binding.kind === "repository"
      ? await executor.query<{
          repository_id: string;
          owner: string;
          name: string;
          github_repository_id: string;
          github_installation_id: string;
        }>(
          `SELECT repository.id AS repository_id, repository.owner,
                  repository.name, repository.github_repository_id,
                  installation.github_installation_id
             FROM repositories repository
             JOIN installations installation
               ON installation.id = repository.installation_id
            WHERE repository.id = $1
              AND repository.id = $2
              AND repository.status = 'active'
              AND installation.status = 'active'
            LIMIT 1`,
          [binding.repositoryId, sessionRepositoryId],
        )
      : await executor.query<{
          repository_id: string;
          owner: string;
          name: string;
          github_repository_id: string;
          github_installation_id: string;
        }>(
          `SELECT repository.id AS repository_id, repository.owner,
                  repository.name, repository.github_repository_id,
                  installation.github_installation_id
             FROM attempts attempt
             JOIN repositories repository
               ON repository.id = attempt.repository_id
             JOIN installations installation
               ON installation.id = repository.installation_id
            WHERE attempt.id = $1
              AND repository.id = $2
              AND repository.status = 'active'
              AND installation.status = 'active'
            LIMIT 1`,
          [binding.attemptId, sessionRepositoryId],
        );
  const repository = RepositoryAuthorizationRowSchema.safeParse(result.rows[0]);
  if (!repository.success) throw new MaintainerAuthorizationError();
  return repository.data;
}

function validateMaintainerSession(session: AuthenticatedSession): void {
  if (
    session.actorRole !== "maintainer" ||
    session.repositoryId === null ||
    !z.uuid().safeParse(session.id).success ||
    !z.uuid().safeParse(session.repositoryId).success
  ) {
    throw new MaintainerAuthorizationError();
  }
}

function localAuthorization(
  session: AuthenticatedSession,
  repository: z.infer<typeof RepositoryAuthorizationRowSchema>,
): MaintainerAuthorization {
  return Object.freeze({
    actorId: session.actorId,
    sessionId: session.id,
    repositoryId: repository.repository_id,
    owner: repository.owner,
    name: repository.name,
    githubRepositoryId: repository.github_repository_id,
    githubInstallationId: repository.github_installation_id,
    githubLogin: "demo-maintainer",
    permission: "admin",
    roleName: "local-demo",
    source: "local-demo",
  });
}

export function isMaintainerPermission(
  permission: "admin" | "write" | "read" | "none",
  roleName: string,
): permission is "admin" | "write" {
  const normalizedRole = roleName.trim().toLowerCase();
  if (["triage", "read", "none"].includes(normalizedRole)) return false;
  return permission === "admin" || permission === "write";
}
