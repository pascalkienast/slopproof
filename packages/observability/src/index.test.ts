import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "./index";

describe("evidence-free logging", () => {
  it("redacts tokens, wrapped keys, transcript and URLs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(loggerOptions({ service: "test" }), destination);

    logger.info({
      attemptId: "a1",
      token: "secret-token",
      wrappedKey: "secret-wrapped-key",
      transcript: "secret-transcript",
      presignedUrl: "https://secret.example/upload",
      providerRequest: "secret-provider-request",
      GENERATION_API_KEY: "secret-top-level-generation-key",
      env: { JUDGE_API_KEY: "secret-nested-judge-key" },
      provider: {
        headers: { authorization: "Bearer secret-provider-authorization" },
      },
      config: {
        OAUTH_TRUSTED_PROXY_SECRET: "secret-proxy-authenticator",
        PROVIDER_PAYLOAD_KEY_BASE64: "secret-provider-key",
        GENERATION_API_KEY: "secret-generation-key",
        JUDGE_API_KEY: "secret-judge-key",
        TRANSCRIPTION_API_KEY: "secret-transcription-key",
      },
      req: {
        headers: {
          "x-slopproof-proxy-authenticator": "secret-proxy-header",
        },
      },
    });
    await new Promise<void>((resolve) => destination.end(resolve));

    expect(output).toContain("a1");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("secret-wrapped-key");
    expect(output).not.toContain("secret-transcript");
    expect(output).not.toContain("secret.example");
    expect(output).not.toContain("secret-provider-key");
    expect(output).not.toContain("secret-provider-request");
    expect(output).not.toContain("secret-generation-key");
    expect(output).not.toContain("secret-judge-key");
    expect(output).not.toContain("secret-transcription-key");
    expect(output).not.toContain("secret-top-level-generation-key");
    expect(output).not.toContain("secret-nested-judge-key");
    expect(output).not.toContain("secret-provider-authorization");
    expect(output).not.toContain("secret-proxy-authenticator");
    expect(output).not.toContain("secret-proxy-header");
  });

  it("serializes an error without its message or stack", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(loggerOptions({ service: "test" }), destination);
    logger.error({ err: new Error("plaintext must stay private") });
    await new Promise<void>((resolve) => destination.end(resolve));

    expect(output).toContain("Error");
    expect(output).not.toContain("plaintext must stay private");
    expect(output).not.toContain("index.test.ts");
  });
});
