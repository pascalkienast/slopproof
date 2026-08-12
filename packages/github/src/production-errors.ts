export type GithubControlErrorCode =
  | "INVALID_INPUT"
  | "INVALID_KEY_FILE"
  | "INVALID_RESPONSE"
  | "LIMIT_EXCEEDED"
  | "STALE_HEAD"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "REJECTED"
  | "AMBIGUOUS_WRITE";

/**
 * Safe operational error. It deliberately carries no request, response body,
 * token, key material, repository content, or upstream error message.
 */
export class GithubControlError extends Error {
  readonly code: GithubControlErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: GithubControlErrorCode,
    options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(`GitHub control failed (${code}).`);
    this.name = "GithubControlError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}
