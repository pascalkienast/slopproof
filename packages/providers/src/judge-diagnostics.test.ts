import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors";
import { describeJudgeEvaluateFailure } from "./judge-diagnostics";

describe("judge evaluate failure diagnostics", () => {
  it("keeps 404/402 enums and hopUsed without the provider message", () => {
    const diagnostics = describeJudgeEvaluateFailure(
      new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "retryable",
        "private raw provider payload and API key",
        {
          hopUsed: "primary",
          telemetry: {
            lastFailureKind: "upstream_unavailable",
            httpStatusClass: "4xx",
            transportAttemptCount: 3,
            httpStatus: 404,
          },
        },
      ),
      { hopUsed: "none", latencyMs: 3400, frameCount: 1 },
    );
    expect(diagnostics).toMatchObject({
      httpStatus: 404,
      errorClass: "ProviderError",
      errorCode: "PROVIDER_UNAVAILABLE",
      disposition: "retryable",
      lastFailureKind: "upstream_unavailable",
      hopUsed: "primary",
      invocationCount: 1,
      latencyMs: 3400,
      frameCount: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("private raw provider");
  });

  it("records a network failure as transport without an HTTP status", () => {
    expect(
      describeJudgeEvaluateFailure(
        new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "retryable",
          "Multimodal provider is temporarily unavailable",
          {
            telemetry: {
              lastFailureKind: "network",
              httpStatusClass: null,
              transportAttemptCount: 1,
            },
          },
        ),
        { hopUsed: "none", latencyMs: 12, frameCount: 0 },
      ),
    ).toMatchObject({
      lastFailureKind: "network",
      hopUsed: "none",
      invocationCount: 1,
    });
  });
});
