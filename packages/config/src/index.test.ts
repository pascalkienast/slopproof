import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadBaseConfig,
  loadGithubControlConfig,
  loadWebConfig,
  loadWorkerConfig,
} from "./index";

const core = {
  NODE_ENV: "test",
  DEPLOYMENT_PROFILE: "local",
  APP_BASE_URL: "https://slopproof.test",
  DATABASE_URL: "postgres://slopproof:slopproof@localhost:5432/slopproof",
  LOG_LEVEL: "info",
  DEMO_MODE: "true",
  DEMO_FAKE_MEDIA: "true",
};

const storage = {
  EVIDENCE_STORAGE_PROVIDER: "s3",
  S3_CONTROL_ENDPOINT: "http://object-store:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "slopproof-evidence",
  S3_ACCESS_KEY_ID: "local",
  S3_SECRET_ACCESS_KEY: "local-secret",
};

const localWeb = {
  ...core,
  ...storage,
  GITHUB_ADAPTER: "fake",
  SESSION_SECRET: "s".repeat(32),
  GITHUB_WEBHOOK_SECRET: "w".repeat(32),
  GITHUB_CLIENT_ID: "fake-local",
  GITHUB_CLIENT_SECRET: "fake-local-never-used",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  KEY_WRAPPING_PROVIDER: "local",
  KEY_WRAPPING_PUBLIC_KEY_PATH: "/keys/public.pem",
  WORKER_INTERNAL_URL: "http://worker:4001",
  WORKER_INTERNAL_SECRET: "i".repeat(32),
};

const localWorker = {
  ...core,
  ...storage,
  GITHUB_ADAPTER: "fake",
  KEY_WRAPPING_PROVIDER: "local",
  KEY_WRAPPING_PRIVATE_KEY_PATH: "/keys/private.pem",
  WORKER_INTERNAL_SECRET: "i".repeat(32),
  PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString("base64"),
  GENERATION_PROVIDER: "fake",
  TRANSCRIPTION_PROVIDER: "fake",
  MULTIMODAL_JUDGE_PROVIDER: "fake",
};

const productionCore = {
  NODE_ENV: "production",
  DEPLOYMENT_PROFILE: "production",
  APP_BASE_URL: "https://slopproof.example",
  DATABASE_URL: `postgres://slopproof:${"d".repeat(32)}@postgres:5432/slopproof`,
  LOG_LEVEL: "info",
  DEMO_MODE: "false",
  DEMO_FAKE_MEDIA: "false",
};

const productionStorage = {
  EVIDENCE_STORAGE_PROVIDER: "s3",
  S3_CONTROL_ENDPOINT: "https://account.example-object-storage.com",
  S3_REGION: "auto",
  S3_BUCKET: "slopproof-eu",
  S3_ACCESS_KEY_ID: "runtime-access-id",
  S3_SECRET_ACCESS_KEY: "e".repeat(64),
};

describe("process-scoped configuration", () => {
  it("keeps the optimized local Compose profile compatible with fake adapters", () => {
    const web = loadWebConfig({
      ...localWeb,
      NODE_ENV: "production",
      APP_BASE_URL: "http://127.0.0.1:3000",
    });
    const worker = loadWorkerConfig({
      ...localWorker,
      NODE_ENV: "production",
      APP_BASE_URL: "http://127.0.0.1:3000",
    });

    expect(web.DEPLOYMENT_PROFILE).toBe("local");
    expect(web.GITHUB_ADAPTER).toBe("fake");
    expect(worker.GENERATION_PROVIDER).toBe("fake");
    expect(worker.WORKER_HOST).toBe("127.0.0.1");
  });

  it("requires an explicit deployment profile", () => {
    const { DEPLOYMENT_PROFILE: _profile, ...withoutProfile } = localWeb;
    expectConfigurationFields(
      () => loadWebConfig(withoutProfile),
      "DEPLOYMENT_PROFILE",
    );
    expectConfigurationFields(
      () =>
        loadWebConfig({
          ...localWeb,
          DEPLOYMENT_PROFILE: "prodution",
        }),
      "DEPLOYMENT_PROFILE",
    );
  });

  it.each([
    [
      "public origin",
      { APP_BASE_URL: "https://slopproof.example" },
      "APP_BASE_URL",
    ],
    ["disabled demo", { DEMO_MODE: "false" }, "DEMO_MODE"],
    ["real GitHub adapter", { GITHUB_ADAPTER: "octokit" }, "GITHUB_ADAPTER"],
  ])(
    "rejects %s in an optimized local web process",
    (_name, override, field) => {
      expectConfigurationFields(
        () =>
          loadWebConfig({
            ...localWeb,
            NODE_ENV: "production",
            APP_BASE_URL: "http://127.0.0.1:3000",
            ...override,
          }),
        field,
      );
    },
  );

  it.each([
    [
      "real generation",
      { GENERATION_PROVIDER: "hetzner" },
      "GENERATION_PROVIDER",
    ],
    [
      "real transcription",
      { TRANSCRIPTION_PROVIDER: "openrouter" },
      "TRANSCRIPTION_PROVIDER",
    ],
    [
      "real judge",
      { MULTIMODAL_JUDGE_PROVIDER: "hetzner" },
      "MULTIMODAL_JUDGE_PROVIDER",
    ],
  ])(
    "rejects %s in an optimized local worker process",
    (_name, override, field) => {
      expectConfigurationFields(
        () =>
          loadWorkerConfig({
            ...localWorker,
            NODE_ENV: "production",
            APP_BASE_URL: "http://127.0.0.1:3000",
            ...override,
          }),
        field,
      );
    },
  );

  it("strips secrets that do not belong to the selected process", () => {
    const web = loadWebConfig({
      ...localWeb,
      GENERATION_API_KEY: "worker-only-generation-secret",
      GITHUB_PRIVATE_KEY_PATH: "/private/github.pem",
      KEY_WRAPPING_PRIVATE_KEY_PATH: "/private/wrapping.pem",
    });
    const worker = loadWorkerConfig({
      ...localWorker,
      GITHUB_CLIENT_SECRET: "web-only-client-secret",
      GITHUB_WEBHOOK_SECRET: "web-only-webhook-secret".repeat(2),
      GITHUB_PRIVATE_KEY_PATH: "/private/github.pem",
    });
    const githubControl = loadGithubControlConfig({
      ...core,
      GITHUB_ADAPTER: "fake",
      GITHUB_CLIENT_SECRET: "web-only-client-secret",
      GENERATION_API_KEY: "worker-only-generation-secret",
      S3_SECRET_ACCESS_KEY: "storage-secret",
    });

    expect(web).not.toHaveProperty("GENERATION_API_KEY");
    expect(web).not.toHaveProperty("GITHUB_PRIVATE_KEY_PATH");
    expect(web).not.toHaveProperty("KEY_WRAPPING_PRIVATE_KEY_PATH");
    expect(worker).not.toHaveProperty("GITHUB_CLIENT_SECRET");
    expect(worker).not.toHaveProperty("GITHUB_WEBHOOK_SECRET");
    expect(worker).not.toHaveProperty("GITHUB_PRIVATE_KEY_PATH");
    expect(githubControl).not.toHaveProperty("GITHUB_CLIENT_SECRET");
    expect(githubControl).not.toHaveProperty("GENERATION_API_KEY");
    expect(githubControl).not.toHaveProperty("S3_SECRET_ACCESS_KEY");
  });

  it("loads a secret-free base config and strips process fields", () => {
    const base = loadBaseConfig({
      ...core,
      SESSION_SECRET: "must-be-stripped",
    });
    expect(base.DEPLOYMENT_PROFILE).toBe("local");
    expect(base).not.toHaveProperty("SESSION_SECRET");
  });

  it("accepts the canonical production web boundary", () => {
    const config = loadWebConfig({
      ...productionCore,
      ...productionStorage,
      GITHUB_ADAPTER: "octokit",
      SESSION_SECRET: "s".repeat(48),
      GITHUB_WEBHOOK_SECRET: "w".repeat(48),
      GITHUB_CLIENT_ID: "Iv1.production-client-id",
      GITHUB_CLIENT_SECRET: "c".repeat(40),
      S3_PUBLIC_ENDPOINT: productionStorage.S3_CONTROL_ENDPOINT,
      KEY_WRAPPING_PROVIDER: "local",
      KEY_WRAPPING_PUBLIC_KEY_PATH: "/host/secrets/wrapping-public.pem",
      KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH:
        "/run/secrets/wrapping-public.pem",
      WORKER_INTERNAL_URL: "http://worker:4001",
      WORKER_INTERNAL_SECRET: "i".repeat(48),
    });

    expect(config.GITHUB_ADAPTER).toBe("octokit");
    expect(config.DEMO_MODE).toBe(false);
    expect(config).not.toHaveProperty("GITHUB_APP_ID");
  });

  it("accepts the canonical production worker boundary", () => {
    const config = loadWorkerConfig({
      ...productionCore,
      ...productionStorage,
      GITHUB_ADAPTER: "octokit",
      KEY_WRAPPING_PROVIDER: "local",
      KEY_WRAPPING_PRIVATE_KEY_PATH: "/host/secrets/wrapping-private.pem",
      KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH:
        "/run/secrets/wrapping-private.pem",
      WORKER_INTERNAL_SECRET: "i".repeat(48),
      PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString("base64"),
      GENERATION_PROVIDER: "hetzner",
      GENERATION_BASE_URL: "https://inference.example/api/v1",
      GENERATION_API_KEY: "g".repeat(40),
      LEARNING_MODEL: "text-model",
      PRACTICE_MODEL: "text-model",
      PROOF_QUESTION_MODEL: "text-model",
      TRANSCRIPTION_PROVIDER: "openrouter",
      TRANSCRIPTION_BASE_URL: "https://transcription.example/api/v1",
      TRANSCRIPTION_API_KEY: "t".repeat(40),
      TRANSCRIPTION_MODEL: "transcription-model",
      MULTIMODAL_JUDGE_PROVIDER: "hetzner",
      JUDGE_BASE_URL: "https://inference.example/api/v1",
      JUDGE_API_KEY: "j".repeat(40),
      JUDGE_MODEL: "judge-model",
      JUDGE_FALLBACK_MODEL: "vision-model",
    });

    expect(config.TRANSCRIPTION_PROVIDER).toBe("openrouter");
    expect(config.MULTIMODAL_JUDGE_PROVIDER).toBe("hetzner");
    expect(config).not.toHaveProperty("GITHUB_CLIENT_SECRET");
  });

  it("accepts the production GitHub-control file-secret boundary", () => {
    const config = loadGithubControlConfig({
      ...productionCore,
      GITHUB_ADAPTER: "octokit",
      GITHUB_APP_ID: "123456",
      GITHUB_PRIVATE_KEY_PATH: "/host/secrets/github-app.pem",
      GITHUB_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/github-app.pem",
    });

    expect(config.GITHUB_APP_ID).toBe("123456");
    expect(config.GITHUB_PRIVATE_KEY_PATH).toBe("/host/secrets/github-app.pem");
    expect(config).not.toHaveProperty("GITHUB_PRIVATE_KEY");
  });

  it.each([
    [
      "web",
      () =>
        loadWebConfig({
          ...productionCore,
          ...productionStorage,
          GITHUB_ADAPTER: "octokit",
          SESSION_SECRET: "s".repeat(48),
          GITHUB_WEBHOOK_SECRET: "w".repeat(48),
          GITHUB_CLIENT_ID: "Iv1.production-client-id",
          GITHUB_CLIENT_SECRET: "c".repeat(40),
          GITHUB_PRIVATE_KEY_PATH: "/must-not-enter-web/github.pem",
          S3_PUBLIC_ENDPOINT: productionStorage.S3_CONTROL_ENDPOINT,
          KEY_WRAPPING_PROVIDER: "local",
          KEY_WRAPPING_PUBLIC_KEY_PATH: "/host/public.pem",
          KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH: "/run/secrets/public.pem",
          WORKER_INTERNAL_URL: "http://worker:4001",
          WORKER_INTERNAL_SECRET: "i".repeat(48),
        }),
      "GITHUB_PRIVATE_KEY_PATH",
    ],
    [
      "worker",
      () =>
        loadWorkerConfig({
          ...localWorker,
          ...productionCore,
          ...productionStorage,
          GITHUB_ADAPTER: "octokit",
          GITHUB_WEBHOOK_SECRET: "must-not-enter-worker".repeat(2),
          KEY_WRAPPING_PRIVATE_KEY_PATH: "/host/private.pem",
          KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/private.pem",
          WORKER_INTERNAL_SECRET: "i".repeat(48),
          GENERATION_PROVIDER: "hetzner",
          GENERATION_BASE_URL: "https://inference.example/api/v1",
          GENERATION_API_KEY: "g".repeat(40),
          LEARNING_MODEL: "text-model",
          PRACTICE_MODEL: "text-model",
          PROOF_QUESTION_MODEL: "text-model",
          TRANSCRIPTION_PROVIDER: "openrouter",
          TRANSCRIPTION_BASE_URL: "https://transcription.example/api/v1",
          TRANSCRIPTION_API_KEY: "t".repeat(40),
          TRANSCRIPTION_MODEL: "transcription-model",
          MULTIMODAL_JUDGE_PROVIDER: "hetzner",
          JUDGE_BASE_URL: "https://inference.example/api/v1",
          JUDGE_API_KEY: "j".repeat(40),
          JUDGE_MODEL: "judge-model",
          JUDGE_FALLBACK_MODEL: "vision-model",
        }),
      "GITHUB_WEBHOOK_SECRET",
    ],
    [
      "GitHub control",
      () =>
        loadGithubControlConfig({
          ...productionCore,
          GITHUB_ADAPTER: "octokit",
          GITHUB_APP_ID: "123456",
          GITHUB_PRIVATE_KEY_PATH: "/host/secrets/github-app.pem",
          GITHUB_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/github-app.pem",
          TRANSCRIPTION_API_KEY: "must-not-enter-github-control",
        }),
      "TRANSCRIPTION_API_KEY",
    ],
  ])(
    "rejects cross-process secret exposure in production %s",
    (_name, load, field) => {
      expectConfigurationFields(load, field);
    },
  );

  it("rejects legacy shared and inline secret names in production", () => {
    expectConfigurationFields(
      () =>
        loadGithubControlConfig({
          ...productionCore,
          GITHUB_ADAPTER: "octokit",
          GITHUB_APP_ID: "123456",
          GITHUB_PRIVATE_KEY_PATH: "/host/secrets/github-app.pem",
          GITHUB_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/github-app.pem",
          GITHUB_PRIVATE_KEY: "inline-material-is-forbidden",
          PROVIDER_API_KEY: "shared-provider-secret-is-forbidden",
        }),
      "GITHUB_PRIVATE_KEY",
      "PROVIDER_API_KEY",
    );
  });

  it.each([
    ["fake GitHub", { GITHUB_ADAPTER: "fake" }, "GITHUB_ADAPTER"],
    ["demo mode", { DEMO_MODE: "true" }, "DEMO_MODE"],
    [
      "HTTP app URL",
      { APP_BASE_URL: "http://slopproof.example" },
      "APP_BASE_URL",
    ],
    [
      "loopback storage",
      { S3_PUBLIC_ENDPOINT: "https://127.0.0.1:9000" },
      "S3_PUBLIC_ENDPOINT",
    ],
    [
      "placeholder session secret",
      { SESSION_SECRET: "local-session-secret-change-me-000000" },
      "SESSION_SECRET",
    ],
    [
      "public worker capability destination",
      { WORKER_INTERNAL_URL: "https://attacker.example" },
      "WORKER_INTERNAL_URL",
    ],
  ])("rejects %s in the production web profile", (_name, override, field) => {
    expectConfigurationFields(
      () =>
        loadWebConfig({
          ...productionCore,
          ...productionStorage,
          GITHUB_ADAPTER: "octokit",
          SESSION_SECRET: "s".repeat(48),
          GITHUB_WEBHOOK_SECRET: "w".repeat(48),
          GITHUB_CLIENT_ID: "Iv1.production-client-id",
          GITHUB_CLIENT_SECRET: "c".repeat(40),
          S3_PUBLIC_ENDPOINT: productionStorage.S3_CONTROL_ENDPOINT,
          KEY_WRAPPING_PROVIDER: "local",
          KEY_WRAPPING_PUBLIC_KEY_PATH: "/host/public.pem",
          KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH: "/run/secrets/public.pem",
          WORKER_INTERNAL_URL: "http://worker:4001",
          WORKER_INTERNAL_SECRET: "i".repeat(48),
          ...override,
        }),
      field,
    );
  });

  it("rejects fake or incomplete providers in the production worker profile", () => {
    expectConfigurationFields(
      () =>
        loadWorkerConfig({
          ...productionCore,
          ...productionStorage,
          GITHUB_ADAPTER: "octokit",
          KEY_WRAPPING_PROVIDER: "local",
          KEY_WRAPPING_PRIVATE_KEY_PATH: "/host/private.pem",
          KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/private.pem",
          WORKER_INTERNAL_SECRET: "i".repeat(48),
          PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString("base64"),
        }),
      "GENERATION_PROVIDER",
      "TRANSCRIPTION_PROVIDER",
      "MULTIMODAL_JUDGE_PROVIDER",
    );
  });

  it("requires App JWT material only from a file in Octokit control mode", () => {
    expectConfigurationFields(
      () =>
        loadGithubControlConfig({
          ...core,
          GITHUB_ADAPTER: "octokit",
          GITHUB_APP_ID: "not-numeric",
          GITHUB_PRIVATE_KEY: "inline-private-key-must-be-ignored",
        }),
      "GITHUB_APP_ID",
      "GITHUB_PRIVATE_KEY_PATH",
    );
  });

  it("supports optional KMS wrapping without making KMS mandatory", () => {
    const config = loadWorkerConfig({
      ...localWorker,
      KEY_WRAPPING_PROVIDER: "kms",
      KEY_WRAPPING_PRIVATE_KEY_PATH: undefined,
      KMS_PROVIDER: "example-kms",
      KMS_KEY_ID: "wrapping-key-v1",
    });
    expect(config.KEY_WRAPPING_PROVIDER).toBe("kms");
  });

  it("accepts a canonical 32-byte provider payload key only in the worker", () => {
    expect(
      Buffer.from(
        loadWorkerConfig(localWorker).PROVIDER_PAYLOAD_KEY_BASE64,
        "base64",
      ),
    ).toHaveLength(32);
    expect(() =>
      loadWorkerConfig({
        ...localWorker,
        PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(31, 112).toString("base64"),
      }),
    ).toThrowError(ConfigurationError);
  });

  it("reports field names but never secret values", () => {
    const secret = "do-not-echo-this-secret";
    try {
      loadWebConfig({ SESSION_SECRET: secret });
      throw new Error("expected invalid configuration");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain(secret);
    }
  });
});

function expectConfigurationFields(
  callback: () => unknown,
  ...fields: string[]
): void {
  try {
    callback();
    throw new Error("expected invalid configuration");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    if (!(error instanceof ConfigurationError)) return;
    for (const field of fields) expect(error.fields).toContain(field);
  }
}
