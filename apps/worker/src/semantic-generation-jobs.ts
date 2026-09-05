import type { JobPayload } from "@understandproof/db";
import {
  createSemanticGenerationService,
  type GenerateLearningBundleRequestV1,
  type GeneratePracticeFeedbackRequestV1,
  type GenerateProofQuestionPlanRequestV1,
} from "./semantic-generation";
import type {
  SemanticGenerationJobHandlerDependencies,
  SemanticGenerationJobHandlers,
} from "./semantic-generation-contracts";
import {
  isRetryablePreparationError,
  safeErrorClass,
} from "./revision-preparation";

export function createSemanticGenerationJobHandlers(
  dependencies: SemanticGenerationJobHandlerDependencies,
): SemanticGenerationJobHandlers {
  return {
    async "semantic.generate-learning"(payload) {
      const run = await dependencies.repository.reserveRun(
        "semantic.generate-learning",
        payload,
      );
      if (run === "stale") return { outcome: "stale" };
      if (run === "proof_pending") return { outcome: "proof_pending" };
      if (run.completedArtifactId !== null) return { outcome: "replayed" };
      const forbiddenProofContent =
        await dependencies.repository.loadFrozenProofContent(run);
      if (forbiddenProofContent === "pending") {
        return { outcome: "proof_pending" };
      }
      const request: GenerateLearningBundleRequestV1 = {
        schemaVersion: "1",
        requestVersion: "generate-learning-bundle-v1",
        generationContext: run.generationContext,
        artifactSeed: run.artifactSeed,
        artifactCreatedAt: run.createdAt,
        deadlineAt: run.deadlineAt,
        deleteAfter: run.deleteAfter,
        practiceQuestionCount: run.questionCount,
        forbiddenProofContent,
      };
      const result = await dependencies.service.generateLearningBundle(request);
      return {
        outcome: await dependencies.repository.persistLearning(run, result),
        artifactId: result.artifact.id,
        degraded: result.degraded,
      };
    },

    async "semantic.generate-practice-feedback"(payload) {
      const run = await dependencies.repository.reserveRun(
        "semantic.generate-practice-feedback",
        payload,
      );
      if (run === "stale") return { outcome: "stale" };
      if (run === "proof_pending") return { outcome: "proof_pending" };
      if (run.completedArtifactId !== null) return { outcome: "replayed" };
      const privateInput =
        await dependencies.repository.loadPracticeQuestionAndAnswer(
          run,
          payload,
        );
      const forbiddenProofContent =
        await dependencies.repository.loadFrozenProofContent(run);
      if (forbiddenProofContent === "pending") {
        return { outcome: "proof_pending" };
      }
      const request: GeneratePracticeFeedbackRequestV1 = {
        schemaVersion: "1",
        requestVersion: "generate-practice-feedback-v1",
        generationContext: run.generationContext,
        artifactSeed: run.artifactSeed,
        artifactCreatedAt: run.createdAt,
        deadlineAt: run.deadlineAt,
        deleteAfter: run.deleteAfter,
        practiceQuestion: privateInput.question,
        contributorAnswer: privateInput.answer,
        forbiddenProofContent,
      };
      const result =
        await dependencies.service.generatePracticeFeedback(request);
      return {
        outcome: await dependencies.repository.persistPracticeFeedback(
          run,
          payload,
          result,
        ),
        artifactId: result.artifact.id,
        degraded: result.degraded,
      };
    },

    async "semantic.generate-proof-questions"(payload) {
      try {
        const run = await dependencies.repository.reserveRun(
          "semantic.generate-proof-questions",
          payload,
        );
        if (run === "stale") return { outcome: "stale" };
        if (run === "proof_pending") {
          throw new Error(
            "Proof generation does not wait on frozen Proof content.",
          );
        }
        if (run.completedArtifactId !== null) {
          return dependencies.repository.replayCompletedProof(run);
        }
        const request: GenerateProofQuestionPlanRequestV1 = {
          schemaVersion: "1",
          requestVersion: "generate-proof-question-plan-v1",
          generationContext: run.generationContext,
          artifactSeed: run.artifactSeed,
          artifactCreatedAt: run.createdAt,
          deadlineAt: run.deadlineAt,
          deleteAfter: run.deleteAfter,
          questionBudget: run.questionCount,
        };
        const result =
          await dependencies.service.generateProofQuestionPlan(request);
        return dependencies.repository.persistProofPlanAndCreateAttempt(
          run,
          result,
        );
      } catch (error) {
        if (isRetryablePreparationError(error)) throw error;
        return {
          outcome: await dependencies.repository.failProofPreparation(
            payload,
            safeErrorClass(error),
          ),
        };
      }
    },

    async "semantic.expire-private"(payload) {
      return { outcome: await dependencies.repository.expirePrivate(payload) };
    },
  };
}

// Keep the worker service constructor reachable from the stable Gate-4 module.
export { createSemanticGenerationService };

export type SemanticLearningJobPayload =
  JobPayload<"semantic.generate-learning">;
