import type { WorkerConfig } from "@understandproof/config";
import {
  HetznerLearningMaterialProvider,
  HetznerPracticeCoachProvider,
  HetznerProofQuestionProvider,
  LocalFakeLearningMaterialProvider,
  LocalFakePracticeCoachProvider,
  LocalFakeProofQuestionProvider,
  TransportFallbackSemanticProvider,
  type HetznerSemanticProviderDependencies,
  type LearningMaterialProvider,
  type PracticeCoachProvider,
  type ProofQuestionProvider,
} from "@understandproof/providers";

export type SemanticProviderSet = {
  learningMaterialProvider: LearningMaterialProvider;
  practiceCoachProvider: PracticeCoachProvider;
  proofQuestionProvider: ProofQuestionProvider;
};

export type SemanticProviderFactoryDependencies = {
  hetzner?: HetznerSemanticProviderDependencies;
  clock?: { now(): Date };
};

/**
 * Constructs only the semantic capability set. Job registration and durable
 * artifact persistence remain owned by the worker composition root.
 */
export function createSemanticProviderSet(
  config: Pick<
    WorkerConfig,
    | "GENERATION_PROVIDER"
    | "GENERATION_BASE_URL"
    | "GENERATION_API_KEY"
    | "LEARNING_MODEL"
    | "PRACTICE_MODEL"
    | "PROOF_QUESTION_MODEL"
    | "GENERATION_FALLBACK_BASE_URL"
    | "GENERATION_FALLBACK_API_KEY"
    | "LEARNING_FALLBACK_MODEL"
    | "PRACTICE_FALLBACK_MODEL"
    | "PROOF_QUESTION_FALLBACK_MODEL"
  >,
  dependencies: SemanticProviderFactoryDependencies = {},
): SemanticProviderSet {
  if (config.GENERATION_PROVIDER === "fake") {
    const clock = dependencies.clock ?? { now: () => new Date() };
    return {
      learningMaterialProvider: new LocalFakeLearningMaterialProvider(clock),
      practiceCoachProvider: new LocalFakePracticeCoachProvider(clock),
      proofQuestionProvider: new LocalFakeProofQuestionProvider(clock),
    };
  }
  const primary = createCompatibleSemanticSet(
    config.GENERATION_PROVIDER === "openrouter"
      ? "openrouter"
      : "hetzner-inference",
    {
      baseUrl: required(config.GENERATION_BASE_URL),
      apiKey: required(config.GENERATION_API_KEY),
      learningModel: required(config.LEARNING_MODEL),
      practiceModel: required(config.PRACTICE_MODEL),
      proofModel: required(config.PROOF_QUESTION_MODEL),
    },
    dependencies.hetzner,
  );
  if (config.GENERATION_PROVIDER !== "openrouter") return primary;
  if (config.GENERATION_FALLBACK_BASE_URL === undefined) return primary;
  const fallback = createCompatibleSemanticSet(
    "hetzner-inference",
    {
      baseUrl: required(config.GENERATION_FALLBACK_BASE_URL),
      apiKey: required(config.GENERATION_FALLBACK_API_KEY),
      learningModel: required(config.LEARNING_FALLBACK_MODEL),
      practiceModel: required(config.PRACTICE_FALLBACK_MODEL),
      proofModel: required(config.PROOF_QUESTION_FALLBACK_MODEL),
    },
    dependencies.hetzner,
  );
  return {
    learningMaterialProvider: new TransportFallbackSemanticProvider(
      primary.learningMaterialProvider,
      fallback.learningMaterialProvider,
    ),
    practiceCoachProvider: new TransportFallbackSemanticProvider(
      primary.practiceCoachProvider,
      fallback.practiceCoachProvider,
    ),
    proofQuestionProvider: new TransportFallbackSemanticProvider(
      primary.proofQuestionProvider,
      fallback.proofQuestionProvider,
    ),
  };
}

function createCompatibleSemanticSet(
  provider: "hetzner-inference" | "openrouter",
  models: {
    baseUrl: string;
    apiKey: string;
    learningModel: string;
    practiceModel: string;
    proofModel: string;
  },
  dependencies?: HetznerSemanticProviderDependencies,
): SemanticProviderSet {
  const shared = {
    provider,
    baseUrl: models.baseUrl,
    apiKey: models.apiKey,
  };
  return {
    learningMaterialProvider: new HetznerLearningMaterialProvider(
      { ...shared, model: models.learningModel },
      dependencies,
    ),
    practiceCoachProvider: new HetznerPracticeCoachProvider(
      { ...shared, model: models.practiceModel },
      dependencies,
    ),
    proofQuestionProvider: new HetznerProofQuestionProvider(
      { ...shared, model: models.proofModel },
      dependencies,
    ),
  };
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Semantic provider configuration is incomplete");
  }
  return value;
}
