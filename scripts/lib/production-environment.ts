import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  ConfigurationError,
  loadGithubControlConfig,
  loadMigrationConfig,
  loadWebConfig,
  loadWorkerConfig,
} from "@slopproof/config";
type Environment = Readonly<Record<string, string | undefined>>;

export class ProductionEnvironmentError extends Error {
  readonly fields: string[];

  constructor(fields: string[]) {
    super(
      `Invalid production environment: ${[...new Set(fields)].sort().join(", ")}`,
    );
    this.name = "ProductionEnvironmentError";
    this.fields = [...new Set(fields)].sort();
  }
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value || value.trim().length === 0 || /[\0\r\n']/u.test(value)) {
    throw new ProductionEnvironmentError([name]);
  }
  return value;
}

function requiredExact(
  environment: Environment,
  name: string,
  expected: string,
): string {
  const value = required(environment, name);
  if (value !== expected) throw new ProductionEnvironmentError([name]);
  return value;
}

function requiredOneOf(
  environment: Environment,
  name: string,
  expected: readonly string[],
): string {
  const value = required(environment, name);
  if (!expected.includes(value)) throw new ProductionEnvironmentError([name]);
  return value;
}

function containerPath(
  environment: Environment,
  name: string,
  expectedFileName: string,
): string {
  const value = required(environment, name);
  if (value !== `/run/secrets/${expectedFileName}`) {
    throw new ProductionEnvironmentError([name]);
  }
  return value;
}

export function compileProductionEnvironment(
  environment: Environment,
): Readonly<Record<string, string>> {
  requiredExact(environment, "NODE_ENV", "production");
  requiredExact(environment, "DEMO_MODE", "false");
  requiredExact(environment, "GITHUB_ADAPTER", "octokit");
  const generationProvider = requiredOneOf(environment, "GENERATION_PROVIDER", [
    "hetzner",
    "openrouter",
  ]);
  const judgeProvider = requiredOneOf(
    environment,
    "MULTIMODAL_JUDGE_PROVIDER",
    ["hetzner", "openrouter"],
  );
  requiredExact(environment, "TRANSCRIPTION_PROVIDER", "openrouter");
  requiredExact(environment, "EVIDENCE_STORAGE_PROVIDER", "s3");

  const githubPrivateKeyPath = containerPath(
    environment,
    "GITHUB_PRIVATE_KEY_CONTAINER_PATH",
    "github-app.pem",
  );
  const wrappingPublicKeyPath = containerPath(
    environment,
    "KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH",
    "wrapping-public.pem",
  );
  const wrappingPrivateKeyPath = containerPath(
    environment,
    "KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH",
    "wrapping-private.pem",
  );
  const storageCredentials = resolveProductionStorageCredentials(environment);
  const storageControlEndpoint = required(environment, "S3_CONTROL_ENDPOINT");
  const storagePublicEndpoint = required(environment, "S3_PUBLIC_ENDPOINT");
  const storageRegion = required(environment, "S3_REGION");
  const storageBucket = required(environment, "S3_BUCKET");
  const workerInternalSecret = required(environment, "WORKER_INTERNAL_SECRET");

  const compiled = Object.freeze({
    NODE_ENV: "production",
    DEPLOYMENT_PROFILE: "production",
    APP_BASE_URL: required(environment, "APP_BASE_URL"),
    DEMO_MODE: "false",
    DEMO_FAKE_MEDIA: "false",
    DATABASE_URL: required(environment, "DATABASE_URL"),
    SESSION_SECRET: required(environment, "SESSION_SECRET"),
    LOG_LEVEL: required(environment, "LOG_LEVEL"),

    GITHUB_ADAPTER: "octokit",
    GITHUB_APP_ID: required(environment, "GITHUB_APP_ID"),
    GITHUB_PRIVATE_KEY_PATH: githubPrivateKeyPath,
    GITHUB_PRIVATE_KEY_CONTAINER_PATH: githubPrivateKeyPath,
    GITHUB_WEBHOOK_SECRET: required(environment, "GITHUB_WEBHOOK_SECRET"),
    GITHUB_CLIENT_ID: required(environment, "GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: required(environment, "GITHUB_CLIENT_SECRET"),
    OAUTH_TRUSTED_PROXY_SECRET:
      deriveOAuthTrustedProxySecret(workerInternalSecret),

    GENERATION_PROVIDER: generationProvider,
    GENERATION_BASE_URL: required(environment, "GENERATION_BASE_URL"),
    GENERATION_API_KEY: required(environment, "GENERATION_API_KEY"),
    LEARNING_MODEL: required(environment, "LEARNING_MODEL"),
    PRACTICE_MODEL: required(environment, "PRACTICE_MODEL"),
    PROOF_QUESTION_MODEL: required(environment, "PROOF_QUESTION_MODEL"),
    ...(generationProvider === "openrouter"
      ? {
          GENERATION_FALLBACK_BASE_URL: required(
            environment,
            "GENERATION_FALLBACK_BASE_URL",
          ),
          GENERATION_FALLBACK_API_KEY: required(
            environment,
            "GENERATION_FALLBACK_API_KEY",
          ),
          LEARNING_FALLBACK_MODEL: required(
            environment,
            "LEARNING_FALLBACK_MODEL",
          ),
          PRACTICE_FALLBACK_MODEL: required(
            environment,
            "PRACTICE_FALLBACK_MODEL",
          ),
          PROOF_QUESTION_FALLBACK_MODEL: required(
            environment,
            "PROOF_QUESTION_FALLBACK_MODEL",
          ),
        }
      : {}),

    MULTIMODAL_JUDGE_PROVIDER: judgeProvider,
    JUDGE_BASE_URL: required(environment, "JUDGE_BASE_URL"),
    JUDGE_API_KEY: required(environment, "JUDGE_API_KEY"),
    JUDGE_MODEL: required(environment, "JUDGE_MODEL"),
    JUDGE_FALLBACK_MODEL: required(environment, "JUDGE_FALLBACK_MODEL"),
    ...(judgeProvider === "openrouter"
      ? {
          JUDGE_TRANSPORT_FALLBACK_BASE_URL: required(
            environment,
            "JUDGE_TRANSPORT_FALLBACK_BASE_URL",
          ),
          JUDGE_TRANSPORT_FALLBACK_API_KEY: required(
            environment,
            "JUDGE_TRANSPORT_FALLBACK_API_KEY",
          ),
          JUDGE_TRANSPORT_FALLBACK_MODEL: required(
            environment,
            "JUDGE_TRANSPORT_FALLBACK_MODEL",
          ),
          JUDGE_TRANSPORT_FALLBACK_VISION_MODEL: required(
            environment,
            "JUDGE_TRANSPORT_FALLBACK_VISION_MODEL",
          ),
        }
      : {}),

    TRANSCRIPTION_PROVIDER: "openrouter",
    TRANSCRIPTION_BASE_URL: required(environment, "TRANSCRIPTION_BASE_URL"),
    TRANSCRIPTION_API_KEY: required(environment, "TRANSCRIPTION_API_KEY"),
    TRANSCRIPTION_MODEL: required(environment, "TRANSCRIPTION_MODEL"),

    EVIDENCE_STORAGE_PROVIDER: "s3",
    S3_CONTROL_ENDPOINT: storageControlEndpoint,
    S3_PUBLIC_ENDPOINT: storagePublicEndpoint,
    S3_REGION: storageRegion,
    S3_BUCKET: storageBucket,
    S3_ACCESS_KEY_ID: storageCredentials.accessKeyId,
    S3_SECRET_ACCESS_KEY: storageCredentials.secretAccessKey,

    KEY_WRAPPING_PROVIDER: requiredExact(
      environment,
      "KEY_WRAPPING_PROVIDER",
      "local",
    ),
    KEY_WRAPPING_PUBLIC_KEY_PATH: wrappingPublicKeyPath,
    KEY_WRAPPING_PRIVATE_KEY_PATH: wrappingPrivateKeyPath,
    KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH: wrappingPublicKeyPath,
    KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH: wrappingPrivateKeyPath,

    WORKER_INTERNAL_URL: required(environment, "WORKER_INTERNAL_URL"),
    GITHUB_CONTROL_INTERNAL_URL: "http://github-control:4002/healthz",
    WORKER_INTERNAL_SECRET: workerInternalSecret,
    PROVIDER_PAYLOAD_KEY_BASE64: required(
      environment,
      "PROVIDER_PAYLOAD_KEY_BASE64",
    ),
    WORKER_HOST: required(environment, "WORKER_HOST"),
    WORKER_PORT: required(environment, "WORKER_PORT"),
    GITHUB_CONTROL_HOST: "0.0.0.0",
    GITHUB_CONTROL_PORT: "4002",
    FFMPEG_PATH: required(environment, "FFMPEG_PATH"),
    FFPROBE_PATH: required(environment, "FFPROBE_PATH"),
  });
  try {
    const partitions = partitionProductionEnvironment(compiled);
    loadWebConfig(partitions.web);
    loadWorkerConfig(partitions.worker);
    loadGithubControlConfig(partitions.githubControl);
    loadMigrationConfig(partitions.migrate);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw new ProductionEnvironmentError(error.fields);
    }
    throw error;
  }
  return compiled;
}

function resolveProductionStorageCredentials(environment: Environment): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const hasCanonicalInput =
    environment.S3_ACCESS_KEY_ID !== undefined ||
    environment.S3_SECRET_ACCESS_KEY !== undefined;
  if (hasCanonicalInput) {
    return {
      accessKeyId: required(environment, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(environment, "S3_SECRET_ACCESS_KEY"),
    };
  }

  // Backward compatibility for the original hosted deployment compiler. New
  // self-hosted deployments should use the canonical S3 names above.
  return {
    accessKeyId: required(environment, "CLOUDFLARE_R2_AK"),
    secretAccessKey: createHash("sha256")
      .update(required(environment, "CLOUDFLARE_R2_API"), "utf8")
      .digest("hex"),
  };
}

export function deriveOAuthTrustedProxySecret(
  workerInternalSecret: string,
): string {
  if (
    workerInternalSecret.length < 32 ||
    /[\0\r\n]/u.test(workerInternalSecret)
  ) {
    throw new ProductionEnvironmentError(["WORKER_INTERNAL_SECRET"]);
  }
  return createHmac("sha256", workerInternalSecret)
    .update("slopproof-oauth-trusted-proxy-v1", "utf8")
    .digest("base64url");
}

function quoteEnvironmentValue(value: string): string {
  return `'${value}'`;
}

export function renderProductionEnvironment(
  environment: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(environment);
  if (entries.some(([name]) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
    throw new ProductionEnvironmentError(["environment"]);
  }
  const invalidFields = entries
    .filter(
      ([, value]) => typeof value !== "string" || /[\0\r\n']/u.test(value),
    )
    .map(([name]) => name);
  if (invalidFields.length > 0) {
    throw new ProductionEnvironmentError(invalidFields);
  }

  return `${entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${quoteEnvironmentValue(value)}`)
    .join("\n")}\n`;
}

const webEnvironmentNames = [
  "NODE_ENV",
  "DEPLOYMENT_PROFILE",
  "APP_BASE_URL",
  "DEMO_MODE",
  "DEMO_FAKE_MEDIA",
  "DATABASE_URL",
  "SESSION_SECRET",
  "LOG_LEVEL",
  "GITHUB_ADAPTER",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "OAUTH_TRUSTED_PROXY_SECRET",
  "EVIDENCE_STORAGE_PROVIDER",
  "S3_CONTROL_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "KEY_WRAPPING_PROVIDER",
  "KEY_WRAPPING_PUBLIC_KEY_PATH",
  "KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH",
  "WORKER_INTERNAL_URL",
  "GITHUB_CONTROL_INTERNAL_URL",
  "WORKER_INTERNAL_SECRET",
] as const;

const workerEnvironmentNames = [
  "NODE_ENV",
  "DEPLOYMENT_PROFILE",
  "APP_BASE_URL",
  "DEMO_MODE",
  "DEMO_FAKE_MEDIA",
  "DATABASE_URL",
  "LOG_LEVEL",
  "GITHUB_ADAPTER",
  "GENERATION_PROVIDER",
  "GENERATION_BASE_URL",
  "GENERATION_API_KEY",
  "LEARNING_MODEL",
  "PRACTICE_MODEL",
  "PROOF_QUESTION_MODEL",
  "GENERATION_FALLBACK_BASE_URL",
  "GENERATION_FALLBACK_API_KEY",
  "LEARNING_FALLBACK_MODEL",
  "PRACTICE_FALLBACK_MODEL",
  "PROOF_QUESTION_FALLBACK_MODEL",
  "MULTIMODAL_JUDGE_PROVIDER",
  "JUDGE_BASE_URL",
  "JUDGE_API_KEY",
  "JUDGE_MODEL",
  "JUDGE_FALLBACK_MODEL",
  "JUDGE_TRANSPORT_FALLBACK_BASE_URL",
  "JUDGE_TRANSPORT_FALLBACK_API_KEY",
  "JUDGE_TRANSPORT_FALLBACK_MODEL",
  "JUDGE_TRANSPORT_FALLBACK_VISION_MODEL",
  "TRANSCRIPTION_PROVIDER",
  "TRANSCRIPTION_BASE_URL",
  "TRANSCRIPTION_API_KEY",
  "TRANSCRIPTION_MODEL",
  "EVIDENCE_STORAGE_PROVIDER",
  "S3_CONTROL_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "KEY_WRAPPING_PROVIDER",
  "KEY_WRAPPING_PRIVATE_KEY_PATH",
  "KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH",
  "WORKER_INTERNAL_SECRET",
  "PROVIDER_PAYLOAD_KEY_BASE64",
  "WORKER_HOST",
  "WORKER_PORT",
  "FFMPEG_PATH",
  "FFPROBE_PATH",
] as const;

const githubControlEnvironmentNames = [
  "NODE_ENV",
  "DEPLOYMENT_PROFILE",
  "APP_BASE_URL",
  "DEMO_MODE",
  "DEMO_FAKE_MEDIA",
  "DATABASE_URL",
  "LOG_LEVEL",
  "GITHUB_ADAPTER",
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_PRIVATE_KEY_CONTAINER_PATH",
  "GITHUB_CONTROL_HOST",
  "GITHUB_CONTROL_PORT",
] as const;

const proxyEnvironmentNames = ["OAUTH_TRUSTED_PROXY_SECRET"] as const;

function selectEnvironment(
  environment: Readonly<Record<string, string>>,
  names: readonly string[],
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      names
        .filter((name) => environment[name] !== undefined)
        .map((name) => [name, environment[name] ?? ""]),
    ),
  );
}

export function partitionProductionEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<{
  web: Readonly<Record<string, string>>;
  worker: Readonly<Record<string, string>>;
  githubControl: Readonly<Record<string, string>>;
  proxy: Readonly<Record<string, string>>;
  migrate: Readonly<Record<string, string>>;
}> {
  return Object.freeze({
    web: selectEnvironment(environment, webEnvironmentNames),
    worker: selectEnvironment(environment, workerEnvironmentNames),
    githubControl: selectEnvironment(
      environment,
      githubControlEnvironmentNames,
    ),
    proxy: selectEnvironment(environment, proxyEnvironmentNames),
    migrate: selectEnvironment(environment, [
      "NODE_ENV",
      "DEPLOYMENT_PROFILE",
      "DATABASE_URL",
    ]),
  });
}

export function writeProductionEnvironmentFile(
  outputPath: string,
  contents: string,
): void {
  writeNewProtectedFile(outputPath, contents, 0o600);
}

function productionDatabasePassword(databaseUrl: string): string {
  try {
    if (databaseUrl !== databaseUrl.trim()) {
      throw new ProductionEnvironmentError(["DATABASE_URL"]);
    }
    const url = new URL(databaseUrl);
    const password = decodeURIComponent(url.password);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.username !== "slopproof" ||
      url.hostname !== "postgres" ||
      url.port !== "5432" ||
      url.pathname !== "/slopproof" ||
      url.search !== "" ||
      url.hash !== "" ||
      password.length < 24 ||
      /^(?:fake|local|replace|change|test)(?:[-_:]|$)/iu.test(password) ||
      /change-me|placeholder|never-used/iu.test(password) ||
      /[\0\r\n]/u.test(password)
    ) {
      throw new ProductionEnvironmentError(["DATABASE_URL"]);
    }
    return password;
  } catch (error) {
    if (error instanceof ProductionEnvironmentError) throw error;
    throw new ProductionEnvironmentError(["DATABASE_URL"]);
  }
}

export function installProductionDatabasePassword(
  databaseUrl: string,
  outputDirectory: string,
): void {
  installProductionArtifactFiles(outputDirectory, [
    {
      contents: productionDatabasePassword(databaseUrl),
      destinationName: "postgres-password",
      destinationMode: 0o600,
    },
  ]);
}

type ProductionArtifact = Readonly<{
  contents: string;
  destinationName: string;
  destinationMode: number;
}>;

function installProductionArtifactFiles(
  outputDirectory: string,
  artifacts: readonly ProductionArtifact[],
): void {
  const names = artifacts.map(({ destinationName }) => destinationName);
  if (
    !isAbsolute(outputDirectory) ||
    artifacts.length === 0 ||
    new Set(names).size !== names.length ||
    artifacts.some(
      ({ contents, destinationMode, destinationName }) =>
        contents.length === 0 ||
        !/^[a-z0-9][a-z0-9.-]*$/u.test(destinationName) ||
        ![0o600, 0o644].includes(destinationMode),
    )
  ) {
    throw new ProductionEnvironmentError(["outputDirectory"]);
  }

  try {
    const stat = lstatSync(outputDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      readdirSync(outputDirectory).length !== 0
    ) {
      throw new ProductionEnvironmentError(["outputDirectory"]);
    }
  } catch (error) {
    if (error instanceof ProductionEnvironmentError) throw error;
    throw new ProductionEnvironmentError(["outputDirectory"]);
  }

  const outputPaths = names.map((name) => join(outputDirectory, name));
  if (outputPaths.some((path) => existsSync(path))) {
    throw new ProductionEnvironmentError(["outputDirectory"]);
  }

  const installedPaths: string[] = [];
  try {
    for (const [index, artifact] of artifacts.entries()) {
      const outputPath = outputPaths[index]!;
      writeNewProtectedFile(
        outputPath,
        artifact.contents,
        artifact.destinationMode,
      );
      installedPaths.push(outputPath);
    }
  } catch {
    for (const installedPath of installedPaths.reverse()) {
      try {
        if (existsSync(installedPath)) unlinkSync(installedPath);
      } catch {
        // Continue the bounded cleanup of the remaining exact artifact paths.
      }
    }
    throw new ProductionEnvironmentError(["outputDirectory"]);
  }
}

function writeNewProtectedFile(
  outputPath: string,
  contents: string,
  mode: number,
): void {
  if (!isAbsolute(outputPath)) {
    throw new ProductionEnvironmentError(["outputPath"]);
  }
  if (existsSync(outputPath)) {
    throw new ProductionEnvironmentError(["outputPath"]);
  }

  const outputDirectory = dirname(outputPath);
  const temporaryPath = join(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let temporaryCreated = false;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    temporaryCreated = true;
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryCreated && existsSync(temporaryPath))
      unlinkSync(temporaryPath);
    throw error;
  }
}

type LoadedKeyFile = ProductionArtifact;

function loadKeyFile(
  environment: Environment,
  environmentName: string,
  destinationName: string,
  privateFile: boolean,
): LoadedKeyFile {
  const sourcePath = required(environment, environmentName);
  if (!isAbsolute(sourcePath)) {
    throw new ProductionEnvironmentError([environmentName]);
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    const unsafeMode = privateFile
      ? (stat.mode & 0o077) !== 0
      : (stat.mode & 0o022) !== 0;
    if (
      !stat.isFile() ||
      stat.size < 128 ||
      stat.size > 64 * 1024 ||
      unsafeMode
    ) {
      throw new ProductionEnvironmentError([environmentName]);
    }
    const contents = readFileSync(descriptor, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    return Object.freeze({
      contents,
      destinationName,
      destinationMode: privateFile ? 0o600 : 0o644,
    });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof ProductionEnvironmentError) throw error;
    throw new ProductionEnvironmentError([environmentName]);
  }
}

function loadProductionKeyFiles(
  environment: Environment,
): readonly LoadedKeyFile[] {
  const github = loadKeyFile(
    environment,
    "GITHUB_PRIVATE_KEY_PATH",
    "github-app.pem",
    true,
  );
  const wrappingPrivate = loadKeyFile(
    environment,
    "KEY_WRAPPING_PRIVATE_KEY_PATH",
    "wrapping-private.pem",
    true,
  );
  const wrappingPublic = loadKeyFile(
    environment,
    "KEY_WRAPPING_PUBLIC_KEY_PATH",
    "wrapping-public.pem",
    false,
  );

  try {
    const githubKey = createPrivateKey(github.contents);
    const wrappingPrivateKey = createPrivateKey(wrappingPrivate.contents);
    const wrappingPublicKey = createPublicKey(wrappingPublic.contents);
    const githubBits = githubKey.asymmetricKeyDetails?.modulusLength ?? 0;
    const wrappingPrivateBits =
      wrappingPrivateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    const wrappingPublicBits =
      wrappingPublicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    const derivedWrappingPublic = createPublicKey(wrappingPrivateKey).export({
      format: "der",
      type: "spki",
    });
    const suppliedWrappingPublic = wrappingPublicKey.export({
      format: "der",
      type: "spki",
    });
    if (
      githubKey.asymmetricKeyType !== "rsa" ||
      githubBits < 2048 ||
      wrappingPrivateKey.asymmetricKeyType !== "rsa" ||
      wrappingPublicKey.asymmetricKeyType !== "rsa" ||
      wrappingPrivateBits !== 3072 ||
      wrappingPublicBits !== 3072 ||
      !derivedWrappingPublic.equals(suppliedWrappingPublic)
    ) {
      throw new ProductionEnvironmentError([
        "GITHUB_PRIVATE_KEY_PATH",
        "KEY_WRAPPING_PRIVATE_KEY_PATH",
        "KEY_WRAPPING_PUBLIC_KEY_PATH",
      ]);
    }
  } catch (error) {
    if (error instanceof ProductionEnvironmentError) throw error;
    throw new ProductionEnvironmentError([
      "GITHUB_PRIVATE_KEY_PATH",
      "KEY_WRAPPING_PRIVATE_KEY_PATH",
      "KEY_WRAPPING_PUBLIC_KEY_PATH",
    ]);
  }

  return Object.freeze([github, wrappingPrivate, wrappingPublic]);
}

export function installProductionKeyFiles(
  environment: Environment,
  outputDirectory: string,
): void {
  installProductionArtifactFiles(
    outputDirectory,
    loadProductionKeyFiles(environment),
  );
}

export type ProductionEnvironmentPartitions = ReturnType<
  typeof partitionProductionEnvironment
>;

export function installProductionArtifacts(
  environment: Environment,
  outputDirectory: string,
  partitions: ProductionEnvironmentPartitions,
): void {
  const environmentArtifacts: readonly ProductionArtifact[] = [
    ["web.env", partitions.web],
    ["worker.env", partitions.worker],
    ["github-control.env", partitions.githubControl],
    ["proxy.env", partitions.proxy],
    ["migrate.env", partitions.migrate],
  ].map(([destinationName, scopedEnvironment]) => ({
    contents: renderProductionEnvironment(scopedEnvironment),
    destinationMode: 0o600,
    destinationName,
  }));
  const databasePassword = productionDatabasePassword(
    partitions.migrate.DATABASE_URL ?? "",
  );
  const keyFiles = loadProductionKeyFiles(environment);

  installProductionArtifactFiles(outputDirectory, [
    ...environmentArtifacts,
    ...keyFiles,
    {
      contents: databasePassword,
      destinationName: "postgres-password",
      destinationMode: 0o600,
    },
  ]);
}

export function assertSafeProductionOutputDirectory(
  outputDirectory: string,
  workspaceDirectory: string,
): void {
  if (!isAbsolute(outputDirectory) || !isAbsolute(workspaceDirectory)) {
    throw new ProductionEnvironmentError(["outputDirectory"]);
  }
  const outputStat = lstatSync(outputDirectory);
  if (
    !outputStat.isDirectory() ||
    outputStat.isSymbolicLink() ||
    (outputStat.mode & 0o077) !== 0 ||
    readdirSync(outputDirectory).length !== 0
  ) {
    throw new ProductionEnvironmentError(["outputDirectory"]);
  }

  const workspace = realpathSync(workspaceDirectory);
  const output = realpathSync(outputDirectory);
  if (output === workspace || output.startsWith(`${workspace}/`)) {
    throw new ProductionEnvironmentError(["outputDirectory"]);
  }
}
