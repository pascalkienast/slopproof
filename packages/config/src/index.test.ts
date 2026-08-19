import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadBaseConfig,
  loadGithubControlConfig,
  loadMigrationConfig,
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

const productionWebRuntime = {
  GITHUB_CONTROL_INTERNAL_URL: "http://github-control:4002/healthz",
};

const productionGithubControlRuntime = {
  GITHUB_CONTROL_HOST: "0.0.0.0",
  GITHUB_CONTROL_PORT: "4002",
};

const productionStorage = {
  EVIDENCE_STORAGE_PROVIDER: "s3",
  S3_CONTROL_ENDPOINT: "https://objects.example.com",
  S3_REGION: "eu-central-1",
  S3_BUCKET: "slopproof-evidence",
  S3_ACCESS_KEY_ID: "runtime-access-id",
  S3_SECRET_ACCESS_KEY: "e".repeat(64),
};

const productionWeb = {
  ...productionCore,
  ...productionStorage,
  ...productionWebRuntime,
  GITHUB_ADAPTER: "octokit",
  SESSION_SECRET: "s".repeat(48),
  GITHUB_WEBHOOK_SECRET: "w".repeat(48),
  GITHUB_CLIENT_ID: "Iv1.production-client-id",
  GITHUB_CLIENT_SECRET: "c".repeat(40),
  OAUTH_TRUSTED_PROXY_SECRET: "p".repeat(48),
  S3_PUBLIC_ENDPOINT: "https://uploads.example.com",
  KEY_WRAPPING_PROVIDER: "local",
  KEY_WRAPPING_PUBLIC_KEY_PATH: "/run/secrets/wrapping-public.pem",
  KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH: "/run/secrets/wrapping-public.pem",
  WORKER_INTERNAL_URL: "http://worker:4001",
  WORKER_INTERNAL_SECRET: "i".repeat(48),
};

const productionWorkerRuntime = {
  WORKER_HOST: "0.0.0.0",
  WORKER_PORT: "4001",
  FFMPEG_PATH: "/usr/bin/ffmpeg",
  FFPROBE_PATH: "/usr/bin/ffprobe",
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
      "openrouter generation",
      { GENERATION_PROVIDER: "openrouter" },
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
      ...productionWebRuntime,
      GITHUB_ADAPTER: "octokit",
      SESSION_SECRET: "s".repeat(48),
      GITHUB_WEBHOOK_SECRET: "w".repeat(48),
      GITHUB_CLIENT_ID: "Iv1.production-client-id",
      GITHUB_CLIENT_SECRET: "c".repeat(40),
      OAUTH_TRUSTED_PROXY_SECRET: "p".repeat(48),
      S3_PUBLIC_ENDPOINT: "https://uploads.example.com",
      KEY_WRAPPING_PROVIDER: "local",
      KEY_WRAPPING_PUBLIC_KEY_PATH: "/host/secrets/wrapping-public.pem",
      KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH:
        "/run/secrets/wrapping-public.pem",
      WORKER_INTERNAL_URL: "http://worker:4001",
      WORKER_INTERNAL_SECRET: "i".repeat(48),
    });

    expect(config.GITHUB_ADAPTER).toBe("octokit");
    expect(config.DEMO_MODE).toBe(false);
    expect(config.OAUTH_TRUSTED_PROXY_SECRET).toBe("p".repeat(48));
    expect(config).not.toHaveProperty("GITHUB_APP_ID");
  });

  it("accepts the canonical production worker boundary", () => {
    const config = loadWorkerConfig({
      ...productionCore,
      ...productionStorage,
      ...productionWorkerRuntime,
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

  it("accepts OpenRouter-primary generation and judge with Hetzner transport fallback", () => {
    const config = loadWorkerConfig({
      ...productionCore,
      ...productionStorage,
      ...productionWorkerRuntime,
      GITHUB_ADAPTER: "octokit",
      KEY_WRAPPING_PROVIDER: "local",
      KEY_WRAPPING_PRIVATE_KEY_PATH: "/host/secrets/wrapping-private.pem",
      KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH:
        "/run/secrets/wrapping-private.pem",
      WORKER_INTERNAL_SECRET: "i".repeat(48),
      PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString("base64"),
      GENERATION_PROVIDER: "openrouter",
      GENERATION_BASE_URL: "https://openrouter.ai/api/v1",
      GENERATION_API_KEY: "g".repeat(40),
      LEARNING_MODEL: "xiaomi/mimo-v2.5",
      PRACTICE_MODEL: "xiaomi/mimo-v2.5",
      PROOF_QUESTION_MODEL: "xiaomi/mimo-v2.5",
      GENERATION_FALLBACK_BASE_URL: "https://inference.example/api/v1",
      GENERATION_FALLBACK_API_KEY: "h".repeat(40),
      LEARNING_FALLBACK_MODEL: "hetzner-learning",
      PRACTICE_FALLBACK_MODEL: "hetzner-practice",
      PROOF_QUESTION_FALLBACK_MODEL: "hetzner-proof",
      TRANSCRIPTION_PROVIDER: "openrouter",
      TRANSCRIPTION_BASE_URL: "https://transcription.example/api/v1",
      TRANSCRIPTION_API_KEY: "t".repeat(40),
      TRANSCRIPTION_MODEL: "transcription-model",
      MULTIMODAL_JUDGE_PROVIDER: "openrouter",
      JUDGE_BASE_URL: "https://openrouter.ai/api/v1",
      JUDGE_API_KEY: "j".repeat(40),
      JUDGE_MODEL: "xiaomi/mimo-v2.5",
      JUDGE_FALLBACK_MODEL: "xiaomi/mimo-v2.5",
      JUDGE_TRANSPORT_FALLBACK_BASE_URL: "https://inference.example/api/v1",
      JUDGE_TRANSPORT_FALLBACK_API_KEY: "k".repeat(40),
      JUDGE_TRANSPORT_FALLBACK_MODEL: "hetzner-judge",
      JUDGE_TRANSPORT_FALLBACK_VISION_MODEL: "hetzner-vision",
    });

    expect(config.GENERATION_PROVIDER).toBe("openrouter");
    expect(config.MULTIMODAL_JUDGE_PROVIDER).toBe("openrouter");
    expect(config.LEARNING_MODEL).toBe("xiaomi/mimo-v2.5");
    expect(config.GENERATION_FALLBACK_BASE_URL).toBe(
      "https://inference.example/api/v1",
    );
    expect(config.JUDGE_TRANSPORT_FALLBACK_MODEL).toBe("hetzner-judge");
  });

  it("rejects production OpenRouter generation without a Hetzner transport fallback", () => {
    expectConfigurationFields(
      () =>
        loadWorkerConfig({
          ...productionCore,
          ...productionStorage,
          ...productionWorkerRuntime,
          GITHUB_ADAPTER: "octokit",
          KEY_WRAPPING_PROVIDER: "local",
          KEY_WRAPPING_PRIVATE_KEY_PATH: "/host/secrets/wrapping-private.pem",
          KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH:
            "/run/secrets/wrapping-private.pem",
          WORKER_INTERNAL_SECRET: "i".repeat(48),
          PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString("base64"),
          GENERATION_PROVIDER: "openrouter",
          GENERATION_BASE_URL: "https://openrouter.ai/api/v1",
          GENERATION_API_KEY: "g".repeat(40),
          LEARNING_MODEL: "xiaomi/mimo-v2.5",
          PRACTICE_MODEL: "xiaomi/mimo-v2.5",
          PROOF_QUESTION_MODEL: "xiaomi/mimo-v2.5",
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
      "GENERATION_FALLBACK_BASE_URL",
      "GENERATION_FALLBACK_API_KEY",
      "LEARNING_FALLBACK_MODEL",
      "PRACTICE_FALLBACK_MODEL",
      "PROOF_QUESTION_FALLBACK_MODEL",
    );
  });

  it("rejects leftover Hetzner fallback fields when generation stays Hetzner-only", () => {
    expectConfigurationFields(
      () =>
        loadWorkerConfig({
          ...localWorker,
          GENERATION_PROVIDER: "hetzner",
          GENERATION_BASE_URL: "https://inference.example/api/v1",
          GENERATION_API_KEY: "g".repeat(40),
          LEARNING_MODEL: "text-model",
          PRACTICE_MODEL: "text-model",
          PROOF_QUESTION_MODEL: "text-model",
          GENERATION_FALLBACK_BASE_URL: "https://inference.example/api/v1",
        }),
      "GENERATION_FALLBACK_BASE_URL",
    );
  });

  it.each([
    [
      "path-bearing control endpoint",
      {
        S3_CONTROL_ENDPOINT: "https://objects.example.com/slopproof-evidence",
      },
      "S3_CONTROL_ENDPOINT",
    ],
    [
      "query-bearing control endpoint",
      {
        S3_CONTROL_ENDPOINT: "https://objects.example.com?region=eu-central-1",
      },
      "S3_CONTROL_ENDPOINT",
    ],
    [
      "userinfo-bearing control endpoint",
      {
        S3_CONTROL_ENDPOINT: "https://operator@objects.example.com",
      },
      "S3_CONTROL_ENDPOINT",
    ],
    [
      "port-bearing control endpoint",
      {
        S3_CONTROL_ENDPOINT: "https://objects.example.com:444",
      },
      "S3_CONTROL_ENDPOINT",
    ],
    [
      "HTTP control endpoint",
      { S3_CONTROL_ENDPOINT: "http://objects.example.com" },
      "S3_CONTROL_ENDPOINT",
    ],
    [
      "loopback control endpoint",
      { S3_CONTROL_ENDPOINT: "https://127.0.0.1" },
      "S3_CONTROL_ENDPOINT",
    ],
    ["malformed region", { S3_REGION: "eu central 1" }, "S3_REGION"],
    ["malformed bucket", { S3_BUCKET: "SlopProof_Evidence" }, "S3_BUCKET"],
  ])(
    "rejects %s in the production worker storage identity",
    (_name, override, field) => {
      expectConfigurationFields(
        () =>
          loadWorkerConfig({
            ...localWorker,
            ...productionCore,
            ...productionStorage,
            ...productionWorkerRuntime,
            GITHUB_ADAPTER: "octokit",
            KEY_WRAPPING_PROVIDER: "local",
            KEY_WRAPPING_PRIVATE_KEY_PATH: "/host/secrets/wrapping-private.pem",
            KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH:
              "/run/secrets/wrapping-private.pem",
            WORKER_INTERNAL_SECRET: "i".repeat(48),
            PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString(
              "base64",
            ),
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
            ...override,
          }),
        field,
      );
    },
  );

  it.each([
    [
      "HTTP public endpoint",
      { S3_PUBLIC_ENDPOINT: "http://objects.example.com" },
    ],
    [
      "path-bearing public endpoint",
      { S3_PUBLIC_ENDPOINT: "https://objects.example.com/slopproof-evidence" },
    ],
    ["loopback public endpoint", { S3_PUBLIC_ENDPOINT: "https://localhost" }],
  ])("rejects %s in the production web storage identity", (_name, override) => {
    expectConfigurationFields(
      () => loadWebConfig({ ...productionWeb, ...override }),
      "S3_PUBLIC_ENDPOINT",
    );
  });

  it.each([
    ["loopback bind", { WORKER_HOST: "127.0.0.1" }, "WORKER_HOST"],
    ["wrong port", { WORKER_PORT: "4002" }, "WORKER_PORT"],
    ["untrusted ffmpeg", { FFMPEG_PATH: "ffmpeg" }, "FFMPEG_PATH"],
    ["untrusted ffprobe", { FFPROBE_PATH: "ffprobe" }, "FFPROBE_PATH"],
  ])(
    "rejects %s in the production worker runtime",
    (_name, override, field) => {
      expectConfigurationFields(
        () =>
          loadWorkerConfig({
            ...localWorker,
            ...productionCore,
            ...productionStorage,
            ...productionWorkerRuntime,
            ...override,
          }),
        field,
      );
    },
  );

  it("rejects judge model identifiers that cannot round-trip through persistence", () => {
    expect(() =>
      loadWorkerConfig({
        ...localWorker,
        MULTIMODAL_JUDGE_PROVIDER: "hetzner",
        JUDGE_BASE_URL: "https://inference.example/api/v1",
        JUDGE_API_KEY: "j".repeat(40),
        JUDGE_MODEL: "m".repeat(101),
        JUDGE_FALLBACK_MODEL: "vision-model",
      }),
    ).toThrow();
  });

  it("accepts the production GitHub-control file-secret boundary", () => {
    const config = loadGithubControlConfig({
      ...productionCore,
      ...productionGithubControlRuntime,
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
          ...productionWebRuntime,
          GITHUB_ADAPTER: "octokit",
          SESSION_SECRET: "s".repeat(48),
          GITHUB_WEBHOOK_SECRET: "w".repeat(48),
          GITHUB_CLIENT_ID: "Iv1.production-client-id",
          GITHUB_CLIENT_SECRET: "c".repeat(40),
          OAUTH_TRUSTED_PROXY_SECRET: "p".repeat(48),
          GITHUB_PRIVATE_KEY_PATH: "/must-not-enter-web/github.pem",
          S3_PUBLIC_ENDPOINT: "https://uploads.example.com",
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
          ...productionGithubControlRuntime,
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
          ...productionGithubControlRuntime,
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
      "database outside the isolated Compose network",
      {
        DATABASE_URL: `postgres://slopproof:${"d".repeat(32)}@database.example:5432/slopproof`,
      },
      "DATABASE_URL",
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
    [
      "public GitHub Control health destination",
      { GITHUB_CONTROL_INTERNAL_URL: "https://attacker.example/healthz" },
      "GITHUB_CONTROL_INTERNAL_URL",
    ],
    [
      "missing GitHub Control health destination",
      { GITHUB_CONTROL_INTERNAL_URL: undefined },
      "GITHUB_CONTROL_INTERNAL_URL",
    ],
    [
      "missing trusted OAuth proxy boundary",
      { OAUTH_TRUSTED_PROXY_SECRET: undefined },
      "OAUTH_TRUSTED_PROXY_SECRET",
    ],
    [
      "malformed trusted OAuth proxy secret",
      { OAUTH_TRUSTED_PROXY_SECRET: "contains spaces and punctuation!" },
      "OAUTH_TRUSTED_PROXY_SECRET",
    ],
  ])("rejects %s in the production web profile", (_name, override, field) => {
    expectConfigurationFields(
      () =>
        loadWebConfig({
          ...productionCore,
          ...productionStorage,
          ...productionWebRuntime,
          GITHUB_ADAPTER: "octokit",
          SESSION_SECRET: "s".repeat(48),
          GITHUB_WEBHOOK_SECRET: "w".repeat(48),
          GITHUB_CLIENT_ID: "Iv1.production-client-id",
          GITHUB_CLIENT_SECRET: "c".repeat(40),
          OAUTH_TRUSTED_PROXY_SECRET: "p".repeat(48),
          S3_PUBLIC_ENDPOINT: "https://uploads.example.com",
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

  it.each([
    [
      "loopback bind",
      { GITHUB_CONTROL_HOST: "127.0.0.1" },
      "GITHUB_CONTROL_HOST",
    ],
    ["wrong port", { GITHUB_CONTROL_PORT: "4003" }, "GITHUB_CONTROL_PORT"],
  ])(
    "rejects %s in the production GitHub Control runtime",
    (_name, override, field) => {
      expectConfigurationFields(
        () =>
          loadGithubControlConfig({
            ...productionCore,
            ...productionGithubControlRuntime,
            GITHUB_ADAPTER: "octokit",
            GITHUB_APP_ID: "123456",
            GITHUB_PRIVATE_KEY_PATH: "/host/secrets/github-app.pem",
            GITHUB_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/github-app.pem",
            ...override,
          }),
        field,
      );
    },
  );

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

  it("loads the compiler format from a protected process file", () => {
    const fixture = createEnvironmentFile("web.env", productionWeb, 0o640);
    try {
      const config = loadWebConfig({
        SLOPPROOF_ENV_FILE: fixture.path,
      });
      expect(config.DEPLOYMENT_PROFILE).toBe("production");
      expect(config.GITHUB_ADAPTER).toBe("octokit");
      expect(config.SESSION_SECRET).toBe(productionWeb.SESSION_SECRET);
    } finally {
      fixture.cleanup();
    }
  });

  it("loads exact production worker and GitHub-control process files", () => {
    const worker = createEnvironmentFile("worker.env", {
      ...localWorker,
      ...productionCore,
      ...productionStorage,
      ...productionWorkerRuntime,
      GITHUB_ADAPTER: "octokit",
      KEY_WRAPPING_PRIVATE_KEY_PATH: "/run/secrets/wrapping-private.pem",
      KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH:
        "/run/secrets/wrapping-private.pem",
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
    });
    const githubControl = createEnvironmentFile("github-control.env", {
      ...productionCore,
      ...productionGithubControlRuntime,
      GITHUB_ADAPTER: "octokit",
      GITHUB_APP_ID: "123456",
      GITHUB_PRIVATE_KEY_PATH: "/run/secrets/github-app.pem",
      GITHUB_PRIVATE_KEY_CONTAINER_PATH: "/run/secrets/github-app.pem",
    });
    try {
      expect(
        loadWorkerConfig({ SLOPPROOF_ENV_FILE: worker.path })
          .GENERATION_PROVIDER,
      ).toBe("hetzner");
      expect(
        loadGithubControlConfig({
          SLOPPROOF_ENV_FILE: githubControl.path,
        }).GITHUB_APP_ID,
      ).toBe("123456");
      expectConfigurationFields(
        () => loadWebConfig({ SLOPPROOF_ENV_FILE: worker.path }),
        "SLOPPROOF_ENV_FILE",
      );
    } finally {
      worker.cleanup();
      githubControl.cleanup();
    }
  });

  it("rejects ambient values that conflict with the process file", () => {
    const fixture = createEnvironmentFile("web.env", productionWeb);
    try {
      expectConfigurationFields(
        () =>
          loadWebConfig({
            SLOPPROOF_ENV_FILE: fixture.path,
            NODE_ENV: "test",
          }),
        "NODE_ENV",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects unknown fields and malformed compiler syntax", () => {
    const unknown = createEnvironmentFile("web.env", {
      ...productionWeb,
      GENERATION_API_KEY: "must-not-cross-the-process-boundary",
    });
    const malformed = createRawEnvironmentFile(
      "web.env",
      "NODE_ENV=production\n",
    );
    try {
      expectConfigurationFields(
        () => loadWebConfig({ SLOPPROOF_ENV_FILE: unknown.path }),
        "SLOPPROOF_ENV_FILE",
      );
      expectConfigurationFields(
        () => loadWebConfig({ SLOPPROOF_ENV_FILE: malformed.path }),
        "SLOPPROOF_ENV_FILE",
      );
      expectConfigurationFields(
        () => loadWebConfig({ SLOPPROOF_ENV_FILE: "web.env" }),
        "SLOPPROOF_ENV_FILE",
      );
    } finally {
      unknown.cleanup();
      malformed.cleanup();
    }
  });

  it("rejects duplicate fields, symlinks, oversized files, and unsafe modes", () => {
    const duplicate = createRawEnvironmentFile(
      "web.env",
      "NODE_ENV='production'\nNODE_ENV='production'\n",
    );
    const worldReadable = createEnvironmentFile(
      "web.env",
      productionWeb,
      0o644,
    );
    const executable = createEnvironmentFile("web.env", productionWeb, 0o700);
    const oversized = createRawEnvironmentFile(
      "web.env",
      `NODE_ENV='${"a".repeat(64 * 1024)}'\n`,
    );
    const target = createEnvironmentFile("web.env.target", productionWeb);
    const symlinkPath = join(target.directory, "web.env");
    symlinkSync(target.path, symlinkPath);
    try {
      for (const path of [
        duplicate.path,
        worldReadable.path,
        executable.path,
        oversized.path,
        symlinkPath,
      ]) {
        expectConfigurationFields(
          () => loadWebConfig({ SLOPPROOF_ENV_FILE: path }),
          "SLOPPROOF_ENV_FILE",
        );
      }
    } finally {
      duplicate.cleanup();
      worldReadable.cleanup();
      executable.cleanup();
      oversized.cleanup();
      target.cleanup();
    }
  });

  it("loads only the database boundary for migrations", () => {
    const local = loadMigrationConfig({ DATABASE_URL: core.DATABASE_URL });
    expect(local.DEPLOYMENT_PROFILE).toBe("local");
    expect(local.NODE_ENV).toBe("development");

    const fixture = createEnvironmentFile("migrate.env", {
      NODE_ENV: "production",
      DEPLOYMENT_PROFILE: "production",
      DATABASE_URL: productionCore.DATABASE_URL,
    });
    try {
      const production = loadMigrationConfig({
        SLOPPROOF_ENV_FILE: fixture.path,
      });
      expect(production.DEPLOYMENT_PROFILE).toBe("production");
      expect(production.DATABASE_URL).toBe(productionCore.DATABASE_URL);
    } finally {
      fixture.cleanup();
    }
  });
});

type EnvironmentFileFixture = Readonly<{
  cleanup: () => void;
  directory: string;
  path: string;
}>;

function createEnvironmentFile(
  fileName: string,
  environment: Readonly<Record<string, string | undefined>>,
  mode = 0o600,
): EnvironmentFileFixture {
  const contents = `${Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}='${value}'`)
    .join("\n")}\n`;
  return createRawEnvironmentFile(fileName, contents, mode);
}

function createRawEnvironmentFile(
  fileName: string,
  contents: string,
  mode = 0o600,
): EnvironmentFileFixture {
  const directory = mkdtempSync(join(tmpdir(), "slopproof-config-test-"));
  const path = join(directory, fileName);
  writeFileSync(path, contents, { encoding: "utf8", mode });
  chmodSync(path, mode);
  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    directory,
    path,
  };
}

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
