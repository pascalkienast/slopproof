import type { WorkerConfig } from "@slopproof/config";
import {
  HetznerLearningMaterialProvider,
  HetznerPracticeCoachProvider,
  HetznerProofQuestionProvider,
  LocalFakeLearningMaterialProvider,
  LocalFakePracticeCoachProvider,
  LocalFakeProofQuestionProvider,
  type HetznerSemanticProviderDependencies,
  type LearningMaterialProvider,
  type PracticeCoachProvider,
  type ProofQuestionProvider,
} from "@slopproof/providers";

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
  const baseUrl = required(config.GENERATION_BASE_URL);
  const apiKey = required(config.GENERATION_API_KEY);
  const shared = { baseUrl, apiKey };
  return {
    learningMaterialProvider: new HetznerLearningMaterialProvider(
      { ...shared, model: required(config.LEARNING_MODEL) },
      dependencies.hetzner,
    ),
    practiceCoachProvider: new HetznerPracticeCoachProvider(
      { ...shared, model: required(config.PRACTICE_MODEL) },
      dependencies.hetzner,
    ),
    proofQuestionProvider: new HetznerProofQuestionProvider(
      { ...shared, model: required(config.PROOF_QUESTION_MODEL) },
      dependencies.hetzner,
    ),
  };
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Semantic provider configuration is incomplete");
  }
  return value;
}
