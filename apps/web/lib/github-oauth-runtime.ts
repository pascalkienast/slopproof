import type {
  GithubOAuthBinding,
  GithubOAuthService,
} from "@understandproof/auth";

export type GithubOAuthServiceContract = Pick<
  GithubOAuthService,
  | "callbackUrl"
  | "stateTtlMs"
  | "freshTokenTtlMs"
  | "start"
  | "callback"
  | "logout"
>;

export type GithubOAuthWebRuntime = Readonly<{
  appBaseUrl: string;
  oauth: GithubOAuthServiceContract;
  /**
   * DB-backed wiring must derive the active repository and purpose from the
   * local redirect/session context. It must never trust a client-supplied
   * numeric GitHub repository ID without resolving the active DB binding.
   */
  resolveStartBinding(
    input: Readonly<{
      request: Request;
      requestedRedirectPath?: string;
    }>,
  ): Promise<GithubOAuthBinding>;
}>;

export type GithubOAuthRuntimeResolver = (
  request: Request,
) => GithubOAuthWebRuntime | Promise<GithubOAuthWebRuntime>;

export class GithubOAuthWiringError extends Error {
  readonly code = "GITHUB_OAUTH_WIRING_ERROR" as const;

  constructor() {
    super("GitHub OAuth is unavailable.");
    this.name = "GithubOAuthWiringError";
  }
}

export class GithubOAuthStartPolicyError extends Error {
  readonly code = "GITHUB_OAUTH_START_POLICY_REJECTED" as const;

  constructor() {
    super("GitHub OAuth start was rejected.");
    this.name = "GithubOAuthStartPolicyError";
  }
}

export class GithubOAuthStartRateLimitError extends Error {
  readonly code = "GITHUB_OAUTH_START_RATE_LIMITED" as const;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("GitHub OAuth start was rate limited.");
    this.name = "GithubOAuthStartRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Resolves production OAuth directly from the request's existing WebRuntime. */
export async function resolveGithubOAuthRuntime(
  request: Request,
): Promise<GithubOAuthWebRuntime> {
  try {
    const [{ getWebRuntime }, { createGithubOAuthProductionRuntime }] =
      await Promise.all([
        import("./runtime"),
        import("./github-oauth-production"),
      ]);
    return validateGithubOAuthRuntime(
      await createGithubOAuthProductionRuntime(await getWebRuntime(), request),
    );
  } catch (error) {
    if (
      error instanceof GithubOAuthStartPolicyError ||
      error instanceof GithubOAuthStartRateLimitError
    ) {
      throw error;
    }
    throw new GithubOAuthWiringError();
  }
}

export function validateGithubOAuthRuntime(
  runtime: GithubOAuthWebRuntime,
): GithubOAuthWebRuntime {
  try {
    const base = new URL(runtime.appBaseUrl);
    const callback = new URL("/api/auth/github/callback", base);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      callback.toString() !== runtime.oauth.callbackUrl ||
      typeof runtime.resolveStartBinding !== "function"
    ) {
      throw new GithubOAuthWiringError();
    }
    return runtime;
  } catch {
    throw new GithubOAuthWiringError();
  }
}
