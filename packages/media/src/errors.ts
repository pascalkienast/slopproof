export type RecordingProtocolErrorCode =
  | "invalid_schema"
  | "invalid_key"
  | "invalid_nonce"
  | "invalid_record"
  | "authentication_failed"
  | "invalid_manifest"
  | "limit_exceeded"
  | "multipart_mismatch";

export class RecordingProtocolError extends Error {
  constructor(
    public readonly code: RecordingProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecordingProtocolError";
  }
}
