import {
  GithubUserTokenRejectedError,
  unsealGithubUserAccessToken,
  type AuthenticatedSession,
  type GithubOAuthPurpose,
  type UnsealedGithubUserAccessToken,
} from "@slopproof/auth";
import { requestCookieValue } from "./http-auth";

export const GITHUB_USER_TOKEN_COOKIE = "__Host-slopproof_github_user";

/**
 * Request-near authorization seam for review/evidence/decision routes.
 * The normal server session must already be authenticated. The returned token
 * must be used only for the immediate GitHub permission check and never logged,
 * persisted, serialized, or attached to an error.
 */
export function requireFreshGithubUserToken(
  request: Request,
  input: Readonly<{
    session: AuthenticatedSession;
    githubRepositoryId: string;
    purpose: GithubOAuthPurpose;
    sessionSecret: string;
    now?: Date;
  }>,
): UnsealedGithubUserAccessToken {
  if (!input.session.repositoryId) throw new GithubUserTokenRejectedError();
  const sealed = requestCookieValue(request, GITHUB_USER_TOKEN_COOKIE);
  if (!sealed) throw new GithubUserTokenRejectedError();
  return unsealGithubUserAccessToken(
    sealed,
    {
      sessionId: input.session.id,
      githubUserId: input.session.actorId,
      repositoryId: input.session.repositoryId,
      githubRepositoryId: input.githubRepositoryId,
      purpose: input.purpose,
    },
    input.sessionSecret,
    input.now,
  );
}
