import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const payloadEncryptionKey = z.string().refine(
  (value) => {
    try {
      const decoded = Buffer.from(value, "base64");
      return decoded.byteLength === 32 && decoded.toString("base64") === value;
    } catch {
      return false;
    }
  },
  { message: "must be canonical base64 encoding of exactly 32 bytes" },
);

const baseSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_BASE_URL: z.url(),
    DATABASE_URL: z.string().min(1),
    GITHUB_ADAPTER: z.enum(["fake", "octokit"]).default("fake"),
    EVIDENCE_STORAGE_PROVIDER: z.literal("s3"),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(8),
    KEY_WRAPPING_PROVIDER: z.enum(["local", "kms"]),
    TRANSCRIPTION_PROVIDER: z.enum(["fake", "external"]).default("fake"),
    MULTIMODAL_JUDGE_PROVIDER: z.enum(["fake", "external"]).default("fake"),
    PROVIDER_API_KEY: z.string().optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    DEMO_MODE: booleanFromEnv,
    DEMO_FAKE_MEDIA: booleanFromEnv,
  })
  .strip();

const webSchema = baseSchema
  .extend({
    SESSION_SECRET: z.string().min(32),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_PRIVATE_KEY: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(32),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    S3_CONTROL_ENDPOINT: z.url(),
    S3_PUBLIC_ENDPOINT: z.url(),
    KEY_WRAPPING_PUBLIC_KEY_PATH: z.string().min(1),
    WORKER_INTERNAL_URL: z.url(),
    WORKER_INTERNAL_SECRET: z.string().min(32),
  })
  .superRefine((value, context) => {
    if (
      (value.TRANSCRIPTION_PROVIDER === "external" ||
        value.MULTIMODAL_JUDGE_PROVIDER === "external") &&
      !value.PROVIDER_API_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_API_KEY"],
        message: "is required for an external provider",
      });
    }
  });

const workerSchema = baseSchema
  .extend({
    S3_CONTROL_ENDPOINT: z.url(),
    KEY_WRAPPING_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    KMS_PROVIDER: z.string().min(1).optional(),
    KMS_KEY_ID: z.string().min(1).optional(),
    WORKER_INTERNAL_SECRET: z.string().min(32),
    PROVIDER_PAYLOAD_KEY_BASE64: payloadEncryptionKey,
    WORKER_HOST: z.string().min(1).default("127.0.0.1"),
    WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
    FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
    FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  })
  .superRefine((value, context) => {
    if (
      value.KEY_WRAPPING_PROVIDER === "local" &&
      !value.KEY_WRAPPING_PRIVATE_KEY_PATH
    ) {
      context.addIssue({
        code: "custom",
        path: ["KEY_WRAPPING_PRIVATE_KEY_PATH"],
        message: "is required for local key wrapping",
      });
    }
    if (
      value.KEY_WRAPPING_PROVIDER === "kms" &&
      (!value.KMS_PROVIDER || !value.KMS_KEY_ID)
    ) {
      context.addIssue({
        code: "custom",
        path: ["KMS_PROVIDER"],
        message:
          "KMS_PROVIDER and KMS_KEY_ID are required for kms key wrapping",
      });
    }
    if (
      (value.TRANSCRIPTION_PROVIDER === "external" ||
        value.MULTIMODAL_JUDGE_PROVIDER === "external") &&
      !value.PROVIDER_API_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_API_KEY"],
        message: "is required for an external provider",
      });
    }
  });

export type WebConfig = z.output<typeof webSchema>;
export type WorkerConfig = z.output<typeof workerSchema>;

export class ConfigurationError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Invalid configuration: ${fields.join(", ")}`);
    this.name = "ConfigurationError";
    this.fields = fields;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

function parseConfig<T>(schema: z.ZodType<T>, environment: Environment): T {
  const result = schema.safeParse(environment);
  if (result.success) return result.data;

  const fields = [
    ...new Set(
      result.error.issues.map((issue) => issue.path.join(".") || "environment"),
    ),
  ].sort();
  throw new ConfigurationError(fields);
}

export function loadWebConfig(
  environment: Environment = process.env,
): WebConfig {
  return parseConfig(webSchema, environment);
}

export function loadWorkerConfig(
  environment: Environment = process.env,
): WorkerConfig {
  return parseConfig(workerSchema, environment);
}
