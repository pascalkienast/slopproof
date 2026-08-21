import pino, { type Logger, type LoggerOptions } from "pino";

export type { Logger };

const redactionPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "req.headers.x-hub-signature-256",
  "request.headers.x-hub-signature-256",
  "req.headers.x-slopproof-proxy-authenticator",
  "request.headers.x-slopproof-proxy-authenticator",
  "authorization",
  "cookie",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "clientSecret",
  "webhookSecret",
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
  "providerRequest",
  "providerResponse",
  "config.S3_SECRET_ACCESS_KEY",
  "config.SESSION_SECRET",
  "config.GITHUB_PRIVATE_KEY",
  "config.GITHUB_PRIVATE_KEY_PATH",
  "config.GITHUB_WEBHOOK_SECRET",
  "config.GITHUB_CLIENT_SECRET",
  "config.PROVIDER_API_KEY",
  "config.GENERATION_API_KEY",
  "config.JUDGE_API_KEY",
  "config.TRANSCRIPTION_API_KEY",
  "config.PROVIDER_PAYLOAD_KEY_BASE64",
  "config.WORKER_INTERNAL_SECRET",
  "config.OAUTH_TRUSTED_PROXY_SECRET",
];

const sensitiveLogKeys = new Set(
  [
    "authorization",
    "cookie",
    "token",
    "accessToken",
    "refreshToken",
    "apiKey",
    "clientSecret",
    "webhookSecret",
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
    "providerRequest",
    "providerResponse",
    "S3_SECRET_ACCESS_KEY",
    "SESSION_SECRET",
    "GITHUB_PRIVATE_KEY",
    "GITHUB_PRIVATE_KEY_PATH",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_CLIENT_SECRET",
    "PROVIDER_API_KEY",
    "GENERATION_API_KEY",
    "JUDGE_API_KEY",
    "TRANSCRIPTION_API_KEY",
    "PROVIDER_PAYLOAD_KEY_BASE64",
    "WORKER_INTERNAL_SECRET",
    "OAUTH_TRUSTED_PROXY_SECRET",
  ].map((key) => key.toLowerCase()),
);

function safeError(error: Error & { code?: unknown }): Record<string, string> {
  return {
    class: error.name,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
  };
}

function sanitizeLogValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value instanceof Error) return safeError(value);
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") return "[REDACTED]";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return "[REDACTED]";
  }
  if (depth >= 8 || seen.has(value)) return "[REDACTED]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((entry) => sanitizeLogValue(entry, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveLogKeys.has(key.toLowerCase())
        ? "[REDACTED]"
        : sanitizeLogValue(entry, seen, depth + 1),
    ]),
  );
}

export type LogIdentity = {
  service: "web" | "worker" | "github-control" | "test";
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
        return safeError(error as Error & { code?: unknown });
      },
    },
    hooks: {
      logMethod(args, method) {
        const sanitized = args.map((argument, index) =>
          index === args.length - 1 && typeof argument === "string"
            ? argument
            : sanitizeLogValue(argument),
        );
        method.apply(
          this,
          sanitized as [object | string, string?, ...unknown[]],
        );
      },
    },
  };
}

export function createLogger(identity: LogIdentity, level = "info"): Logger {
  return pino(
    loggerOptions(identity, level),
    pino.destination({ dest: 1, sync: true, minLength: 0 }),
  );
}
