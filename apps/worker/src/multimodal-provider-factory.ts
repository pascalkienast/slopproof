import type { WorkerConfig } from "@slopproof/config";
import {
  HetznerMultimodalJudgeProvider,
  LocalFakeInlineMultimodalJudgeProvider,
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
  >,
  dependencies: MultimodalProviderFactoryDependencies = {},
): InlineMultimodalJudgeProvider {
  if (config.MULTIMODAL_JUDGE_PROVIDER === "fake") {
    return new LocalFakeInlineMultimodalJudgeProvider(
      dependencies.clock ?? { now: () => new Date() },
    );
  }
  return new HetznerMultimodalJudgeProvider(
    {
      baseUrl: required(config.JUDGE_BASE_URL),
      apiKey: required(config.JUDGE_API_KEY),
      model: required(config.JUDGE_MODEL),
      visionModel: required(config.JUDGE_FALLBACK_MODEL),
    },
    dependencies.hetzner,
  );
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Multimodal judge provider configuration is incomplete");
  }
  return value;
}
