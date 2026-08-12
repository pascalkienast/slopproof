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

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly disposition: ProviderErrorDisposition,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}
