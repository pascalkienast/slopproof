import { describe, expect, it, vi } from "vitest";
import type { ProviderContextV1 } from "./contracts";
import { ProviderError } from "./errors";
import type {
  InlineMultimodalJudgeProvider,
  MultimodalJudgeProviderInputV1,
  MultimodalJudgeProviderResultV1,
} from "./hetzner-multimodal";
import type {
  SemanticProviderCallContextV1,
  SemanticProviderDescriptorV1,
  SemanticProviderRawResponseV1,
  SemanticProviderRepairInstructionV1,
} from "./learning-proof";
import {
  TransportFallbackMultimodalJudgeProvider,
  TransportFallbackSemanticProvider,
} from "./transport-fallback";

const CONTEXT: SemanticProviderCallContextV1 = {
  schemaVersion: "1",
  callId: "10000000-0000-4000-8000-000000000001",
  revisionId: "10000000-0000-4000-8000-000000000002",
  headSha: "a".repeat(40),
  contextHash: "b".repeat(64),
  purpose: "learning_material",
  phase: "initial",
  deadlineAt: new Date("2026-08-18T12:05:00.000Z"),
};

const REPAIR: SemanticProviderRepairInstructionV1 = {
  schemaVersion: "1",
  invalidOutputHash: "f".repeat(64),
  validationCode: "schema_invalid",
  maximumAdditionalAttempts: 1,
};

describe("TransportFallbackSemanticProvider", () => {
  it("records the Hetzner hop after a primary transport failure", async () => {
    const primary = stubSemanticProvider(
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
      {
        generate: () => {
          throw transportUnavailable();
        },
        repair: () => {
          throw new Error("repair must not run");
        },
      },
    );
    const fallback = stubSemanticProvider(
      { provider: "hetzner-inference", model: "hetzner-learning" },
      {
        generate: () => semanticResponse("fallback-output"),
        repair: () => {
          throw new Error("repair must not run");
        },
      },
    );
    const provider = new TransportFallbackSemanticProvider(primary, fallback);

    const result = await provider.generate({ task: "learning" }, CONTEXT);

    expect(primary.generate).toHaveBeenCalledTimes(1);
    expect(fallback.generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      output: "fallback-output",
      answeredBy: {
        provider: "hetzner-inference",
        model: "hetzner-learning",
      },
    });
    expect(provider.descriptor).toEqual({
      provider: "openrouter",
      model: "xiaomi/mimo-v2.5",
    });
  });

  it("does not hop to Hetzner after INVALID_OUTPUT or a schema-shaped reject", async () => {
    const primary = stubSemanticProvider(
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
      {
        generate: () => {
          throw new ProviderError(
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
          );
        },
        repair: () => semanticResponse("must-not-run"),
      },
    );
    const fallback = stubSemanticProvider(
      { provider: "hetzner-inference", model: "hetzner-learning" },
      {
        generate: () => semanticResponse("must-not-run"),
        repair: () => semanticResponse("must-not-run"),
      },
    );
    const provider = new TransportFallbackSemanticProvider(primary, fallback);

    await expect(
      provider.generate({ task: "learning" }, CONTEXT),
    ).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
    });
    expect(fallback.generate).not.toHaveBeenCalled();
    expect(fallback.repair).not.toHaveBeenCalled();

    primary.generate.mockImplementationOnce(() => {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "terminal",
        "Semantic provider rejected the bounded request",
        {
          telemetry: {
            lastFailureKind: "request_rejected",
            httpStatusClass: "4xx",
            transportAttemptCount: 1,
          },
        },
      );
    });
    await expect(
      provider.generate({ task: "learning" }, CONTEXT),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      disposition: "terminal",
    });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it.each([402, 404, 408])(
    "hops after a retryable HTTP %s transport failure",
    async (httpStatus) => {
      const primary = stubSemanticProvider(
        { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
        {
          generate: () => {
            throw new ProviderError(
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
            );
          },
          repair: () => {
            throw new Error("repair must not run");
          },
        },
      );
      const fallback = stubSemanticProvider(
        { provider: "hetzner-inference", model: "hetzner-learning" },
        {
          generate: () => semanticResponse("fallback-output"),
          repair: () => {
            throw new Error("repair must not run");
          },
        },
      );

      const result = await new TransportFallbackSemanticProvider(
        primary,
        fallback,
      ).generate({ task: "learning" }, CONTEXT);

      expect(fallback.generate).toHaveBeenCalledTimes(1);
      expect(result.answeredBy).toEqual({
        provider: "hetzner-inference",
        model: "hetzner-learning",
      });
    },
  );

  it.each([401, 403])(
    "does not hop after terminal HTTP %s",
    async (httpStatus) => {
      const fallback = stubSemanticProvider(
        { provider: "hetzner-inference", model: "hetzner-learning" },
        {
          generate: () => semanticResponse("must-not-run"),
          repair: () => semanticResponse("must-not-run"),
        },
      );

      await expect(
        new TransportFallbackSemanticProvider(
          stubSemanticProvider(
            { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
            {
              generate: () => {
                throw new ProviderError(
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
                );
              },
              repair: () => semanticResponse("must-not-run"),
            },
          ),
          fallback,
        ).generate({ task: "learning" }, CONTEXT),
      ).rejects.toMatchObject({
        disposition: "terminal",
        telemetry: { httpStatus },
      });
      expect(fallback.generate).not.toHaveBeenCalled();
    },
  );

  it("keeps a successful primary answer on OpenRouter", async () => {
    const primary = stubSemanticProvider(
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
      {
        generate: () => semanticResponse("primary-output"),
        repair: () => semanticResponse("must-not-run"),
      },
    );
    const fallback = stubSemanticProvider(
      { provider: "hetzner-inference", model: "hetzner-learning" },
      {
        generate: () => semanticResponse("must-not-run"),
        repair: () => semanticResponse("must-not-run"),
      },
    );

    const result = await new TransportFallbackSemanticProvider(
      primary,
      fallback,
    ).generate({ task: "learning" }, CONTEXT);

    expect(fallback.generate).not.toHaveBeenCalled();
    expect(result.answeredBy).toEqual({
      provider: "openrouter",
      model: "xiaomi/mimo-v2.5",
    });
  });

  it("hops a transport-failed repair and records the answering provider", async () => {
    const primary = stubSemanticProvider(
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
      {
        generate: () => semanticResponse("must-not-run"),
        repair: () => {
          throw new ProviderError(
            "DEADLINE_EXCEEDED",
            "retryable",
            "Semantic provider deadline elapsed",
            {
              telemetry: {
                lastFailureKind: "timeout",
                httpStatusClass: null,
                transportAttemptCount: 1,
              },
            },
          );
        },
      },
    );
    const fallback = stubSemanticProvider(
      { provider: "hetzner-inference", model: "hetzner-learning" },
      {
        generate: () => semanticResponse("must-not-run"),
        repair: () => semanticResponse("repaired-on-hetzner"),
      },
    );

    const result = await new TransportFallbackSemanticProvider(
      primary,
      fallback,
    ).repair({ task: "learning" }, REPAIR, { ...CONTEXT, phase: "repair" });

    expect(primary.repair).toHaveBeenCalledTimes(1);
    expect(fallback.repair).toHaveBeenCalledTimes(1);
    expect(result.answeredBy).toEqual({
      provider: "hetzner-inference",
      model: "hetzner-learning",
    });
  });
});

describe("TransportFallbackMultimodalJudgeProvider", () => {
  it("records the Hetzner judge after a primary transport failure", async () => {
    const primary = stubJudgeProvider(
      {
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        visionModel: "xiaomi/mimo-v2.5",
      },
      () => {
        throw transportUnavailable();
      },
    );
    const fallback = stubJudgeProvider(
      {
        provider: "hetzner-inference",
        model: "hetzner-judge",
        visionModel: "hetzner-vision",
      },
      () =>
        judgeResult({
          provider: "hetzner-inference",
          model: "hetzner-judge",
        }),
    );
    const provider = new TransportFallbackMultimodalJudgeProvider(
      primary,
      fallback,
    );

    const result = await provider.evaluate(
      {} as MultimodalJudgeProviderInputV1,
      judgeContext(),
    );

    expect(primary.evaluate).toHaveBeenCalledTimes(1);
    expect(fallback.evaluate).toHaveBeenCalledTimes(1);
    expect(result.metadata.provider).toBe("hetzner-inference");
    expect(result.metadata.model).toBe("hetzner-judge");
    expect(provider.descriptor.provider).toBe("openrouter");
    expect(provider.transportFallbackDescriptor.provider).toBe(
      "hetzner-inference",
    );
  });

  it.each([402, 404, 408])(
    "hops the judge after a retryable HTTP %s transport failure",
    async (httpStatus) => {
      const primary = stubJudgeProvider(
        {
          provider: "openrouter",
          model: "xiaomi/mimo-v2.5",
          visionModel: "xiaomi/mimo-v2.5",
        },
        () => {
          throw new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "retryable",
            "Multimodal provider is temporarily unavailable",
            {
              telemetry: {
                lastFailureKind: "upstream_unavailable",
                httpStatusClass: "4xx",
                transportAttemptCount: 3,
                httpStatus,
              },
            },
          );
        },
      );
      const fallback = stubJudgeProvider(
        {
          provider: "hetzner-inference",
          model: "hetzner-judge",
          visionModel: "hetzner-vision",
        },
        () =>
          judgeResult({
            provider: "hetzner-inference",
            model: "hetzner-judge",
          }),
      );

      const result = await new TransportFallbackMultimodalJudgeProvider(
        primary,
        fallback,
      ).evaluate({} as MultimodalJudgeProviderInputV1, judgeContext());

      expect(primary.evaluate).toHaveBeenCalledTimes(1);
      expect(fallback.evaluate).toHaveBeenCalledTimes(1);
      expect(result.metadata.model).toBe("hetzner-judge");
    },
  );

  it("does not hop the judge after INVALID_OUTPUT", async () => {
    const primary = stubJudgeProvider(
      {
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        visionModel: "xiaomi/mimo-v2.5",
      },
      () => {
        throw new ProviderError(
          "INVALID_OUTPUT",
          "review",
          "Multimodal provider output is invalid",
        );
      },
    );
    const fallback = stubJudgeProvider(
      {
        provider: "hetzner-inference",
        model: "hetzner-judge",
        visionModel: "hetzner-vision",
      },
      () => {
        throw new Error("fallback must not run");
      },
    );

    await expect(
      new TransportFallbackMultimodalJudgeProvider(primary, fallback).evaluate(
        {} as MultimodalJudgeProviderInputV1,
        judgeContext(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    expect(fallback.evaluate).not.toHaveBeenCalled();
  });
});

function transportUnavailable(): ProviderError {
  return new ProviderError(
    "PROVIDER_UNAVAILABLE",
    "retryable",
    "Semantic provider is temporarily unavailable",
    {
      telemetry: {
        lastFailureKind: "upstream_unavailable",
        httpStatusClass: "5xx",
        transportAttemptCount: 3,
      },
    },
  );
}

function semanticResponse(output: unknown): SemanticProviderRawResponseV1 {
  return {
    output,
    tokenUsage: { inputTokens: 4, outputTokens: 2 },
    transportAttemptCount: 1,
  };
}

function stubSemanticProvider(
  descriptor: SemanticProviderDescriptorV1,
  behavior: {
    generate(): SemanticProviderRawResponseV1;
    repair(): SemanticProviderRawResponseV1;
  },
) {
  return {
    descriptor,
    generate: vi.fn(async () => behavior.generate()),
    repair: vi.fn(async () => behavior.repair()),
  };
}

function stubJudgeProvider(
  descriptor: InlineMultimodalJudgeProvider["descriptor"],
  evaluate: () => MultimodalJudgeProviderResultV1,
): InlineMultimodalJudgeProvider & {
  evaluate: ReturnType<typeof vi.fn>;
} {
  return {
    descriptor,
    evaluate: vi.fn(async () => evaluate()),
  };
}

function judgeResult(metadata: {
  provider: string;
  model: string;
}): MultimodalJudgeProviderResultV1 {
  return {
    candidate: {
      schemaVersion: "1",
      candidateVersion: "multimodal-judge-candidate-v1",
      recommendation: "review_required",
      questionEvaluations: [],
      privateReason: "automated_evaluation_unavailable",
      warnings: [],
    },
    metadata: {
      schemaVersion: "1",
      provider: metadata.provider,
      model: metadata.model,
      promptVersion: "proof-judge-system-v2",
      outputSchemaVersion: "multimodal-judge-candidate-v1",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      tokenUsage: null,
      latencyMs: 10,
      invocationCount: 1,
      outcome: "generated",
      degraded: false,
      completedAt: new Date("2026-08-18T12:00:00.000Z"),
    },
  } as MultimodalJudgeProviderResultV1;
}

function judgeContext(): ProviderContextV1 {
  return {
    schemaVersion: "1",
    requestId: "10000000-0000-4000-8000-000000000010",
    attemptId: "10000000-0000-4000-8000-000000000011",
    deadlineAt: new Date("2026-08-18T12:05:00.000Z"),
  };
}
