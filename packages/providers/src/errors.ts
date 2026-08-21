export const PROVIDER_ERROR_CODES = [
  "INVALID_INPUT",
  "INVALID_OUTPUT",
  "UNKNOWN_QUESTION_ID",
  "RUBRIC_MISMATCH",
  "PATCH_ANCHOR_MISMATCH",
  "DEADLINE_EXCEEDED",
  "PROVIDER_UNAVAILABLE",
  "INVALID_CIPHER_KEY",
  "INVALID_CIPHER_PAYLOAD",
  "NONCE_REUSE",
  "PAYLOAD_DECRYPTION_FAILED",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];
export type ProviderErrorDisposition = "retryable" | "terminal" | "review";

export const PROVIDER_FAILURE_KINDS = [
  "deadline_exceeded",
  "invalid_output",
  "network",
  "rate_limited",
  "request_rejected",
  "timeout",
  "upstream_unavailable",
] as const;

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];
export type ProviderHttpStatusClass = "4xx" | "5xx";

/**
 * Content-free diagnostics that may cross the provider boundary safely.
 * Never add messages, URLs, request/response bodies, headers, or identifiers.
 * `httpStatus` is the numeric status only; do not persist reason phrases.
 */
export type ProviderFailureTelemetry = Readonly<{
  lastFailureKind: ProviderFailureKind;
  httpStatusClass: ProviderHttpStatusClass | null;
  transportAttemptCount: number;
  httpStatus?: number;
}>;

const TRANSIENT_UPSTREAM_CLIENT_STATUSES = new Set([402, 404, 408]);

export function httpStatusClassFor(
  status: number,
): ProviderHttpStatusClass | null {
  if (status >= 500 && status <= 599) return "5xx";
  if (status >= 400 && status <= 499) return "4xx";
  return null;
}

export function safeHttpStatus(
  status: number | null | undefined,
): number | undefined {
  return typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

/**
 * Statuses that retry on the same provider, then hop. 429 stays on the
 * rate-limit path. 401/403 and other client errors stay terminal.
 */
export function isTransientUpstreamHttpStatus(status: number): boolean {
  return (
    TRANSIENT_UPSTREAM_CLIENT_STATUSES.has(status) ||
    (status >= 500 && status <= 599)
  );
}

export const JUDGE_HOP_USED = [
  "primary",
  "transport_fallback",
  "none",
] as const;

export type JudgeHopUsed = (typeof JUDGE_HOP_USED)[number];

type ProviderErrorOptions = ErrorOptions & {
  telemetry?: ProviderFailureTelemetry;
  hopUsed?: JudgeHopUsed;
};

export class ProviderError extends Error {
  readonly telemetry: ProviderFailureTelemetry | undefined;
  readonly hopUsed: JudgeHopUsed | undefined;

  constructor(
    readonly code: ProviderErrorCode,
    readonly disposition: ProviderErrorDisposition,
    message: string,
    options?: ProviderErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.telemetry = options?.telemetry;
    this.hopUsed = options?.hopUsed;
  }
}

const TRANSPORT_FAILURE_KINDS = new Set<ProviderFailureKind>([
  "deadline_exceeded",
  "network",
  "rate_limited",
  "timeout",
  "upstream_unavailable",
]);

/**
 * Cross-provider hops are allowed only after a transport failure. Schema
 * rejects, invalid model output, and terminal 4xx request rejections stay on
 * the provider that produced them. Transient upstream 4xx (402/404/408) is a
 * transport failure after the same-provider retry budget is exhausted.
 */
export function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (
    error.code === "INVALID_OUTPUT" ||
    error.code === "INVALID_INPUT" ||
    error.disposition === "terminal" ||
    error.disposition === "review"
  ) {
    return false;
  }
  const kind = error.telemetry?.lastFailureKind;
  if (kind !== undefined && !TRANSPORT_FAILURE_KINDS.has(kind)) return false;
  return (
    error.code === "DEADLINE_EXCEEDED" || error.code === "PROVIDER_UNAVAILABLE"
  );
}
