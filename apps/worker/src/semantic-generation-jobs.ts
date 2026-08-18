import type { JobPayload } from "@slopproof/db";
import {
  createSemanticGenerationService,
  SemanticGenerationFailedError,
  type GenerateLearningBundleRequestV1,
  type GeneratePracticeFeedbackRequestV1,
  type GenerateProofQuestionPlanRequestV1,
} from "./semantic-generation";
import type {
  SemanticGenerationJobHandlerDependencies,
  SemanticGenerationJobHandlers,
  SemanticRunContext,
} from "./semantic-generation-contracts";

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
      if (isDegradedCompletion(run)) {
        return { outcome: "failed", degraded: true };
      }
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
      try {
        const result =
          await dependencies.service.generateLearningBundle(request);
        return {
          outcome: await dependencies.repository.persistLearning(run, result),
          artifactId: result.artifact.id,
          degraded: false,
        };
      } catch (error) {
        return persistHonestGenerationFailure(dependencies, run, error);
      }
    },

    async "semantic.generate-practice-feedback"(payload) {
      const run = await dependencies.repository.reserveRun(
        "semantic.generate-practice-feedback",
        payload,
      );
      if (run === "stale") return { outcome: "stale" };
      if (isDegradedCompletion(run)) {
        return { outcome: "failed", degraded: true };
      }
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
      try {
        const result =
          await dependencies.service.generatePracticeFeedback(request);
        return {
          outcome: await dependencies.repository.persistPracticeFeedback(
            run,
            payload,
            result,
          ),
          artifactId: result.artifact.id,
          degraded: false,
        };
      } catch (error) {
        return persistHonestGenerationFailure(dependencies, run, error);
      }
    },

    async "semantic.generate-proof-questions"(payload) {
      const run = await dependencies.repository.reserveRun(
        "semantic.generate-proof-questions",
        payload,
      );
      if (run === "stale") return { outcome: "stale" };
      if (isDegradedCompletion(run)) {
        return { outcome: "generation_failed" };
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
      try {
        const result =
          await dependencies.service.generateProofQuestionPlan(request);
        return dependencies.repository.persistProofPlanAndCreateAttempt(
          run,
          result,
        );
      } catch (error) {
        if (error instanceof SemanticGenerationFailedError) {
          await dependencies.repository.persistFailedGeneration(
            run,
            error.metadata,
            error.failure,
          );
          return { outcome: "generation_failed" };
        }
        throw error;
      }
    },

    async "semantic.expire-private"(payload) {
      return { outcome: await dependencies.repository.expirePrivate(payload) };
    },
  };
}

function isDegradedCompletion(run: SemanticRunContext): boolean {
  return run.completedAt !== null && run.degraded === true;
}

async function persistHonestGenerationFailure(
  dependencies: SemanticGenerationJobHandlerDependencies,
  run: SemanticRunContext,
  error: unknown,
): Promise<{ outcome: "failed"; degraded: true }> {
  if (!(error instanceof SemanticGenerationFailedError)) {
    throw error;
  }
  await dependencies.repository.persistFailedGeneration(
    run,
    error.metadata,
    error.failure,
  );
  return { outcome: "failed", degraded: true };
}

// Keep the worker service constructor reachable from the stable Gate-4 module.
export { createSemanticGenerationService };

export type SemanticLearningJobPayload =
  JobPayload<"semantic.generate-learning">;
