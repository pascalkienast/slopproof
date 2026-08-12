import pino, { type Logger, type LoggerOptions } from "pino";

const redactionPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "authorization",
  "cookie",
  "token",
  "handoffToken",
  "sessionToken",
  "githubToken",
  "privateKey",
  "publicKey",
  "wrappedKey",
  "wrappedDataKey",
  "manifestAuth",
  "manifestTag",
  "presignedUrl",
  "uploadUrl",
  "video",
  "frame",
  "transcript",
  "answer",
  "providerPayload",
  "config.S3_SECRET_ACCESS_KEY",
  "config.SESSION_SECRET",
  "config.GITHUB_PRIVATE_KEY",
  "config.GITHUB_WEBHOOK_SECRET",
  "config.GITHUB_CLIENT_SECRET",
  "config.PROVIDER_API_KEY",
  "config.PROVIDER_PAYLOAD_KEY_BASE64",
  "config.WORKER_INTERNAL_SECRET",
];

export type LogIdentity = {
  service: "web" | "worker" | "test";
  version?: string;
};

export function loggerOptions(
  identity: LogIdentity,
  level = "info",
): LoggerOptions {
  return {
    level,
    base: identity,
    redact: {
      paths: redactionPaths,
      censor: "[REDACTED]",
    },
    serializers: {
      err(error: unknown) {
        if (!(error instanceof Error)) return { class: "UnknownError" };
        const candidate = error as Error & { code?: unknown };
        return {
          class: error.name,
          ...(typeof candidate.code === "string"
            ? { code: candidate.code }
            : {}),
        };
      },
    },
    hooks: {
      logMethod(args, method) {
        const first = args[0];
        if (
          typeof first === "object" &&
          first !== null &&
          "err" in first &&
          first.err instanceof Error
        ) {
          const candidate = first.err as Error & { code?: unknown };
          const safeError = {
            class: candidate.name,
            ...(typeof candidate.code === "string"
              ? { code: candidate.code }
              : {}),
          };
          const safeFirst = { ...first, err: safeError };
          const message = typeof args[1] === "string" ? args[1] : undefined;
          method.call(this, safeFirst, message);
          return;
        }
        method.apply(this, args);
      },
    },
  };
}

export function createLogger(identity: LogIdentity, level = "info"): Logger {
  return pino(loggerOptions(identity, level));
}
