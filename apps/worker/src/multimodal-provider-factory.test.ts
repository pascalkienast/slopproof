import { describe, expect, it, vi } from "vitest";
import { createMultimodalJudgeProvider } from "./multimodal-provider-factory";

describe("multimodal judge provider factory", () => {
  it("creates a deterministic offline provider without network access", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = createMultimodalJudgeProvider(
      { MULTIMODAL_JUDGE_PROVIDER: "fake" },
      {
        hetzner: { fetchImpl },
        clock: { now: () => new Date("2026-08-13T02:00:00.000Z") },
      },
    );
    expect(provider.descriptor).toEqual({
      provider: "local-fake",
      model: "deterministic-multimodal-review-v1",
      visionModel: "deterministic-multimodal-review-v1",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps the primary and vision-fallback models independently", () => {
    const provider = createMultimodalJudgeProvider({
      MULTIMODAL_JUDGE_PROVIDER: "hetzner",
      JUDGE_BASE_URL: "https://inference.example.test/api/v1",
      JUDGE_API_KEY: "private-multimodal-api-key",
      JUDGE_MODEL: "primary-text-model",
      JUDGE_FALLBACK_MODEL: "vision-fallback-model",
    });
    expect(provider.descriptor).toEqual({
      provider: "hetzner-inference",
      model: "primary-text-model",
      visionModel: "vision-fallback-model",
    });
  });

  it("fails closed before constructing an incomplete Hetzner provider", () => {
    expect(() =>
      createMultimodalJudgeProvider({
        MULTIMODAL_JUDGE_PROVIDER: "hetzner",
        JUDGE_BASE_URL: "https://inference.example.test/api/v1",
        JUDGE_API_KEY: "private-multimodal-api-key",
        JUDGE_MODEL: "primary-text-model",
      }),
    ).toThrow("Multimodal judge provider configuration is incomplete");
  });

  it("wraps OpenRouter primary with a Hetzner transport fallback", () => {
    const provider = createMultimodalJudgeProvider({
      MULTIMODAL_JUDGE_PROVIDER: "openrouter",
      JUDGE_BASE_URL: "https://openrouter.example.test/api/v1",
      JUDGE_API_KEY: "openrouter-multimodal-api-key",
      JUDGE_MODEL: "xiaomi/mimo-v2.5",
      JUDGE_FALLBACK_MODEL: "xiaomi/mimo-v2.5",
      JUDGE_TRANSPORT_FALLBACK_BASE_URL:
        "https://inference.example.test/api/v1",
      JUDGE_TRANSPORT_FALLBACK_API_KEY: "hetzner-multimodal-api-key",
      JUDGE_TRANSPORT_FALLBACK_MODEL: "hetzner-judge",
      JUDGE_TRANSPORT_FALLBACK_VISION_MODEL: "hetzner-vision",
    });

    expect(provider.descriptor).toEqual({
      provider: "openrouter",
      model: "xiaomi/mimo-v2.5",
      visionModel: "xiaomi/mimo-v2.5",
    });
    expect(provider.transportFallbackDescriptor).toEqual({
      provider: "hetzner-inference",
      model: "hetzner-judge",
      visionModel: "hetzner-vision",
    });
  });
});
