import { z } from "zod";

export const DeploymentProfileSchema = z.enum(["local", "production"]);
export const GithubAdapterSchema = z.enum(["fake", "octokit"]);
export const GenerationProviderSchema = z.enum(["fake", "hetzner"]);
export const TranscriptionProviderSchema = z.enum(["fake", "openrouter"]);
export const MultimodalJudgeProviderSchema = z.enum(["fake", "hetzner"]);

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

const coreShape = {
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DEPLOYMENT_PROFILE: DeploymentProfileSchema,
  APP_BASE_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
} as const;

const demoShape = {
  DEMO_MODE: booleanFromEnv,
  DEMO_FAKE_MEDIA: booleanFromEnv,
} as const;

const storageControlShape = {
  EVIDENCE_STORAGE_PROVIDER: z.literal("s3"),
  S3_CONTROL_ENDPOINT: z.url(),
  S3_REGION: z.string().trim().min(1),
  S3_BUCKET: z.string().trim().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
} as const;

const githubSelectorShape = {
  GITHUB_ADAPTER: GithubAdapterSchema.default("fake"),
} as const;

const baseSchema = z
  .object({ ...coreShape, ...demoShape })
  .strip()
  .superRefine((value, context) => {
    refineProductionCore(value, context);
    refineOptimizedLocalCore(value, context);
  });

const webSchema = z
  .object({
    ...coreShape,
    ...demoShape,
    ...githubSelectorShape,
    ...storageControlShape,
    SESSION_SECRET: z.string().min(32),
    GITHUB_WEBHOOK_SECRET: z.string().min(32),
    GITHUB_CLIENT_ID: z.string().trim().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    S3_PUBLIC_ENDPOINT: z.url(),
    KEY_WRAPPING_PROVIDER: z.enum(["local", "kms"]),
    KEY_WRAPPING_PUBLIC_KEY_PATH: z.string().min(1),
    KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH: z.string().min(1).optional(),
    WORKER_INTERNAL_URL: z.url(),
    WORKER_INTERNAL_SECRET: z.string().min(32),
  })
  .strip()
  .superRefine((value, context) => {
    refineProductionCore(value, context);
    refineOptimizedLocalCore(value, context);
    if (isOptimizedLocal(value)) {
      requireValue(context, value.GITHUB_ADAPTER === "fake", [
        "GITHUB_ADAPTER",
      ]);
    }
    if (!isProduction(value)) return;

    requireValue(context, value.GITHUB_ADAPTER === "octokit", [
      "GITHUB_ADAPTER",
    ]);
    requireSafeSecret(context, value.SESSION_SECRET, "SESSION_SECRET", 32);
    requireSafeSecret(
      context,
      value.GITHUB_WEBHOOK_SECRET,
      "GITHUB_WEBHOOK_SECRET",
      32,
    );
    requireSafeSecret(
      context,
      value.GITHUB_CLIENT_SECRET,
      "GITHUB_CLIENT_SECRET",
      20,
    );
    requireSafeSecret(
      context,
      value.WORKER_INTERNAL_SECRET,
      "WORKER_INTERNAL_SECRET",
      32,
    );
    requireProductionEndpoint(
      context,
      value.S3_CONTROL_ENDPOINT,
      "S3_CONTROL_ENDPOINT",
    );
    requireProductionEndpoint(
      context,
      value.S3_PUBLIC_ENDPOINT,
      "S3_PUBLIC_ENDPOINT",
    );
    requireInternalWorkerEndpoint(context, value.WORKER_INTERNAL_URL);
    requireSafeSecret(
      context,
      value.S3_SECRET_ACCESS_KEY,
      "S3_SECRET_ACCESS_KEY",
      32,
    );
    requireAbsolutePath(
      context,
      value.KEY_WRAPPING_PUBLIC_KEY_PATH,
      "KEY_WRAPPING_PUBLIC_KEY_PATH",
    );
    requireAbsolutePath(
      context,
      value.KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH,
      "KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH",
    );
  });

const workerSchema = z
  .object({
    ...coreShape,
    ...demoShape,
    // Kept during the Gate 1 transition so the existing fake worker remains
    // build-compatible. GitHub credentials live only in githubControlSchema.
    ...githubSelectorShape,
    ...storageControlShape,
    KEY_WRAPPING_PROVIDER: z.enum(["local", "kms"]),
    KEY_WRAPPING_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH: z.string().min(1).optional(),
    KMS_PROVIDER: z.string().trim().min(1).optional(),
    KMS_KEY_ID: z.string().trim().min(1).optional(),
    WORKER_INTERNAL_SECRET: z.string().min(32),
    PROVIDER_PAYLOAD_KEY_BASE64: payloadEncryptionKey,
    GENERATION_PROVIDER: GenerationProviderSchema.default("fake"),
    GENERATION_BASE_URL: z.url().optional(),
    GENERATION_API_KEY: z.string().min(16).optional(),
    LEARNING_MODEL: z.string().trim().min(1).optional(),
    PRACTICE_MODEL: z.string().trim().min(1).optional(),
    PROOF_QUESTION_MODEL: z.string().trim().min(1).optional(),
    TRANSCRIPTION_PROVIDER: TranscriptionProviderSchema.default("fake"),
    TRANSCRIPTION_BASE_URL: z.url().optional(),
    TRANSCRIPTION_API_KEY: z.string().min(16).optional(),
    TRANSCRIPTION_MODEL: z.string().trim().min(1).optional(),
    MULTIMODAL_JUDGE_PROVIDER: MultimodalJudgeProviderSchema.default("fake"),
    JUDGE_BASE_URL: z.url().optional(),
    JUDGE_API_KEY: z.string().min(16).optional(),
    JUDGE_MODEL: z.string().trim().min(1).optional(),
    JUDGE_FALLBACK_MODEL: z.string().trim().min(1).optional(),
    WORKER_HOST: z.string().trim().min(1).default("127.0.0.1"),
    WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
    FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
    FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  })
  .strip()
  .superRefine((value, context) => {
    refineProductionCore(value, context);
    refineOptimizedLocalCore(value, context);
    refineKeyWrapping(value, context);
    refineGenerationProvider(value, context);
    refineTranscriptionProvider(value, context);
    refineJudgeProvider(value, context);
    if (isOptimizedLocal(value)) {
      requireValue(context, value.GITHUB_ADAPTER === "fake", [
        "GITHUB_ADAPTER",
      ]);
      requireValue(context, value.GENERATION_PROVIDER === "fake", [
        "GENERATION_PROVIDER",
      ]);
      requireValue(context, value.TRANSCRIPTION_PROVIDER === "fake", [
        "TRANSCRIPTION_PROVIDER",
      ]);
      requireValue(context, value.MULTIMODAL_JUDGE_PROVIDER === "fake", [
        "MULTIMODAL_JUDGE_PROVIDER",
      ]);
    }
    if (!isProduction(value)) return;

    requireValue(context, value.GITHUB_ADAPTER === "octokit", [
      "GITHUB_ADAPTER",
    ]);
    requireValue(context, value.GENERATION_PROVIDER === "hetzner", [
      "GENERATION_PROVIDER",
    ]);
    requireValue(context, value.TRANSCRIPTION_PROVIDER === "openrouter", [
      "TRANSCRIPTION_PROVIDER",
    ]);
    requireValue(context, value.MULTIMODAL_JUDGE_PROVIDER === "hetzner", [
      "MULTIMODAL_JUDGE_PROVIDER",
    ]);
    requireProductionEndpoint(
      context,
      value.S3_CONTROL_ENDPOINT,
      "S3_CONTROL_ENDPOINT",
    );
    requireSafeSecret(
      context,
      value.S3_SECRET_ACCESS_KEY,
      "S3_SECRET_ACCESS_KEY",
      32,
    );
    requireSafeSecret(
      context,
      value.WORKER_INTERNAL_SECRET,
      "WORKER_INTERNAL_SECRET",
      32,
    );
    if (value.KEY_WRAPPING_PROVIDER === "local") {
      requireAbsolutePath(
        context,
        value.KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH,
        "KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH",
      );
    }
  });

const githubControlSchema = z
  .object({
    ...coreShape,
    ...demoShape,
    ...githubSelectorShape,
    GITHUB_APP_ID: z.string().trim().min(1).optional(),
    GITHUB_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    GITHUB_PRIVATE_KEY_CONTAINER_PATH: z.string().min(1).optional(),
  })
  .strip()
  .superRefine((value, context) => {
    refineProductionCore(value, context);
    refineOptimizedLocalCore(value, context);
    if (isOptimizedLocal(value)) {
      requireValue(context, value.GITHUB_ADAPTER === "fake", [
        "GITHUB_ADAPTER",
      ]);
    }
    if (value.GITHUB_ADAPTER === "octokit") {
      requireGithubAppId(context, value.GITHUB_APP_ID);
      requireAbsolutePath(
        context,
        value.GITHUB_PRIVATE_KEY_PATH,
        "GITHUB_PRIVATE_KEY_PATH",
      );
    }
    if (!isProduction(value)) return;

    requireValue(context, value.GITHUB_ADAPTER === "octokit", [
      "GITHUB_ADAPTER",
    ]);
    requireAbsolutePath(
      context,
      value.GITHUB_PRIVATE_KEY_CONTAINER_PATH,
      "GITHUB_PRIVATE_KEY_CONTAINER_PATH",
    );
  });

export type BaseConfig = z.output<typeof baseSchema>;
export type WebConfig = z.output<typeof webSchema>;
export type WorkerConfig = z.output<typeof workerSchema>;
export type GithubControlConfig = z.output<typeof githubControlSchema>;

export class ConfigurationError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(`Invalid configuration: ${fields.join(", ")}`);
    this.name = "ConfigurationError";
    this.fields = fields;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;
type ProductionCore = {
  NODE_ENV: "development" | "test" | "production";
  DEPLOYMENT_PROFILE: "local" | "production";
  APP_BASE_URL: string;
  DATABASE_URL: string;
  DEMO_MODE: boolean;
  DEMO_FAKE_MEDIA: boolean;
};

function refineProductionCore(
  value: ProductionCore,
  context: z.RefinementCtx,
): void {
  if (!isProduction(value)) return;
  requireValue(context, value.NODE_ENV === "production", ["NODE_ENV"]);
  requireProductionEndpoint(context, value.APP_BASE_URL, "APP_BASE_URL");
  requireValue(context, !value.DEMO_MODE, ["DEMO_MODE"]);
  requireValue(context, !value.DEMO_FAKE_MEDIA, ["DEMO_FAKE_MEDIA"]);
  requireProductionDatabase(context, value.DATABASE_URL);
}

function refineOptimizedLocalCore(
  value: ProductionCore,
  context: z.RefinementCtx,
): void {
  if (!isOptimizedLocal(value)) return;
  requireValue(context, isLoopbackEndpoint(value.APP_BASE_URL), [
    "APP_BASE_URL",
  ]);
  requireValue(context, value.DEMO_MODE, ["DEMO_MODE"]);
}

function refineKeyWrapping(
  value: z.output<typeof workerSchema>,
  context: z.RefinementCtx,
): void {
  if (value.KEY_WRAPPING_PROVIDER === "local") {
    requireAbsolutePath(
      context,
      value.KEY_WRAPPING_PRIVATE_KEY_PATH,
      "KEY_WRAPPING_PRIVATE_KEY_PATH",
      !isProduction(value),
    );
    return;
  }
  requireValue(context, Boolean(value.KMS_PROVIDER), ["KMS_PROVIDER"]);
  requireValue(context, Boolean(value.KMS_KEY_ID), ["KMS_KEY_ID"]);
}

function refineGenerationProvider(
  value: z.output<typeof workerSchema>,
  context: z.RefinementCtx,
): void {
  if (value.GENERATION_PROVIDER === "fake") return;
  requireProviderEndpoint(
    context,
    value.GENERATION_BASE_URL,
    "GENERATION_BASE_URL",
  );
  requireProviderSecret(
    context,
    value.GENERATION_API_KEY,
    "GENERATION_API_KEY",
  );
  for (const field of [
    "LEARNING_MODEL",
    "PRACTICE_MODEL",
    "PROOF_QUESTION_MODEL",
  ] as const) {
    requireValue(context, Boolean(value[field]), [field]);
  }
}

function refineTranscriptionProvider(
  value: z.output<typeof workerSchema>,
  context: z.RefinementCtx,
): void {
  if (value.TRANSCRIPTION_PROVIDER === "fake") return;
  requireProviderEndpoint(
    context,
    value.TRANSCRIPTION_BASE_URL,
    "TRANSCRIPTION_BASE_URL",
  );
  requireProviderSecret(
    context,
    value.TRANSCRIPTION_API_KEY,
    "TRANSCRIPTION_API_KEY",
  );
  requireValue(context, Boolean(value.TRANSCRIPTION_MODEL), [
    "TRANSCRIPTION_MODEL",
  ]);
}

function refineJudgeProvider(
  value: z.output<typeof workerSchema>,
  context: z.RefinementCtx,
): void {
  if (value.MULTIMODAL_JUDGE_PROVIDER === "fake") return;
  requireProviderEndpoint(context, value.JUDGE_BASE_URL, "JUDGE_BASE_URL");
  requireProviderSecret(context, value.JUDGE_API_KEY, "JUDGE_API_KEY");
  requireValue(context, Boolean(value.JUDGE_MODEL), ["JUDGE_MODEL"]);
  requireValue(context, Boolean(value.JUDGE_FALLBACK_MODEL), [
    "JUDGE_FALLBACK_MODEL",
  ]);
}

function isProduction(value: { DEPLOYMENT_PROFILE: string }): boolean {
  return value.DEPLOYMENT_PROFILE === "production";
}

function isOptimizedLocal(value: {
  DEPLOYMENT_PROFILE: string;
  NODE_ENV: string;
}): boolean {
  return (
    value.DEPLOYMENT_PROFILE === "local" && value.NODE_ENV === "production"
  );
}

function requireValue(
  context: z.RefinementCtx,
  condition: boolean,
  path: string[],
): void {
  if (condition) return;
  context.addIssue({
    code: "custom",
    path,
    message: "is not valid for the selected deployment profile",
  });
}

function requireAbsolutePath(
  context: z.RefinementCtx,
  value: string | undefined,
  field: string,
  allowRelative = false,
): void {
  requireValue(
    context,
    Boolean(value) && (allowRelative || value!.startsWith("/")),
    [field],
  );
}

function requireGithubAppId(
  context: z.RefinementCtx,
  value: string | undefined,
): void {
  requireValue(context, Boolean(value && /^[1-9][0-9]{0,31}$/.test(value)), [
    "GITHUB_APP_ID",
  ]);
}

function requireProviderEndpoint(
  context: z.RefinementCtx,
  value: string | undefined,
  field: string,
): void {
  requireValue(context, Boolean(value), [field]);
  if (value && isProductionEndpoint(value)) return;
  if (value) requireValue(context, false, [field]);
}

function requireProviderSecret(
  context: z.RefinementCtx,
  value: string | undefined,
  field: string,
): void {
  requireValue(
    context,
    Boolean(value && value.length >= 16 && !looksLikePlaceholder(value)),
    [field],
  );
}

function requireSafeSecret(
  context: z.RefinementCtx,
  value: string,
  field: string,
  minimumLength: number,
): void {
  requireValue(
    context,
    value.length >= minimumLength && !looksLikePlaceholder(value),
    [field],
  );
}

function requireProductionEndpoint(
  context: z.RefinementCtx,
  value: string,
  field: string,
): void {
  requireValue(context, isProductionEndpoint(value), [field]);
}

function requireInternalWorkerEndpoint(
  context: z.RefinementCtx,
  value: string,
): void {
  try {
    const url = new URL(value);
    requireValue(
      context,
      url.protocol === "http:" &&
        url.hostname === "worker" &&
        url.port === "4001" &&
        url.pathname === "/" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "",
      ["WORKER_INTERNAL_URL"],
    );
  } catch {
    requireValue(context, false, ["WORKER_INTERNAL_URL"]);
  }
}

function isProductionEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      !isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  );
}

function requireProductionDatabase(
  context: z.RefinementCtx,
  value: string,
): void {
  try {
    const url = new URL(value);
    requireValue(
      context,
      ["postgres:", "postgresql:"].includes(url.protocol) &&
        url.password.length >= 24 &&
        !looksLikePlaceholder(url.password),
      ["DATABASE_URL"],
    );
  } catch {
    requireValue(context, false, ["DATABASE_URL"]);
  }
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    /^(?:fake|local|replace|change|test)(?:[-_:]|$)/.test(normalized) ||
    normalized.includes("change-me") ||
    normalized.includes("placeholder") ||
    normalized.includes("never-used")
  );
}

const forbiddenEverywhereInProduction = [
  "PROVIDER_API_KEY",
  "GITHUB_PRIVATE_KEY",
] as const;

const baseForbiddenProductionFields = [
  ...forbiddenEverywhereInProduction,
  "SESSION_SECRET",
  "WORKER_INTERNAL_SECRET",
  "PROVIDER_PAYLOAD_KEY_BASE64",
  "GENERATION_API_KEY",
  "JUDGE_API_KEY",
  "TRANSCRIPTION_API_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_PRIVATE_KEY_CONTAINER_PATH",
  "S3_SECRET_ACCESS_KEY",
] as const;

const webForbiddenProductionFields = [
  ...forbiddenEverywhereInProduction,
  "PROVIDER_PAYLOAD_KEY_BASE64",
  "GENERATION_API_KEY",
  "JUDGE_API_KEY",
  "TRANSCRIPTION_API_KEY",
  "KEY_WRAPPING_PRIVATE_KEY_PATH",
  "KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH",
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_PRIVATE_KEY_CONTAINER_PATH",
] as const;

const workerForbiddenProductionFields = [
  ...forbiddenEverywhereInProduction,
  "SESSION_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_PRIVATE_KEY_CONTAINER_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "KEY_WRAPPING_PUBLIC_KEY_PATH",
  "KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH",
] as const;

const githubControlForbiddenProductionFields = [
  ...forbiddenEverywhereInProduction,
  "SESSION_SECRET",
  "WORKER_INTERNAL_SECRET",
  "PROVIDER_PAYLOAD_KEY_BASE64",
  "GENERATION_API_KEY",
  "JUDGE_API_KEY",
  "TRANSCRIPTION_API_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "KEY_WRAPPING_PUBLIC_KEY_PATH",
  "KEY_WRAPPING_PRIVATE_KEY_PATH",
] as const;

function parseScopedConfig<T>(
  schema: z.ZodType<T>,
  environment: Environment,
  forbiddenProductionFields: readonly string[],
): T {
  if (environment.DEPLOYMENT_PROFILE === "production") {
    const exposedFields = forbiddenProductionFields.filter((field) =>
      Boolean(environment[field]?.trim()),
    );
    if (exposedFields.length > 0) {
      throw new ConfigurationError([...new Set(exposedFields)].sort());
    }
  }
  const result = schema.safeParse(environment);
  if (result.success) return result.data;

  const fields = [
    ...new Set(
      result.error.issues.map((issue) => issue.path.join(".") || "environment"),
    ),
  ].sort();
  throw new ConfigurationError(fields);
}

export function loadBaseConfig(
  environment: Environment = process.env,
): BaseConfig {
  return parseScopedConfig(
    baseSchema,
    environment,
    baseForbiddenProductionFields,
  );
}

export function loadWebConfig(
  environment: Environment = process.env,
): WebConfig {
  return parseScopedConfig(
    webSchema,
    environment,
    webForbiddenProductionFields,
  );
}

export function loadWorkerConfig(
  environment: Environment = process.env,
): WorkerConfig {
  return parseScopedConfig(
    workerSchema,
    environment,
    workerForbiddenProductionFields,
  );
}

export function loadGithubControlConfig(
  environment: Environment = process.env,
): GithubControlConfig {
  return parseScopedConfig(
    githubControlSchema,
    environment,
    githubControlForbiddenProductionFields,
  );
}
