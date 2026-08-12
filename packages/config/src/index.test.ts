import { describe, expect, it } from "vitest";
import { ConfigurationError, loadWebConfig, loadWorkerConfig } from "./index";

const common = {
  NODE_ENV: "test",
  APP_BASE_URL: "https://slopproof.test",
  DATABASE_URL: "postgres://slopproof:slopproof@localhost:5432/slopproof",
  GITHUB_ADAPTER: "fake",
  EVIDENCE_STORAGE_PROVIDER: "s3",
  S3_REGION: "us-east-1",
  S3_BUCKET: "slopproof-evidence",
  S3_ACCESS_KEY_ID: "local",
  S3_SECRET_ACCESS_KEY: "local-secret",
  KEY_WRAPPING_PROVIDER: "local",
  TRANSCRIPTION_PROVIDER: "fake",
  MULTIMODAL_JUDGE_PROVIDER: "fake",
  LOG_LEVEL: "info",
  DEMO_MODE: "true",
  DEMO_FAKE_MEDIA: "true",
};

describe("configuration", () => {
  it("never requires a private wrapping key in the web process", () => {
    const config = loadWebConfig({
      ...common,
      SESSION_SECRET: "s".repeat(32),
      GITHUB_APP_ID: "fake",
      GITHUB_PRIVATE_KEY: "unused",
      GITHUB_WEBHOOK_SECRET: "w".repeat(32),
      GITHUB_CLIENT_ID: "fake",
      GITHUB_CLIENT_SECRET: "fake",
      S3_CONTROL_ENDPOINT: "http://object-store:9000",
      S3_PUBLIC_ENDPOINT: "https://objects.slopproof.test",
      KEY_WRAPPING_PUBLIC_KEY_PATH: "/keys/public.pem",
      WORKER_INTERNAL_URL: "http://worker:4001",
      WORKER_INTERNAL_SECRET: "i".repeat(32),
    });

    expect(config.KEY_WRAPPING_PROVIDER).toBe("local");
    expect("KEY_WRAPPING_PRIVATE_KEY_PATH" in config).toBe(false);
  });

  it("requires the private key for the local worker adapter", () => {
    expect(() =>
      loadWorkerConfig({
        ...common,
        S3_CONTROL_ENDPOINT: "http://object-store:9000",
        WORKER_INTERNAL_SECRET: "i".repeat(32),
      }),
    ).toThrowError(ConfigurationError);
  });

  it("accepts a canonical 32-byte provider payload key only in the worker", () => {
    const config = loadWorkerConfig({
      ...common,
      S3_CONTROL_ENDPOINT: "http://object-store:9000",
      KEY_WRAPPING_PRIVATE_KEY_PATH: "/keys/private.pem",
      WORKER_INTERNAL_SECRET: "i".repeat(32),
      PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(32, 112).toString("base64"),
    });

    expect(
      Buffer.from(config.PROVIDER_PAYLOAD_KEY_BASE64, "base64"),
    ).toHaveLength(32);
    expect(config.WORKER_HOST).toBe("127.0.0.1");
  });

  it("rejects a provider payload key with the wrong decoded length", () => {
    expect(() =>
      loadWorkerConfig({
        ...common,
        S3_CONTROL_ENDPOINT: "http://object-store:9000",
        KEY_WRAPPING_PRIVATE_KEY_PATH: "/keys/private.pem",
        WORKER_INTERNAL_SECRET: "i".repeat(32),
        PROVIDER_PAYLOAD_KEY_BASE64: Buffer.alloc(31, 112).toString("base64"),
      }),
    ).toThrowError(ConfigurationError);
  });

  it("reports field names but not secret values", () => {
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
