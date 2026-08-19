import type { JobPayload } from "@slopproof/db";
import { describe, expect, it, vi } from "vitest";
import type { GenerationContextV1 } from "@slopproof/analysis";
import { createSemanticGenerationJobHandlers } from "./semantic-generation-jobs";
import type {
  SemanticGenerationRepository,
  SemanticRunContext,
} from "./semantic-generation-contracts";
import type { SemanticGenerationService } from "./semantic-generation";

describe("semantic generation job handlers", () => {
  it("does not start Learning generation while Proof is pending", async () => {
    const generateLearningBundle = vi.fn(async () => {
      throw new Error("Learning must not generate while Proof is pending");
    });
    const loadFrozenProofContent = vi.fn(async () => {
      throw new Error("Learning must not load Proof while still pending");
    });
    const handlers = createSemanticGenerationJobHandlers({
      repository: repositoryStub({
        reserveRun: vi.fn(async () => "proof_pending" as const),
        loadFrozenProofContent,
      }),
      service: serviceStub({ generateLearningBundle }),
    });

    await expect(
      handlers["semantic.generate-learning"](learningPayload()),
    ).resolves.toEqual({ outcome: "proof_pending" });
    expect(loadFrozenProofContent).not.toHaveBeenCalled();
    expect(generateLearningBundle).not.toHaveBeenCalled();
  });

  it("gives Learning the reserved generate window once Proof content exists", async () => {
    const createdAt = new Date("2026-08-19T15:46:12.000Z");
    const deadlineAt = new Date("2026-08-19T15:54:12.000Z");
    const generateLearningBundle = vi.fn(async (request: unknown) => {
      void request;
      return {
        artifact: { id: "82000000-0000-4000-8000-000000000021" },
        providerMetadata: {},
        providerFailure: null,
        degraded: false,
      } as Awaited<
        ReturnType<SemanticGenerationService["generateLearningBundle"]>
      >;
    });
    const persistLearning = vi.fn(async () => "created" as const);
    const handlers = createSemanticGenerationJobHandlers({
      repository: repositoryStub({
        reserveRun: vi.fn(async () =>
          runFixture({
            createdAt,
            deadlineAt,
          }),
        ),
        loadFrozenProofContent: vi.fn(async () => [
          "Explain the exact cache-miss return change.",
        ]),
        persistLearning,
      }),
      service: serviceStub({ generateLearningBundle }),
    });

    await expect(
      handlers["semantic.generate-learning"](learningPayload()),
    ).resolves.toEqual({
      outcome: "created",
      artifactId: "82000000-0000-4000-8000-000000000021",
      degraded: false,
    });
    expect(generateLearningBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactCreatedAt: createdAt,
        deadlineAt,
        forbiddenProofContent: ["Explain the exact cache-miss return change."],
      }),
    );
    expect(deadlineAt.getTime() - createdAt.getTime()).toBe(8 * 60_000);
  });
});

function learningPayload(): JobPayload<"semantic.generate-learning"> {
  return {
    schemaVersion: "1",
    idempotencyKey: "semantic.learning.v3:82000000-0000-4000-8000-000000000003",
    artifactKind: "learning_bundle_v1",
    revisionId: "82000000-0000-4000-8000-000000000002",
    generationContextId: "82000000-0000-4000-8000-000000000003",
    expectedHeadSha: "a".repeat(40),
  };
}

function runFixture(input: {
  createdAt: Date;
  deadlineAt: Date;
}): SemanticRunContext {
  return {
    runId: "82000000-0000-4000-8000-000000000099",
    idempotencyKey: learningPayload().idempotencyKey,
    repositoryId: "82000000-0000-4000-8000-000000000001",
    revisionId: learningPayload().revisionId,
    generationContextId: learningPayload().generationContextId,
    authorId: "author-1",
    repositoryPolicyId: "82000000-0000-4000-8000-000000000004",
    generationContext: {
      headSha: learningPayload().expectedHeadSha,
    } as GenerationContextV1,
    artifactSeed: "9".repeat(64),
    questionCount: 3,
    createdAt: input.createdAt,
    deadlineAt: input.deadlineAt,
    deleteAfter: new Date("2026-08-20T15:46:12.000Z"),
    completedArtifactId: null,
  };
}

function repositoryStub(
  overrides: Partial<SemanticGenerationRepository>,
): SemanticGenerationRepository {
  return {
    scheduleRevisionSemanticGeneration: vi.fn(),
    reserveRun: vi.fn(),
    loadPracticeQuestionAndAnswer: vi.fn(),
    loadFrozenProofContent: vi.fn(),
    persistLearning: vi.fn(),
    persistPracticeFeedback: vi.fn(),
    persistProofPlanAndCreateAttempt: vi.fn(),
    replayCompletedProof: vi.fn(),
    expirePrivate: vi.fn(),
    startPracticeSession: vi.fn(),
    submitPracticeAnswer: vi.fn(),
    readPracticeView: vi.fn(),
    sweepDueSemanticPrivate: vi.fn(),
    ...overrides,
  } as SemanticGenerationRepository;
}

function serviceStub(
  overrides: Partial<SemanticGenerationService>,
): SemanticGenerationService {
  return {
    generateLearningBundle: vi.fn(),
    generatePracticeFeedback: vi.fn(),
    generateProofQuestionPlan: vi.fn(),
    ...overrides,
  } as SemanticGenerationService;
}
