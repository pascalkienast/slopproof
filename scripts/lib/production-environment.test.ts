import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeProductionOutputDirectory,
  compileProductionEnvironment,
  deriveOAuthTrustedProxySecret,
  installProductionArtifacts,
  installProductionDatabasePassword,
  installProductionKeyFiles,
  partitionProductionEnvironment,
  ProductionEnvironmentError,
  renderProductionEnvironment,
  writeProductionEnvironmentFile,
} from "./production-environment";

const sourceEnvironment = {
  NODE_ENV: "production",
  APP_BASE_URL: "https://slopproof.example",
  DEMO_MODE: "false",
  DATABASE_URL: "postgres://production.example/slopproof",
  SESSION_SECRET: "s".repeat(48),
  LOG_LEVEL: "info",
  GITHUB_ADAPTER: "octokit",
  GITHUB_APP_ID: "12345",
  GITHUB_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/github-app.pem",
  GITHUB_WEBHOOK_SECRET: "w".repeat(48),
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "c".repeat(48),
  GENERATION_PROVIDER: "hetzner",
  GENERATION_BASE_URL: "https://inference.example/api/v1",
  GENERATION_API_KEY: "g".repeat(48),
  LEARNING_MODEL: "learning-model",
  PRACTICE_MODEL: "practice-model",
  PROOF_QUESTION_MODEL: "proof-model",
  MULTIMODAL_JUDGE_PROVIDER: "hetzner",
  JUDGE_BASE_URL: "https://inference.example/api/v1",
  JUDGE_API_KEY: "j".repeat(48),
  JUDGE_MODEL: "judge-model",
  JUDGE_FALLBACK_MODEL: "vision-model",
  TRANSCRIPTION_PROVIDER: "openrouter",
  TRANSCRIPTION_BASE_URL: "https://transcription.example/api/v1",
  TRANSCRIPTION_API_KEY: "t".repeat(48),
  TRANSCRIPTION_MODEL: "stt-model",
  EVIDENCE_STORAGE_PROVIDER: "s3",
  S3_CONTROL_ENDPOINT: "https://objects.example",
  S3_PUBLIC_ENDPOINT: "https://objects.example",
  S3_REGION: "auto",
  S3_BUCKET: "slopproof-eu",
  CLOUDFLARE_R2_AK: "bucket-scoped-access-id",
  CLOUDFLARE_R2_API: "bucket-scoped-api-token",
  CLOUDFLARE_R2_SEC_ACCESSKEY: "must-never-be-used",
  KEY_WRAPPING_PROVIDER: "local",
  KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH: "/run/secrets/wrapping-public.pem",
  KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/wrapping-private.pem",
  WORKER_INTERNAL_URL: "http://worker:4001",
  WORKER_INTERNAL_SECRET: "i".repeat(48),
  PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString("base64"),
  WORKER_HOST: "0.0.0.0",
  WORKER_PORT: "4001",
  FFMPEG_PATH: "/usr/bin/ffmpeg",
  FFPROBE_PATH: "/usr/bin/ffprobe",
} as const;

describe("production environment compiler", () => {
  it("maps only canonical runtime names and derives the R2 S3 secret", () => {
    const compiled = compileProductionEnvironment(sourceEnvironment);

    expect(compiled.S3_ACCESS_KEY_ID).toBe(sourceEnvironment.CLOUDFLARE_R2_AK);
    expect(compiled.S3_SECRET_ACCESS_KEY).toBe(
      createHash("sha256")
        .update(sourceEnvironment.CLOUDFLARE_R2_API, "utf8")
        .digest("hex"),
    );
    expect(compiled.S3_SECRET_ACCESS_KEY).not.toBe(
      sourceEnvironment.CLOUDFLARE_R2_SEC_ACCESSKEY,
    );
    expect(compiled).not.toHaveProperty("CLOUDFLARE_R2_AK");
    expect(compiled).not.toHaveProperty("CLOUDFLARE_R2_API");
    expect(compiled.GITHUB_PRIVATE_KEY_PATH).toBe(
      "/run/secrets/github-app.pem",
    );
    expect(compiled.GITHUB_CONTROL_INTERNAL_URL).toBe(
      "http://github-control:4002/healthz",
    );
    expect(compiled.GITHUB_CONTROL_HOST).toBe("0.0.0.0");
    expect(compiled.GITHUB_CONTROL_PORT).toBe("4002");
    expect(compiled.OAUTH_TRUSTED_PROXY_SECRET).toBe(
      deriveOAuthTrustedProxySecret(sourceEnvironment.WORKER_INTERNAL_SECRET),
    );
    expect(compiled.OAUTH_TRUSTED_PROXY_SECRET).not.toBe(
      sourceEnvironment.WORKER_INTERNAL_SECRET,
    );
    expect(
      compileProductionEnvironment({
        ...sourceEnvironment,
        OAUTH_TRUSTED_PROXY_SECRET: "operator-input-must-not-be-consumed",
      }).OAUTH_TRUSTED_PROXY_SECRET,
    ).toBe(compiled.OAUTH_TRUSTED_PROXY_SECRET);
  });

  it("fails closed without echoing a supplied secret", () => {
    const secret = "must-not-appear-in-an-error";
    const malformed = {
      ...sourceEnvironment,
      SESSION_SECRET: secret,
      NODE_ENV: "development",
    };

    try {
      compileProductionEnvironment(malformed);
      throw new Error("expected the compiler to reject development mode");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionEnvironmentError);
      expect(String(error)).toContain("NODE_ENV");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("rejects delimiter-bearing values with field-only errors", () => {
    const secret = `${"g".repeat(32)}'still-secret`;
    try {
      compileProductionEnvironment({
        ...sourceEnvironment,
        GENERATION_API_KEY: secret,
      });
      throw new Error("expected a delimiter-bearing secret to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionEnvironmentError);
      expect(String(error)).toContain("GENERATION_API_KEY");
      expect(String(error)).not.toContain(secret);
    }

    expect(() =>
      renderProductionEnvironment({ SAFE_NAME: secret }),
    ).toThrowError(ProductionEnvironmentError);
  });

  it("partitions process environments without cross-boundary secrets", () => {
    const partitions = partitionProductionEnvironment(
      compileProductionEnvironment(sourceEnvironment),
    );

    expect(partitions.web).toHaveProperty("GITHUB_CLIENT_SECRET");
    expect(partitions.web).toHaveProperty("OAUTH_TRUSTED_PROXY_SECRET");
    expect(partitions.web.GITHUB_CONTROL_INTERNAL_URL).toBe(
      "http://github-control:4002/healthz",
    );
    expect(partitions.web).not.toHaveProperty("GENERATION_API_KEY");
    expect(partitions.web).not.toHaveProperty("GITHUB_PRIVATE_KEY_PATH");
    expect(partitions.web).not.toHaveProperty("KEY_WRAPPING_PRIVATE_KEY_PATH");
    expect(partitions.worker).toHaveProperty("GENERATION_API_KEY");
    expect(partitions.worker).not.toHaveProperty("GITHUB_CLIENT_SECRET");
    expect(partitions.worker).not.toHaveProperty("OAUTH_TRUSTED_PROXY_SECRET");
    expect(partitions.worker).not.toHaveProperty("GITHUB_PRIVATE_KEY_PATH");
    expect(partitions.githubControl).toHaveProperty("GITHUB_PRIVATE_KEY_PATH");
    expect(partitions.githubControl.GITHUB_CONTROL_HOST).toBe("0.0.0.0");
    expect(partitions.githubControl.GITHUB_CONTROL_PORT).toBe("4002");
    expect(partitions.githubControl).not.toHaveProperty("S3_SECRET_ACCESS_KEY");
    expect(partitions.githubControl).not.toHaveProperty("GENERATION_API_KEY");
    expect(partitions.githubControl).not.toHaveProperty(
      "OAUTH_TRUSTED_PROXY_SECRET",
    );
    expect(Object.keys(partitions.proxy)).toEqual([
      "OAUTH_TRUSTED_PROXY_SECRET",
    ]);
    expect(partitions.proxy.OAUTH_TRUSTED_PROXY_SECRET).toBe(
      partitions.web.OAUTH_TRUSTED_PROXY_SECRET,
    );
    expect(Object.keys(partitions.migrate).sort()).toEqual([
      "DATABASE_URL",
      "DEPLOYMENT_PROFILE",
      "NODE_ENV",
    ]);
  });

  it("renders deterministically and installs a mode-0600 file", () => {
    const compiled = compileProductionEnvironment(sourceEnvironment);
    const rendered = renderProductionEnvironment(compiled);
    const directory = mkdtempSync(join(tmpdir(), "slopproof-production-env-"));
    const outputPath = join(directory, "slopproof.env");
    try {
      writeProductionEnvironmentFile(outputPath, rendered);

      expect(readFileSync(outputPath, "utf8")).toBe(rendered);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(rendered).not.toContain("CLOUDFLARE_R2_API=");
      expect(rendered).not.toContain("CLOUDFLARE_R2_SEC_ACCESSKEY");
      expect(rendered).toMatch(/^APP_BASE_URL=/u);
      expect(() =>
        writeProductionEnvironmentFile(outputPath, rendered),
      ).toThrowError(ProductionEnvironmentError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives a protected password-only Postgres file from the canonical URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "slopproof-db-password-"));
    const password = `${"p".repeat(28)}:@/safe`;
    const databaseUrl = `postgres://slopproof:${encodeURIComponent(password)}@postgres:5432/slopproof`;
    try {
      installProductionDatabasePassword(databaseUrl, directory);
      const outputPath = join(directory, "postgres-password");
      expect(readFileSync(outputPath, "utf8")).toBe(password);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(() =>
        installProductionDatabasePassword(databaseUrl, directory),
      ).toThrowError(ProductionEnvironmentError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "wrong host",
      `postgres://slopproof:${"p".repeat(32)}@database.example:5432/slopproof`,
    ],
    [
      "wrong user",
      `postgres://admin:${"p".repeat(32)}@postgres:5432/slopproof`,
    ],
    [
      "wrong port",
      `postgres://slopproof:${"p".repeat(32)}@postgres:5433/slopproof`,
    ],
    [
      "wrong database",
      `postgres://slopproof:${"p".repeat(32)}@postgres:5432/other`,
    ],
    [
      "query parameters",
      `postgres://slopproof:${"p".repeat(32)}@postgres:5432/slopproof?sslmode=disable`,
    ],
    [
      "short decoded password",
      "postgres://slopproof:short@postgres:5432/slopproof",
    ],
    [
      "placeholder password",
      "postgres://slopproof:change-me-database-password@postgres:5432/slopproof",
    ],
    [
      "decoded newline",
      `postgres://slopproof:${"p".repeat(24)}%0A@postgres:5432/slopproof`,
    ],
  ])("rejects a %s database URL without exposing it", (_name, databaseUrl) => {
    const directory = mkdtempSync(join(tmpdir(), "slopproof-db-password-"));
    try {
      expect(() =>
        installProductionDatabasePassword(databaseUrl, directory),
      ).toThrowError(ProductionEnvironmentError);
      try {
        installProductionDatabasePassword(databaseUrl, directory);
      } catch (error) {
        expect(String(error)).not.toContain(databaseUrl);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an existing private output directory outside the workspace", () => {
    const directory = mkdtempSync(join(tmpdir(), "slopproof-output-dir-"));
    try {
      expect(() =>
        assertSafeProductionOutputDirectory(directory, process.cwd()),
      ).not.toThrow();
      writeProductionEnvironmentFile(
        join(directory, "occupied.env"),
        "x='y'\n",
      );
      expect(() =>
        assertSafeProductionOutputDirectory(directory, process.cwd()),
      ).toThrowError(ProductionEnvironmentError);
      expect(() =>
        assertSafeProductionOutputDirectory(process.cwd(), process.cwd()),
      ).toThrowError(ProductionEnvironmentError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates and stages existing RSA keys without regenerating them", () => {
    const sourceDirectory = mkdtempSync(
      join(tmpdir(), "slopproof-key-source-"),
    );
    const outputDirectory = mkdtempSync(
      join(tmpdir(), "slopproof-key-output-"),
    );
    chmodSync(sourceDirectory, 0o700);
    chmodSync(outputDirectory, 0o700);
    try {
      const github = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const wrapping = generateKeyPairSync("rsa", {
        modulusLength: 3072,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const githubPath = join(sourceDirectory, "github.pem");
      const wrappingPrivatePath = join(sourceDirectory, "wrapping-private.pem");
      const wrappingPublicPath = join(sourceDirectory, "wrapping-public.pem");
      writeFileSync(githubPath, github.privateKey, { mode: 0o600 });
      writeFileSync(wrappingPrivatePath, wrapping.privateKey, { mode: 0o600 });
      writeFileSync(wrappingPublicPath, wrapping.publicKey, { mode: 0o644 });

      installProductionKeyFiles(
        {
          GITHUB_PRIVATE_KEY_PATH: githubPath,
          KEY_WRAPPING_PRIVATE_KEY_PATH: wrappingPrivatePath,
          KEY_WRAPPING_PUBLIC_KEY_PATH: wrappingPublicPath,
        },
        outputDirectory,
      );

      expect(
        statSync(join(outputDirectory, "github-app.pem")).mode & 0o777,
      ).toBe(0o600);
      expect(
        statSync(join(outputDirectory, "wrapping-private.pem")).mode & 0o777,
      ).toBe(0o600);
      expect(
        statSync(join(outputDirectory, "wrapping-public.pem")).mode & 0o777,
      ).toBe(0o644);
      expect(
        readFileSync(join(outputDirectory, "wrapping-private.pem")).byteLength,
      ).toBe(Buffer.byteLength(wrapping.privateKey));
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("installs one complete production artifact set and fails before partial writes", () => {
    const sourceDirectory = mkdtempSync(
      join(tmpdir(), "slopproof-artifact-source-"),
    );
    const outputDirectory = mkdtempSync(
      join(tmpdir(), "slopproof-artifact-output-"),
    );
    const rejectedOutputDirectory = mkdtempSync(
      join(tmpdir(), "slopproof-artifact-rejected-"),
    );
    chmodSync(sourceDirectory, 0o700);
    chmodSync(outputDirectory, 0o700);
    chmodSync(rejectedOutputDirectory, 0o700);
    try {
      const github = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const wrapping = generateKeyPairSync("rsa", {
        modulusLength: 3072,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const githubPath = join(sourceDirectory, "github.pem");
      const wrappingPrivatePath = join(sourceDirectory, "wrapping-private.pem");
      const wrappingPublicPath = join(sourceDirectory, "wrapping-public.pem");
      writeFileSync(githubPath, github.privateKey, { mode: 0o600 });
      writeFileSync(wrappingPrivatePath, wrapping.privateKey, { mode: 0o600 });
      writeFileSync(wrappingPublicPath, wrapping.publicKey, { mode: 0o644 });

      const databasePassword = "p".repeat(32);
      const databaseUrl = `postgres://slopproof:${databasePassword}@postgres:5432/slopproof`;
      const installEnvironment = {
        ...sourceEnvironment,
        DATABASE_URL: databaseUrl,
        GITHUB_PRIVATE_KEY_PATH: githubPath,
        KEY_WRAPPING_PRIVATE_KEY_PATH: wrappingPrivatePath,
        KEY_WRAPPING_PUBLIC_KEY_PATH: wrappingPublicPath,
      };
      const partitions = partitionProductionEnvironment(
        compileProductionEnvironment(installEnvironment),
      );
      installProductionArtifacts(
        installEnvironment,
        outputDirectory,
        partitions,
      );

      expect(readdirSync(outputDirectory).sort()).toEqual([
        "github-app.pem",
        "github-control.env",
        "migrate.env",
        "postgres-password",
        "proxy.env",
        "web.env",
        "worker.env",
        "wrapping-private.pem",
        "wrapping-public.pem",
      ]);
      for (const privateName of [
        "github-app.pem",
        "github-control.env",
        "migrate.env",
        "postgres-password",
        "proxy.env",
        "web.env",
        "worker.env",
        "wrapping-private.pem",
      ]) {
        expect(statSync(join(outputDirectory, privateName)).mode & 0o777).toBe(
          0o600,
        );
      }
      expect(
        statSync(join(outputDirectory, "wrapping-public.pem")).mode & 0o777,
      ).toBe(0o644);
      expect(
        readFileSync(join(outputDirectory, "postgres-password"), "utf8"),
      ).toBe(databasePassword);

      const rejectedPartitions = {
        ...partitions,
        worker: {
          ...partitions.worker,
          GENERATION_API_KEY: `${"g".repeat(32)}'invalid-delimiter`,
        },
      };
      expect(() =>
        installProductionArtifacts(
          installEnvironment,
          rejectedOutputDirectory,
          rejectedPartitions,
        ),
      ).toThrowError(ProductionEnvironmentError);
      expect(readdirSync(rejectedOutputDirectory)).toEqual([]);
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(outputDirectory, { recursive: true, force: true });
      rmSync(rejectedOutputDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});
