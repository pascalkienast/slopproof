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
 */
export type ProviderFailureTelemetry = Readonly<{
  lastFailureKind: ProviderFailureKind;
  httpStatusClass: ProviderHttpStatusClass | null;
  transportAttemptCount: number;
}>;

type ProviderErrorOptions = ErrorOptions & {
  telemetry?: ProviderFailureTelemetry;
};

export class ProviderError extends Error {
  readonly telemetry: ProviderFailureTelemetry | undefined;

  constructor(
    readonly code: ProviderErrorCode,
    readonly disposition: ProviderErrorDisposition,
    message: string,
    options?: ProviderErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.telemetry = options?.telemetry;
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
 * the provider that produced them.
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
