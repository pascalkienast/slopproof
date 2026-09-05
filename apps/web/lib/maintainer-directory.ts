import {
  GITHUB_USER_SEAL_TTL_MS,
  sealGithubMaintainerDirectory,
  unsealGithubMaintainerDirectory,
  type GithubOAuthUser,
} from "@understandproof/auth";
import {
  GithubControlError,
  OctokitUserAuthorizationPort,
  type GithubUserAuthorizationPort,
} from "@understandproof/github";
import {
  listActiveMaintainerInstallationIds,
  listActiveMaintainerRepositories,
  loadMaintainerRepositoriesByIds,
  type ActiveMaintainerRepositoryV1,
} from "./github-oauth-production";
import { isMaintainerPermission } from "./maintainer-authorization";
import type { WebRuntime } from "./runtime";

export const MAINTAINER_DIRECTORY_COOKIE =
  "__Host-slopproof_maintainer_directory";

export type MaintainerDirectoryCookie = Readonly<{
  sealedCookie: string;
  expiresAt: Date;
  maxAgeSeconds: number;
}>;

export class MaintainerDirectoryError extends Error {
  readonly code = "MAINTAINER_DIRECTORY_UNAVAILABLE" as const;

  constructor() {
    super("Maintainer directory is unavailable.");
    this.name = "MaintainerDirectoryError";
  }
}

/**
 * Exact repository permission helper retained for narrow authorization
 * callers and tests. Identify uses GitHub's paginated user-installation
 * repository endpoint instead. The access token stays method-local.
 */
export async function filterMaintainerDirectory(
  input: Readonly<{
    user: GithubOAuthUser;
    accessToken: string;
    repositories: readonly ActiveMaintainerRepositoryV1[];
    authorizationPort: GithubUserAuthorizationPort;
  }>,
): Promise<readonly ActiveMaintainerRepositoryV1[]> {
  if (
    input.accessToken.length < 16 ||
    input.accessToken.length > 1_024 ||
    /[\0\r\n]/u.test(input.accessToken)
  ) {
    throw new MaintainerDirectoryError();
  }

  const allowed: ActiveMaintainerRepositoryV1[] = [];
  for (const repository of input.repositories) {
    let permission: Awaited<
      ReturnType<GithubUserAuthorizationPort["getCollaboratorPermission"]>
    >;
    try {
      permission = await input.authorizationPort.getCollaboratorPermission({
        userToken: input.accessToken,
        owner: repository.owner,
        repositoryName: repository.name,
        username: input.user.login,
      });
    } catch (error) {
      if (isAbsentCollaborator(error)) continue;
      throw new MaintainerDirectoryError();
    }
    if (isMaintainerPermission(permission.permission, permission.roleName)) {
      allowed.push(repository);
    }
  }
  return Object.freeze(allowed);
}

export async function resolveProductionIdentifyDirectory(
  app: WebRuntime,
  input: Readonly<{
    user: GithubOAuthUser;
    accessToken: string;
    now: Date;
  }>,
  dependencies: Readonly<{
    authorizationPort?: GithubUserAuthorizationPort;
    entropy?: (bytes: number) => Buffer;
  }> = {},
): Promise<MaintainerDirectoryCookie | null> {
  try {
    if (
      app.config.DEPLOYMENT_PROFILE !== "production" ||
      app.config.GITHUB_ADAPTER !== "octokit" ||
      app.config.DEMO_MODE
    ) {
      return null;
    }
    const authorizationPort =
      dependencies.authorizationPort ?? new OctokitUserAuthorizationPort();
    const githubInstallationIds =
      await authorizationPort.listAccessibleAppInstallations({
        userToken: input.accessToken,
      });
    const activeInstallationIds = await listActiveMaintainerInstallationIds(
      app.database.pool,
      githubInstallationIds,
    );
    const writableRepositoryIds =
      activeInstallationIds.length === 0
        ? []
        : await authorizationPort.listWritableAppRepositories({
            userToken: input.accessToken,
            githubInstallationIds: [...activeInstallationIds],
          });
    const allowed = await listActiveMaintainerRepositories(
      app.database.pool,
      activeInstallationIds,
      writableRepositoryIds,
    );
    const expiresAt = new Date(input.now.getTime() + GITHUB_USER_SEAL_TTL_MS);
    return Object.freeze({
      sealedCookie: sealGithubMaintainerDirectory(
        {
          githubUserId: input.user.githubUserId,
          repositoryIds: allowed.map((repository) => repository.id),
          issuedAt: input.now,
          expiresAt,
        },
        app.config.SESSION_SECRET,
        dependencies,
      ),
      expiresAt,
      maxAgeSeconds: Math.floor(GITHUB_USER_SEAL_TTL_MS / 1_000),
    });
  } catch {
    return null;
  }
}

export async function loadSealedMaintainerDirectory(
  app: WebRuntime,
  sealed: string | undefined,
  now = new Date(),
): Promise<readonly ActiveMaintainerRepositoryV1[] | null> {
  if (!sealed) return null;
  try {
    const directory = unsealGithubMaintainerDirectory(
      sealed,
      app.config.SESSION_SECRET,
      now,
    );
    return await loadMaintainerRepositoriesByIds(
      app.database.pool,
      directory.repositoryIds,
    );
  } catch {
    return null;
  }
}

function isAbsentCollaborator(error: unknown): boolean {
  return (
    error instanceof GithubControlError &&
    error.code === "REJECTED" &&
    (error.status === 403 || error.status === 404)
  );
}
