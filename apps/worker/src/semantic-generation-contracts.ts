import type { JobName, JobPayload } from "@slopproof/db";
import type { GenerationContextV1 } from "@slopproof/analysis";
import type {
  ContributorPracticeAnswerV1Schema,
  PayloadCipher,
  SemanticProviderInvocationMetadataV1,
} from "@slopproof/providers";
import type {
  ForbiddenProofContentV1,
  LearningBundleV1,
  PracticeFeedbackV1,
  PracticeQuestionV2,
  ProofQuestionPlanV2,
} from "@slopproof/questions";
import type { PoolClient } from "pg";
import type { z } from "zod";
import type {
  SemanticGenerationResultV1,
  SemanticGenerationService,
} from "./semantic-generation";

export type SemanticGenerationJobName =
  | "semantic.generate-learning"
  | "semantic.generate-practice-feedback"
  | "semantic.generate-proof-questions"
  | "semantic.expire-private";

export interface SemanticTransactionalScheduler {
  schedule<Name extends SemanticGenerationJobName>(
    client: PoolClient,
    name: Name,
    payload: JobPayload<Name>,
    startAfter?: Date,
  ): Promise<void>;
  /** Recover a failed singleton or expedite/upsert the oldest aggregate job. */
  recoverOrExpedite<Name extends SemanticGenerationJobName>(
    client: PoolClient,
    name: Name,
    payload: JobPayload<Name>,
    startAfter?: Date,
  ): Promise<void>;
  scheduleAttemptExpiry(
    client: PoolClient,
    payload: JobPayload<"proof.expire-attempt">,
    startAfter: Date,
  ): Promise<void>;
}

export type SemanticRunContext = {
  runId: string;
  idempotencyKey: string;
  repositoryId: string;
  revisionId: string;
  generationContextId: string;
  authorId: string;
  repositoryPolicyId: string;
  generationContext: GenerationContextV1;
  artifactSeed: string;
  questionCount: number;
  createdAt: Date;
  deadlineAt: Date;
  deleteAfter: Date;
  completedArtifactId: string | null;
};

export type StartPracticeSessionInput = {
  repositoryId: string;
  revisionId: string;
  generationContextId: string;
  learningBundleId: string;
  userId: string;
  actorKeyHash: string;
};

export type SubmitPracticeAnswerInput = {
  repositoryId: string;
  revisionId: string;
  generationContextId: string;
  practiceSessionId: string;
  practiceQuestionId: string;
  userId: string;
  actorKeyHash: string;
  answer: z.infer<typeof ContributorPracticeAnswerV1Schema>;
};

export type ScheduleRevisionSemanticGenerationInput = {
  repositoryId: string;
  revisionId: string;
  generationContextId: string;
  repositoryPolicyId: string;
  headSha: string;
  questionBudget: number;
};

export type ReadPracticeViewInput = {
  repositoryId: string;
  revisionId: string;
  generationContextId: string;
  userId: string;
  practiceSessionId?: string;
};

export type PracticePatchPreview = {
  title: string;
  anchors: Array<{
    id: string;
    file: string;
    hunkHeader: string;
    oldStart: number;
    newStart: number;
    changedLines: number;
    evidence: string;
  }>;
};

export type PracticeView =
  | { state: "unavailable" }
  | { state: "generating"; revisionId: string; headSha: string }
  | { state: "generation_failed"; revisionId: string; headSha: string }
  | {
      state: "ready";
      revisionId: string;
      headSha: string;
      patchPreview: PracticePatchPreview;
      learning: LearningBundleV1;
      practiceSession: null | {
        id: string;
        deleteAfter: Date;
        questions: PracticeQuestionV2[];
        pendingQuestionIds: string[];
        answersByQuestionId: Record<string, string>;
        feedbackByQuestionId: Record<string, PracticeFeedbackV1>;
      };
    };

export interface SemanticProofReadyWriter {
  write(
    client: PoolClient,
    input: {
      revisionId: string;
      headSha: string;
      attemptId: string;
      proofPlanId: string;
      expiresAt: Date;
      idempotencyKey: string;
    },
  ): Promise<void>;
  fail(
    client: PoolClient,
    input: {
      revisionId: string;
      generationContextId: string;
      headSha: string;
      errorClass: string;
      idempotencyKey: string;
    },
  ): Promise<void>;
}

export interface SemanticGenerationRepository {
  scheduleRevisionSemanticGeneration(
    client: PoolClient,
    input: ScheduleRevisionSemanticGenerationInput,
  ): Promise<"created" | "replayed">;
  reserveRun(
    name:
      | "semantic.generate-learning"
      | "semantic.generate-practice-feedback"
      | "semantic.generate-proof-questions",
    payload:
      | JobPayload<"semantic.generate-learning">
      | JobPayload<"semantic.generate-practice-feedback">
      | JobPayload<"semantic.generate-proof-questions">,
  ): Promise<SemanticRunContext | "stale" | "proof_pending">;
  loadPracticeQuestionAndAnswer(
    run: SemanticRunContext,
    payload: JobPayload<"semantic.generate-practice-feedback">,
  ): Promise<{
    question: PracticeQuestionV2;
    answer: z.infer<typeof ContributorPracticeAnswerV1Schema>;
  }>;
  loadFrozenProofContent(
    run: SemanticRunContext,
  ): Promise<ForbiddenProofContentV1 | "pending">;
  persistLearning(
    run: SemanticRunContext,
    result: SemanticGenerationResultV1<LearningBundleV1>,
  ): Promise<"created" | "replayed">;
  persistPracticeFeedback(
    run: SemanticRunContext,
    payload: JobPayload<"semantic.generate-practice-feedback">,
    result: SemanticGenerationResultV1<PracticeFeedbackV1>,
  ): Promise<"created" | "replayed">;
  persistProofPlanAndCreateAttempt(
    run: SemanticRunContext,
    result: SemanticGenerationResultV1<ProofQuestionPlanV2>,
  ): Promise<
    | { outcome: "created" | "replayed" | "recovered"; attemptId: string }
    | { outcome: "existing_attempt_conflict" | "stale" }
  >;
  replayCompletedProof(
    run: SemanticRunContext,
  ): Promise<
    | { outcome: "replayed" | "recovered"; attemptId: string }
    | { outcome: "stale" | "existing_attempt_conflict" }
  >;
  failProofPreparation(
    payload: JobPayload<"semantic.generate-proof-questions">,
    errorClass: string,
  ): Promise<"failed" | "stale">;
  expirePrivate(
    payload: JobPayload<"semantic.expire-private">,
  ): Promise<"deleted" | "replayed">;
  startPracticeSession(
    input: StartPracticeSessionInput,
  ): Promise<{ sessionId: string; deleteAfter: Date }>;
  submitPracticeAnswer(
    input: SubmitPracticeAnswerInput,
  ): Promise<{ answerId: string; replayed: boolean }>;
  readPracticeView(input: ReadPracticeViewInput): Promise<PracticeView>;
  sweepDueSemanticPrivate(
    now: Date,
    limit?: number,
  ): Promise<{ scanned: number; requeued: number }>;
}

export type SemanticGenerationJobHandlers = {
  [Name in SemanticGenerationJobName]: (
    payload: JobPayload<Name>,
  ) => Promise<unknown>;
};

export type SemanticGenerationJobHandlerDependencies = {
  repository: SemanticGenerationRepository;
  service: SemanticGenerationService;
};

export function semanticPrivateAad(input: {
  kind: "learning_bundle" | "practice_answer" | "practice_feedback";
  repositoryId: string;
  revisionId: string;
  sessionId?: string;
  questionId?: string;
  artifactId: string;
}): string {
  return [
    "slopproof-semantic-private-v1",
    input.kind,
    input.repositoryId,
    input.revisionId,
    input.sessionId ?? "none",
    input.questionId ?? "none",
    input.artifactId,
  ].join(":");
}

export type SemanticCipher = Pick<PayloadCipher, "encryptJson" | "decryptJson">;

export function metadataHasNoContent(
  _metadata: SemanticProviderInvocationMetadataV1,
): true {
  return true;
}

// Compile-time guard: only registered job names can enter the scheduler port.
const _jobNameGuard: SemanticGenerationJobName extends JobName ? true : never =
  true;
void _jobNameGuard;
