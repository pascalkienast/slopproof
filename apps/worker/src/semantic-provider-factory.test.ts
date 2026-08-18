import { describe, expect, it, vi } from "vitest";
import { createSemanticProviderSet } from "./semantic-provider-factory";

describe("semantic provider factory", () => {
  it("creates a deterministic offline fake set without network access", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const providers = createSemanticProviderSet(
      {
        GENERATION_PROVIDER: "fake",
      },
      { hetzner: { fetchImpl } },
    );

    expect(providers.learningMaterialProvider.descriptor).toEqual({
      provider: "local-fake",
      model: "deterministic-learning-v1",
    });
    expect(providers.practiceCoachProvider.descriptor.provider).toBe(
      "local-fake",
    );
    expect(providers.proofQuestionProvider.descriptor.model).toBe(
      "deterministic-proof-questions-v2",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates three Hetzner capabilities with independently configured models", () => {
    const providers = createSemanticProviderSet({
      GENERATION_PROVIDER: "hetzner",
      GENERATION_BASE_URL: "https://inference.example.test/api/v1",
      GENERATION_API_KEY: "semantic-provider-secret",
      LEARNING_MODEL: "learning-model",
      PRACTICE_MODEL: "practice-model",
      PROOF_QUESTION_MODEL: "proof-model",
    });

    expect(providers.learningMaterialProvider.descriptor).toEqual({
      provider: "hetzner-inference",
      model: "learning-model",
    });
    expect(providers.practiceCoachProvider.descriptor.model).toBe(
      "practice-model",
    );
    expect(providers.proofQuestionProvider.descriptor.model).toBe(
      "proof-model",
    );
  });

  it("fails closed before constructing an incomplete Hetzner set", () => {
    expect(() =>
      createSemanticProviderSet({
        GENERATION_PROVIDER: "hetzner",
        GENERATION_BASE_URL: "https://inference.example.test/api/v1",
        GENERATION_API_KEY: "semantic-provider-secret",
        LEARNING_MODEL: "learning-model",
        PRACTICE_MODEL: "practice-model",
      }),
    ).toThrow("Semantic provider configuration is incomplete");
  });

  it("wraps OpenRouter primary with a Hetzner transport fallback", () => {
    const providers = createSemanticProviderSet({
      GENERATION_PROVIDER: "openrouter",
      GENERATION_BASE_URL: "https://openrouter.example.test/api/v1",
      GENERATION_API_KEY: "openrouter-provider-secret",
      LEARNING_MODEL: "xiaomi/mimo-v2.5",
      PRACTICE_MODEL: "xiaomi/mimo-v2.5",
      PROOF_QUESTION_MODEL: "xiaomi/mimo-v2.5",
      GENERATION_FALLBACK_BASE_URL: "https://inference.example.test/api/v1",
      GENERATION_FALLBACK_API_KEY: "hetzner-provider-secret",
      LEARNING_FALLBACK_MODEL: "hetzner-learning",
      PRACTICE_FALLBACK_MODEL: "hetzner-practice",
      PROOF_QUESTION_FALLBACK_MODEL: "hetzner-proof",
    });

    expect(providers.learningMaterialProvider.descriptor).toEqual({
      provider: "openrouter",
      model: "xiaomi/mimo-v2.5",
    });
    expect(providers.practiceCoachProvider.descriptor.model).toBe(
      "xiaomi/mimo-v2.5",
    );
    expect(providers.proofQuestionProvider.descriptor.provider).toBe(
      "openrouter",
    );
  });
});
