import { describe, expect, it } from "vitest";
import {
  ProviderError,
  httpStatusClassFor,
  isTransientUpstreamHttpStatus,
  isTransportFailure,
  safeHttpStatus,
} from "./errors";

describe("provider HTTP status helpers", () => {
  it("classifies only 402, 404, 408, and 5xx as transient upstream statuses", () => {
    expect(
      [400, 401, 402, 403, 404, 408, 422, 429, 500, 503].filter((status) =>
        isTransientUpstreamHttpStatus(status),
      ),
    ).toEqual([402, 404, 408, 500, 503]);
  });

  it("keeps numeric statuses content-free and bounded", () => {
    expect(safeHttpStatus(404)).toBe(404);
    expect(safeHttpStatus(99)).toBeUndefined();
    expect(safeHttpStatus(600)).toBeUndefined();
    expect(safeHttpStatus(404.5)).toBeUndefined();
    expect(httpStatusClassFor(404)).toBe("4xx");
    expect(httpStatusClassFor(503)).toBe("5xx");
    expect(httpStatusClassFor(200)).toBeNull();
  });
});

describe("isTransportFailure", () => {
  it("hops after an exhausted provider stream idle timeout", () => {
    expect(
      isTransportFailure(
        new ProviderError(
          "PROVIDER_TIMEOUT",
          "retryable",
          "Multimodal provider exhausted its stream idle timeout budget",
          {
            telemetry: {
              lastFailureKind: "timeout",
              httpStatusClass: null,
              transportAttemptCount: 1,
            },
          },
        ),
      ),
    ).toBe(true);
  });

  it("hops after exhausted transient 402/404/408 retries", () => {
    for (const httpStatus of [402, 404, 408]) {
      expect(
        isTransportFailure(
          new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "retryable",
            "Semantic provider is temporarily unavailable",
            {
              telemetry: {
                lastFailureKind: "upstream_unavailable",
                httpStatusClass: "4xx",
                transportAttemptCount: 3,
                httpStatus,
              },
            },
          ),
        ),
      ).toBe(true);
    }
  });

  it("does not hop after 401/403 or other terminal request rejects", () => {
    for (const httpStatus of [400, 401, 403, 422]) {
      expect(
        isTransportFailure(
          new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "terminal",
            "Semantic provider rejected the bounded request",
            {
              telemetry: {
                lastFailureKind: "request_rejected",
                httpStatusClass: "4xx",
                transportAttemptCount: 1,
                httpStatus,
              },
            },
          ),
        ),
      ).toBe(false);
    }
  });

  it("keeps 429 and 5xx hops and leaves INVALID_OUTPUT on the primary", () => {
    expect(
      isTransportFailure(
        new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "retryable",
          "Semantic provider is temporarily unavailable",
          {
            telemetry: {
              lastFailureKind: "rate_limited",
              httpStatusClass: "4xx",
              transportAttemptCount: 3,
              httpStatus: 429,
            },
          },
        ),
      ),
    ).toBe(true);
    expect(
      isTransportFailure(
        new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "retryable",
          "Semantic provider is temporarily unavailable",
          {
            telemetry: {
              lastFailureKind: "upstream_unavailable",
              httpStatusClass: "5xx",
              transportAttemptCount: 3,
              httpStatus: 503,
            },
          },
        ),
      ),
    ).toBe(true);
    expect(
      isTransportFailure(
        new ProviderError(
          "INVALID_OUTPUT",
          "review",
          "Semantic provider returned invalid bounded output",
          {
            telemetry: {
              lastFailureKind: "invalid_output",
              httpStatusClass: null,
              transportAttemptCount: 1,
            },
          },
        ),
      ),
    ).toBe(false);
  });
});
