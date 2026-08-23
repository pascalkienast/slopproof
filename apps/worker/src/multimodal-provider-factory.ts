import type { WorkerConfig } from "@slopproof/config";
import {
  HetznerMultimodalJudgeProvider,
  LocalFakeInlineMultimodalJudgeProvider,
  TransportFallbackMultimodalJudgeProvider,
  type HetznerMultimodalJudgeDependencies,
  type InlineMultimodalJudgeProvider,
} from "@slopproof/providers";

export type MultimodalProviderFactoryDependencies = {
  hetzner?: HetznerMultimodalJudgeDependencies;
  clock?: { now(): Date };
};

export function createMultimodalJudgeProvider(
  config: Pick<
    WorkerConfig,
    | "MULTIMODAL_JUDGE_PROVIDER"
    | "JUDGE_BASE_URL"
    | "JUDGE_API_KEY"
    | "JUDGE_MODEL"
    | "JUDGE_FALLBACK_MODEL"
    | "JUDGE_TRANSPORT_FALLBACK_BASE_URL"
    | "JUDGE_TRANSPORT_FALLBACK_API_KEY"
    | "JUDGE_TRANSPORT_FALLBACK_MODEL"
    | "JUDGE_TRANSPORT_FALLBACK_VISION_MODEL"
  >,
  dependencies: MultimodalProviderFactoryDependencies = {},
): InlineMultimodalJudgeProvider {
  if (config.MULTIMODAL_JUDGE_PROVIDER === "fake") {
    return new LocalFakeInlineMultimodalJudgeProvider(
      dependencies.clock ?? { now: () => new Date() },
    );
  }
  const primary = new HetznerMultimodalJudgeProvider(
    {
      provider:
        config.MULTIMODAL_JUDGE_PROVIDER === "openrouter"
          ? "openrouter"
          : "hetzner-inference",
      baseUrl: required(config.JUDGE_BASE_URL),
      apiKey: required(config.JUDGE_API_KEY),
      model: required(config.JUDGE_MODEL),
      visionModel: required(config.JUDGE_FALLBACK_MODEL),
    },
    dependencies.hetzner,
  );
  if (
    config.MULTIMODAL_JUDGE_PROVIDER !== "openrouter" ||
    config.JUDGE_TRANSPORT_FALLBACK_BASE_URL === undefined
  ) {
    return primary;
  }
  return new TransportFallbackMultimodalJudgeProvider(
    primary,
    new HetznerMultimodalJudgeProvider(
      {
        provider: "hetzner-inference",
        baseUrl: required(config.JUDGE_TRANSPORT_FALLBACK_BASE_URL),
        apiKey: required(config.JUDGE_TRANSPORT_FALLBACK_API_KEY),
        model: required(config.JUDGE_TRANSPORT_FALLBACK_MODEL),
        visionModel: required(config.JUDGE_TRANSPORT_FALLBACK_VISION_MODEL),
      },
      dependencies.hetzner,
    ),
    {
      now: () => (dependencies.clock?.now() ?? new Date()).getTime(),
    },
  );
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Multimodal judge provider configuration is incomplete");
  }
  return value;
}
