import { createHash } from "node:crypto";
import {
  EvaluationApplyPolicyJobSchema,
  EvaluationRunJobSchema,
  MediaSelectFramesJobSchema,
  expediteJob,
  parseJobPayload,
  registerJobWorker,
} from "@slopproof/db";
import { applyRepositoryPolicyV1 } from "@slopproof/policy";
import {
  FrameSelectionMetadataV1Schema,
  type InlineMultimodalJudgeProvider,
  LocalFakeMultimodalJudgeProvider,
  LocalFakeTranscriptionProvider,
  PayloadCipher,
  ProofEvaluationInputV1Schema,
  ProofEvaluationV1Schema,
  ProviderError,
  TranscriptV1Schema,
  validateProofEvaluationAgainstInput,
  type FrameSelectionMetadataV1,
  type MultimodalJudgeProvider,
  type ProviderClock,
  type ProviderContextV1,
  type ProofEvaluationV1,
  type TranscriptV1,
  type TranscriptionProvider,
} from "@slopproof/providers";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import {
  EncryptedEvaluationBundleV1Schema,
  EncryptedTranscriptBundleV1Schema,
  FrameSelectionStageBundleV1Schema,
  PrivateProviderStageUnavailableError,
  ProviderPipelineStageResultV1Schema,
  type EncryptedEvaluationBundleV1,
  type EvaluationRunContextV1,
  type ProviderPipelineDispatcher,
  type ProviderPipelineJobName,
  type ProviderPipelineJobPayload,
  type ProviderPipelineRepository,
  type ProviderPipelineStageResultV1,
  type StoredProofQuestionV1,
} from "./provider-pipeline-contracts";
import type {
  EncryptedRecordingAudioTranscriptionAdapter,
  RecordingCiphertextAccess,
} from "./audio-transcription";
import type { InlineFrameNormalizationDependencies } from "./inline-frame-normalization";
import {
  runMultimodalJudgeEvaluation,
  type MultimodalProofEvaluationV1,
} from "./multimodal-judge-service";
import {
  MultimodalEvaluationPersistenceError,
  type MultimodalEvaluationRepository,
} from "./multimodal-evaluation-repository";

const StoredAnchorSchema = z
  .object({
    id: z.string().regex(/^a[0-9]+$/),
    file: z.string().min(1).max(1_024),
    hunkHeader: z.string().min(1).max(500),
    oldStart: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    changedLines: z.number().int().positive(),
    evidence: z.string().min(1).max(500),
  })
  .strict();

const StoredRubricSchema = z
  .object({
    requiredPoints: z.array(z.string().min(5).max(300)).min(1).max(8),
    rejectsGenericAnswer: z.literal(true),
  })
  .strict();

export interface ProviderFrameSelectionAdapter {
  /**
   * Non-empty selections may reference external ciphertext only after its final
   * object key is durably registered for retention. This keeps a crash between
   * adapter return and repository persistence from creating an orphan object.
   */
  select(input: {
    attemptId: string;
    recordingObjectId: string;
    recordingDurationMs: number;
    transcript: TranscriptV1;
  }): Promise<FrameSelectionMetadataV1>;
}

/** Local MVP adapter: no image bytes or phantom object references are created. */
export class EmptyLocalFrameSelectionAdapter implements ProviderFrameSelectionAdapter {
  async select(input: {
    attemptId: string;
    recordingDurationMs: number;
  }): Promise<FrameSelectionMetadataV1> {
    return FrameSelectionMetadataV1Schema.parse({
      schemaVersion: "1",
      selectionVersion: "frame-selection-v1",
      attemptId: input.attemptId,
      recordingDurationMs: input.recordingDurationMs,
      frames: [],
    });
  }
}

export type ProviderPipelineDependencies = {
  repository: ProviderPipelineRepository;
  dispatcher: ProviderPipelineDispatcher;
  payloadCipher: PayloadCipher;
  transcriptionProvider?: TranscriptionProvider;
  recordingTranscription?: {
    adapter: Pick<EncryptedRecordingAudioTranscriptionAdapter, "transcribe">;
    ciphertextAccess(objectKey: string): RecordingCiphertextAccess;
  };
  frameSelectionAdapter: ProviderFrameSelectionAdapter;
  judgeProvider?: MultimodalJudgeProvider;
  multimodalJudge?: {
    provider: InlineMultimodalJudgeProvider;
    repository: MultimodalEvaluationRepository;
    frameStorage: InlineFrameNormalizationDependencies["storage"];
    evaluate?: typeof runMultimodalJudgeEvaluation;
  };
  clock: ProviderClock;
  providerTimeoutMs?: number;
  fakeTranscriptText?: (question: StoredProofQuestionV1) => string;
};

export type ProviderPipelineHandlers = {
  extractTranscript(rawJob: unknown): Promise<ProviderPipelineStageResultV1>;
  selectFrames(rawJob: unknown): Promise<ProviderPipelineStageResultV1>;
  runEvaluation(rawJob: unknown): Promise<ProviderPipelineStageResultV1>;
  applyPolicy(rawJob: unknown): Promise<ProviderPipelineStageResultV1>;
};

class Gate5ReviewOnlyMultimodalJudgeProvider implements MultimodalJudgeProvider {
  async evaluate(): Promise<never> {
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "review",
      "Multimodal evaluation requires the private Gate 6 result sidecar",
    );
  }
}

/**
 * Gate 5 owns private transcription, not the persisted multimodal result
 * contract introduced by Gate 6. Local development keeps its deterministic
 * fake, while production fails the later judge stage closed to manual review
 * instead of either refusing to start or silently using a fake provider.
 */
export function createGate5MultimodalJudgeBoundary(
  provider: "fake" | "hetzner",
  clock: ProviderClock,
): MultimodalJudgeProvider {
  return provider === "fake"
    ? new LocalFakeMultimodalJudgeProvider(clock)
    : new Gate5ReviewOnlyMultimodalJudgeProvider();
}

export function decryptVersionedProviderPayload<T>(
  cipher: PayloadCipher,
  encryptedPayload: string,
  associatedData: string,
  schema: z.ZodType<T>,
): T {
  try {
    const plaintext = cipher.decrypt(
      JSON.parse(encryptedPayload),
      associatedData,
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed: unknown = JSON.parse(
      decoded,
      (key: string, value: unknown) => {
        if (key === "createdAt" && typeof value === "string") {
          return new Date(value);
        }
        return value;
      },
    );
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "INVALID_CIPHER_PAYLOAD",
      "terminal",
      "Encrypted provider payload is not valid versioned JSON",
      { cause: error },
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("SHA-256 did not produce enough bytes");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function nextIdempotencyKey(source: string, stage: string): string {
  return `provider-pipeline:${stage}:${sha256(source).slice(0, 48)}`;
}

function transcriptAad(attemptId: string, transcriptId: string): string {
  return `slopproof:transcript:v1:${attemptId}:${transcriptId}`;
}

function evaluationAad(attemptId: string, evaluationId: string): string {
  return `slopproof:evaluation:v1:${attemptId}:${evaluationId}`;
}

export function createConservativeCompatibilityEvaluationBundle(input: {
  evaluationInput: z.infer<typeof ProofEvaluationInputV1Schema>;
  multimodalEvaluation: MultimodalProofEvaluationV1;
  transcriptId: string;
  deleteAfter: Date;
  payloadCipher: PayloadCipher;
}): EncryptedEvaluationBundleV1 {
  const { evaluationInput, multimodalEvaluation } = input;
  if (
    multimodalEvaluation.attemptId !== evaluationInput.attemptId ||
    multimodalEvaluation.revisionId !== evaluationInput.revisionId ||
    multimodalEvaluation.headSha !== evaluationInput.headSha ||
    multimodalEvaluation.workflowOutcome !== "review_required" ||
    !multimodalEvaluation.manualReviewRequired
  ) {
    throw new ProviderError(
      "INVALID_OUTPUT",
      "review",
      "Multimodal evaluation is not bound to its stored input",
    );
  }
  const inputQuestions = new Map(
    evaluationInput.questions.map((question) => [question.id, question]),
  );
  const seenQuestions = new Set<string>();
  const questionEvaluations =
    multimodalEvaluation.candidate.questionEvaluations.map((question) => {
      const stored = inputQuestions.get(question.questionId);
      if (stored === undefined || seenQuestions.has(question.questionId)) {
        throw new ProviderError(
          "UNKNOWN_QUESTION_ID",
          "review",
          "Multimodal evaluation references an unknown stored question",
        );
      }
      seenQuestions.add(question.questionId);
      const storedCriterionIds = new Set(
        stored.rubric.map((criterion) => criterion.id),
      );
      const seenCriterionIds = new Set<string>();
      for (const criterion of question.criterionResults) {
        if (
          !storedCriterionIds.has(criterion.criterionId) ||
          seenCriterionIds.has(criterion.criterionId)
        ) {
          throw new ProviderError(
            "RUBRIC_MISMATCH",
            "review",
            "Multimodal evaluation does not cover the exact stored rubric",
          );
        }
        seenCriterionIds.add(criterion.criterionId);
      }
      if (
        seenCriterionIds.size !== storedCriterionIds.size ||
        [...storedCriterionIds].some(
          (criterionId) => !seenCriterionIds.has(criterionId),
        )
      ) {
        throw new ProviderError(
          "RUBRIC_MISMATCH",
          "review",
          "Multimodal evaluation does not cover the exact stored rubric",
        );
      }

      const hasNotEvaluable = question.criterionResults.some(
        (criterion) => criterion.result === "not_evaluable",
      );
      const evaluable = question.criterionResults.filter(
        (criterion) => criterion.result !== "not_evaluable",
      );
      const rubricFindings = evaluable.map((criterion) => ({
        criterionId: criterion.criterionId,
        result: criterion.result,
        reason:
          criterion.result === "met"
            ? "Compatibility projection: stored criterion has bounded support; consult authoritative sidecar."
            : "Compatibility projection: stored criterion lacks bounded support; consult authoritative sidecar.",
      }));
      if (rubricFindings.length === 0) {
        rubricFindings.push({
          criterionId: deterministicUuid(
            `multimodal-compatibility-sentinel:${evaluationInput.attemptId}:${question.questionId}`,
          ),
          result: "met",
          reason: "Compatibility-only sentinel; consult authoritative sidecar.",
        });
      }
      const outcome = hasNotEvaluable
        ? "not_evaluable"
        : evaluable.every((criterion) => criterion.result === "met")
          ? "met"
          : evaluable.every((criterion) => criterion.result === "not_met")
            ? "not_met"
            : "partial";
      return {
        questionId: question.questionId,
        outcome,
        rubricFindings,
        supportedPatchAnchorIds: [
          ...new Set(
            evaluable.flatMap((criterion) => criterion.supportedPatchAnchorIds),
          ),
        ],
        reason:
          "Compatibility-only manual-review projection; authoritative criterion results remain in the encrypted sidecar.",
      };
    });
  if (seenQuestions.size !== inputQuestions.size) {
    throw new ProviderError(
      "UNKNOWN_QUESTION_ID",
      "review",
      "Multimodal evaluation omits a stored question",
    );
  }

  const evaluationId = deterministicUuid(
    [
      "multimodal-compatibility-v1",
      evaluationInput.attemptId,
      evaluationInput.revisionId,
      evaluationInput.headSha,
      input.transcriptId,
      multimodalEvaluation.invocationMetadata.inputHash,
    ].join(":"),
  );
  const compatibility = ProofEvaluationV1Schema.parse({
    schemaVersion: "1",
    evaluationVersion: "proof-evaluation-v1",
    attemptId: evaluationInput.attemptId,
    revisionId: evaluationInput.revisionId,
    headSha: evaluationInput.headSha,
    provider: "multimodal-compatibility-v1",
    model: "manual-review-projection-v1",
    systemInstructionVersion: "proof-judge-system-v1",
    recommendation: "review_required",
    questionEvaluations,
    privateReason:
      "Compatibility-only projection; maintainer review and the authoritative encrypted multimodal sidecar are required.",
    warnings: ["authoritative_multimodal_sidecar_required"],
    createdAt: multimodalEvaluation.createdAt,
  });
  return EncryptedEvaluationBundleV1Schema.parse({
    schemaVersion: "1",
    payloadKind: "proof_evaluation",
    evaluationId,
    attemptId: evaluationInput.attemptId,
    provider: compatibility.provider,
    model: compatibility.model,
    promptVersion: compatibility.systemInstructionVersion,
    evaluationSchemaVersion: compatibility.evaluationVersion,
    rubricVersion: "rubric-v1",
    recommendation: "review_required",
    encryptedPayload: JSON.stringify(
      input.payloadCipher.encryptJson(
        compatibility,
        evaluationAad(evaluationInput.attemptId, evaluationId),
      ),
    ),
    deleteAfter: input.deleteAfter,
  });
}

function providerContext(
  attemptId: string,
  idempotencyKey: string,
  dependencies: ProviderPipelineDependencies,
  deleteAfter?: Date,
): ProviderContextV1 {
  const now = dependencies.clock.now();
  const configuredDeadline =
    now.getTime() + (dependencies.providerTimeoutMs ?? 5 * 60_000);
  return {
    schemaVersion: "1",
    requestId: deterministicUuid(
      `provider-request:${attemptId}:${idempotencyKey}`,
    ),
    attemptId,
    deadlineAt: new Date(
      deleteAfter === undefined
        ? configuredDeadline
        : Math.min(configuredDeadline, deleteAfter.getTime()),
    ),
  };
}

function isPrivateStageEligible(
  context: {
    status: string;
    isCurrent: boolean;
    privateAccessEligible: boolean;
    headSha: string;
    deleteAfter: Date;
  },
  expectedHeadSha: string,
  now: Date,
): boolean {
  return (
    context.status === "processing" &&
    context.isCurrent &&
    context.privateAccessEligible &&
    context.deleteAfter.getTime() > now.getTime() &&
    context.headSha === expectedHeadSha
  );
}

function result(input: {
  stage: ProviderPipelineStageResultV1["stage"];
  outcome: ProviderPipelineStageResultV1["outcome"];
  attemptId: string;
  artifactId?: string;
}): ProviderPipelineStageResultV1 {
  return ProviderPipelineStageResultV1Schema.parse({
    schemaVersion: "1",
    ...input,
  });
}

async function routeProviderFailure(
  error: unknown,
  stage: ProviderPipelineStageResultV1["stage"],
  job: { attemptId: string; expectedHeadSha: string; idempotencyKey: string },
  repository: ProviderPipelineRepository,
): Promise<ProviderPipelineStageResultV1> {
  const providerError =
    error instanceof ProviderError
      ? error
      : error instanceof MultimodalEvaluationPersistenceError
        ? new ProviderError(
            "INVALID_OUTPUT",
            "review",
            "Authoritative multimodal evaluation persistence failed closed",
            { cause: error },
          )
        : error instanceof z.ZodError
          ? new ProviderError(
              "INVALID_INPUT",
              "review",
              "Persisted provider pipeline data failed its versioned schema",
              { cause: error },
            )
          : undefined;
  if (error instanceof PrivateProviderStageUnavailableError) {
    return result({ stage, outcome: "stale", attemptId: job.attemptId });
  }
  if (providerError === undefined) {
    throw error;
  }
  if (providerError.disposition === "review") {
    const transition = await repository.transitionToReviewRequired({
      attemptId: job.attemptId,
      expectedHeadSha: job.expectedHeadSha,
      idempotencyKey: nextIdempotencyKey(job.idempotencyKey, "manual-review"),
      reason: "provider_manual_review",
    });
    return result({
      stage,
      outcome: transition === "stale" ? "stale" : "manual_review",
      attemptId: job.attemptId,
    });
  }
  const transition = await repository.transitionToTechnicalRetry({
    attemptId: job.attemptId,
    expectedHeadSha: job.expectedHeadSha,
    idempotencyKey: nextIdempotencyKey(job.idempotencyKey, "technical-retry"),
    errorClass: providerError.code,
  });
  return result({
    stage,
    outcome: transition === "stale" ? "stale" : "technical_retry",
    attemptId: job.attemptId,
  });
}

function fakeTranscriptSegments(
  questions: StoredProofQuestionV1[],
  durationMs: number,
  textForQuestion: (question: StoredProofQuestionV1) => string,
  intervals?: readonly {
    questionId: string;
    startMs: number;
    endMs: number;
  }[],
) {
  if (intervals !== undefined) {
    if (intervals.length !== questions.length) {
      throw new ProviderError(
        "INVALID_INPUT",
        "terminal",
        "Stored question intervals do not match the proof plan",
      );
    }
    return intervals.map((interval, index) => {
      const question = questions[index];
      if (question === undefined || question.id !== interval.questionId) {
        throw new ProviderError(
          "INVALID_INPUT",
          "terminal",
          "Stored question interval order does not match the proof plan",
        );
      }
      return {
        questionId: question.id,
        startMs: interval.startMs,
        endMs: interval.endMs,
        text: textForQuestion(question),
      };
    });
  }
  if (durationMs < questions.length) {
    throw new ProviderError(
      "INVALID_INPUT",
      "terminal",
      "Recording duration cannot contain the stored question set",
    );
  }
  const slice = Math.floor(durationMs / questions.length);
  return questions.map((question, index) => ({
    questionId: question.id,
    startMs: index * slice,
    endMs: index === questions.length - 1 ? durationMs : (index + 1) * slice,
    text: textForQuestion(question),
  }));
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "concrete",
  "explains",
  "identifies",
  "including",
  "represented",
  "specific",
  "the",
  "this",
  "with",
]);

function requiredTerms(point: string): string[] {
  const words = point
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[a-z0-9][a-z0-9_-]+/g)
    ?.filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return [...new Set(words ?? [])].slice(0, 3).length > 0
    ? [...new Set(words ?? [])].slice(0, 3)
    : ["behavior"];
}

function adaptQuestions(context: EvaluationRunContextV1) {
  const evidence = new Map<
    string,
    {
      anchorId: string;
      filename: {
        trust: "untrusted";
        source: "pull_request_filename";
        content: string;
      };
      patch: {
        trust: "untrusted";
        source: "pull_request_patch";
        content: string;
      };
    }
  >();
  const questions = context.questions.map((stored) => {
    const anchor = StoredAnchorSchema.safeParse(stored.diffAnchor);
    const rubric = StoredRubricSchema.safeParse(stored.rubric);
    if (!anchor.success || !rubric.success) {
      throw new ProviderError(
        "INVALID_INPUT",
        "review",
        "Stored question lacks a supported anchor or exact rubric",
        { cause: anchor.success ? rubric.error : anchor.error },
      );
    }
    evidence.set(anchor.data.id, {
      anchorId: anchor.data.id,
      filename: {
        trust: "untrusted",
        source: "pull_request_filename",
        content: anchor.data.file,
      },
      patch: {
        trust: "untrusted",
        source: "pull_request_patch",
        content: anchor.data.evidence,
      },
    });
    return {
      id: stored.id,
      promptVersion: "proof-questions-v1" as const,
      prompt: stored.prompt,
      patchAnchorIds: [anchor.data.id],
      rubricVersion: "rubric-v1" as const,
      rubric: rubric.data.requiredPoints.map((point, index) => ({
        id: deterministicUuid(
          `provider-rubric:${stored.id}:${String(index)}:${point}`,
        ),
        description: point,
        requiredTerms: requiredTerms(point),
      })),
    };
  });
  return { questions, patchEvidence: [...evidence.values()] };
}

export function createProviderPipelineHandlers(
  dependencies: ProviderPipelineDependencies,
): ProviderPipelineHandlers {
  return {
    async extractTranscript(rawJob) {
      const job = parseJobPayload("media.extract-transcript", rawJob);
      try {
        const context =
          await dependencies.repository.loadTranscriptExtraction(job);
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          return result({
            stage: "media.extract-transcript",
            outcome: "stale",
            attemptId: job.attemptId,
          });
        }
        if (context.existingTranscript !== undefined) {
          const downstreamJob = {
            schemaVersion: "1",
            idempotencyKey: nextIdempotencyKey(
              job.idempotencyKey,
              "select-frames",
            ),
            attemptId: job.attemptId,
            recordingObjectId: job.recordingObjectId,
            transcriptId: context.existingTranscript.transcriptId,
            expectedHeadSha: job.expectedHeadSha,
          } as const;
          const downstreamScheduled =
            await dependencies.repository.schedulePersistedTranscript(
              context.existingTranscript,
              downstreamJob,
            );
          if (!downstreamScheduled) {
            await dependencies.dispatcher.enqueue(
              "media.select-frames",
              downstreamJob,
            );
          }
          return result({
            stage: "media.extract-transcript",
            outcome: "replayed",
            attemptId: job.attemptId,
            artifactId: context.existingTranscript.transcriptId,
          });
        }
        const defaultText = (question: StoredProofQuestionV1) => {
          const rubric = StoredRubricSchema.safeParse(question.rubric);
          return rubric.success
            ? rubric.data.requiredPoints.join(" ")
            : "Local fake transcript fixture for the stored proof question.";
        };
        const requestContext = providerContext(
          job.attemptId,
          job.idempotencyKey,
          dependencies,
          context.deleteAfter,
        );
        let providerTranscript: TranscriptV1;
        if (dependencies.recordingTranscription !== undefined) {
          if (context.recordingAudio === undefined) {
            throw new ProviderError(
              "INVALID_INPUT",
              "terminal",
              "Authenticated question intervals are unavailable for production transcription",
            );
          }
          try {
            providerTranscript =
              await dependencies.recordingTranscription.adapter.transcribe(
                context.recordingAudio.source,
                dependencies.recordingTranscription.ciphertextAccess(
                  context.recordingAudio.objectKey,
                ),
                requestContext,
              );
          } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError(
              "PROVIDER_UNAVAILABLE",
              "retryable",
              "Private recording transcription failed",
              { cause: error },
            );
          }
        } else {
          if (dependencies.transcriptionProvider === undefined) {
            throw new ProviderError(
              "INVALID_INPUT",
              "terminal",
              "No transcription provider is configured",
            );
          }
          providerTranscript =
            await dependencies.transcriptionProvider.transcribe(
              {
                schemaVersion: "1",
                attemptId: job.attemptId,
                sourceSha256: context.recordingManifestHash,
                language: "en",
                durationMs: context.recordingDurationMs,
                segments: fakeTranscriptSegments(
                  context.questions,
                  context.recordingDurationMs,
                  dependencies.fakeTranscriptText ?? defaultText,
                  context.recordingAudio?.source.questionIntervals,
                ),
              },
              requestContext,
            );
        }
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          throw new PrivateProviderStageUnavailableError();
        }
        if (
          providerTranscript.attemptId !== job.attemptId ||
          providerTranscript.sourceSha256 !== context.recordingManifestHash ||
          providerTranscript.durationMs !== context.recordingDurationMs
        ) {
          throw new ProviderError(
            "INVALID_OUTPUT",
            "review",
            "Transcript provider output is not bound to the requested recording",
          );
        }
        const transcript = TranscriptV1Schema.parse({
          ...providerTranscript,
          id: deterministicUuid(
            [
              "transcript",
              job.attemptId,
              job.recordingObjectId,
              providerTranscript.provider,
              providerTranscript.model,
              providerTranscript.transcriptVersion,
            ].join(":"),
          ),
        });
        const encryptedPayload = JSON.stringify(
          dependencies.payloadCipher.encryptJson(
            transcript,
            transcriptAad(job.attemptId, transcript.id),
          ),
        );
        const bundle = EncryptedTranscriptBundleV1Schema.parse({
          schemaVersion: "1",
          payloadKind: "transcript",
          transcriptId: transcript.id,
          attemptId: job.attemptId,
          provider: transcript.provider,
          transcriptSchemaVersion: transcript.transcriptVersion,
          encryptedPayload,
          deleteAfter: context.deleteAfter,
        });
        const downstreamJob = {
          schemaVersion: "1",
          idempotencyKey: nextIdempotencyKey(
            job.idempotencyKey,
            "select-frames",
          ),
          attemptId: job.attemptId,
          recordingObjectId: job.recordingObjectId,
          transcriptId: transcript.id,
          expectedHeadSha: job.expectedHeadSha,
        } as const;
        const persistence =
          await dependencies.repository.persistTranscript(bundle);
        await dependencies.dispatcher.enqueue("media.select-frames", {
          ...downstreamJob,
          transcriptId: persistence.transcript.transcriptId,
        });
        return result({
          stage: "media.extract-transcript",
          outcome: persistence.status === "created" ? "completed" : "replayed",
          attemptId: job.attemptId,
          artifactId: persistence.transcript.transcriptId,
        });
      } catch (error) {
        return routeProviderFailure(
          error,
          "media.extract-transcript",
          job,
          dependencies.repository,
        );
      }
    },

    async selectFrames(rawJob) {
      const job = parseJobPayload("media.select-frames", rawJob);
      try {
        const context = await dependencies.repository.loadFrameSelection(job);
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          return result({
            stage: "media.select-frames",
            outcome: "stale",
            attemptId: job.attemptId,
          });
        }
        const transcript = decryptVersionedProviderPayload(
          dependencies.payloadCipher,
          context.transcript.encryptedPayload,
          transcriptAad(job.attemptId, job.transcriptId),
          TranscriptV1Schema,
        );
        let metadata: FrameSelectionMetadataV1;
        try {
          metadata = await dependencies.frameSelectionAdapter.select({
            attemptId: job.attemptId,
            recordingObjectId: context.recordingObjectId,
            recordingDurationMs: context.recordingDurationMs,
            transcript,
          });
        } catch (error) {
          if (
            error instanceof ProviderError ||
            error instanceof PrivateProviderStageUnavailableError
          ) {
            throw error;
          }
          throw new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "retryable",
            "Private frame selection failed",
            { cause: error },
          );
        }
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          throw new PrivateProviderStageUnavailableError();
        }
        const bundle = FrameSelectionStageBundleV1Schema.parse({
          schemaVersion: "1",
          payloadKind: "frame_selection",
          attemptId: job.attemptId,
          metadata,
        });
        const persisted =
          await dependencies.repository.persistFrameSelection(bundle);
        await dependencies.dispatcher.enqueue("evaluation.run", {
          schemaVersion: "1",
          idempotencyKey: nextIdempotencyKey(
            job.idempotencyKey,
            "run-evaluation",
          ),
          attemptId: job.attemptId,
          transcriptId: job.transcriptId,
          expectedHeadSha: job.expectedHeadSha,
        });
        return result({
          stage: "media.select-frames",
          outcome: persisted === "created" ? "completed" : "replayed",
          attemptId: job.attemptId,
        });
      } catch (error) {
        return routeProviderFailure(
          error,
          "media.select-frames",
          job,
          dependencies.repository,
        );
      }
    },

    async runEvaluation(rawJob) {
      const job = parseJobPayload("evaluation.run", rawJob);
      try {
        const context = await dependencies.repository.loadEvaluationRun(job);
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          return result({
            stage: "evaluation.run",
            outcome: "stale",
            attemptId: job.attemptId,
          });
        }
        const downstreamJobBase = {
          schemaVersion: "1" as const,
          idempotencyKey: nextIdempotencyKey(
            job.idempotencyKey,
            "apply-policy",
          ),
          attemptId: job.attemptId,
          expectedHeadSha: job.expectedHeadSha,
        };
        if (dependencies.multimodalJudge !== undefined) {
          const existing =
            await dependencies.multimodalJudge.repository.loadExistingAndSchedule(
              {
                attemptId: job.attemptId,
                transcriptId: job.transcriptId,
                expectedHeadSha: job.expectedHeadSha,
                downstreamJobBase,
              },
            );
          if (existing !== null) {
            if (!existing.downstreamScheduled) {
              await dependencies.dispatcher.enqueue("evaluation.apply-policy", {
                ...downstreamJobBase,
                evaluationId: existing.compatibilityEvaluation.evaluationId,
              });
            }
            return result({
              stage: "evaluation.run",
              outcome: "replayed",
              attemptId: job.attemptId,
              artifactId: existing.compatibilityEvaluation.evaluationId,
            });
          }
          if (context.existingEvaluation !== undefined) {
            throw new ProviderError(
              "INVALID_OUTPUT",
              "review",
              "A compatibility evaluation exists without its authoritative multimodal sidecar",
            );
          }
        } else if (context.existingEvaluation !== undefined) {
          const downstreamJob = {
            ...downstreamJobBase,
            evaluationId: context.existingEvaluation.evaluationId,
          } as const;
          const downstreamScheduled =
            await dependencies.repository.schedulePersistedEvaluation(
              context.existingEvaluation,
              downstreamJob,
            );
          if (!downstreamScheduled) {
            await dependencies.dispatcher.enqueue(
              "evaluation.apply-policy",
              downstreamJob,
            );
          }
          return result({
            stage: "evaluation.run",
            outcome: "replayed",
            attemptId: job.attemptId,
            artifactId: context.existingEvaluation.evaluationId,
          });
        }
        const transcript = decryptVersionedProviderPayload(
          dependencies.payloadCipher,
          context.transcript.encryptedPayload,
          transcriptAad(job.attemptId, job.transcriptId),
          TranscriptV1Schema,
        );
        const adapted = adaptQuestions(context);
        const evaluationInput = ProofEvaluationInputV1Schema.parse({
          schemaVersion: "1",
          inputVersion: "proof-evaluation-input-v1",
          attemptId: job.attemptId,
          revisionId: context.revisionId,
          headSha: context.headSha,
          systemInstructionVersion: "proof-judge-system-v1",
          questions: adapted.questions,
          patchEvidence: adapted.patchEvidence,
          transcript,
          frameSelection: context.frameSelection,
        });
        if (dependencies.multimodalJudge !== undefined) {
          const requestContext = providerContext(
            job.attemptId,
            job.idempotencyKey,
            dependencies,
            context.deleteAfter,
          );
          const evaluate =
            dependencies.multimodalJudge.evaluate ??
            runMultimodalJudgeEvaluation;
          const multimodalEvaluation = await evaluate(
            evaluationInput,
            requestContext,
            {
              provider: dependencies.multimodalJudge.provider,
              frameDependencies: {
                storage: dependencies.multimodalJudge.frameStorage,
                payloadCipher: dependencies.payloadCipher,
              },
              now: () => dependencies.clock.now(),
            },
          );
          if (
            !isPrivateStageEligible(
              context,
              job.expectedHeadSha,
              dependencies.clock.now(),
            )
          ) {
            throw new PrivateProviderStageUnavailableError();
          }
          const compatibilityEvaluation =
            createConservativeCompatibilityEvaluationBundle({
              evaluationInput,
              multimodalEvaluation,
              transcriptId: job.transcriptId,
              deleteAfter: context.deleteAfter,
              payloadCipher: dependencies.payloadCipher,
            });
          const persistence =
            await dependencies.multimodalJudge.repository.persistPair({
              multimodalEvaluation,
              evaluationInputHash:
                multimodalEvaluation.invocationMetadata.inputHash,
              transcriptId: job.transcriptId,
              deleteAfter: context.deleteAfter,
              compatibilityEvaluation,
              downstreamJob: {
                ...downstreamJobBase,
                evaluationId: compatibilityEvaluation.evaluationId,
              },
            });
          if (!persistence.downstreamScheduled) {
            await dependencies.dispatcher.enqueue("evaluation.apply-policy", {
              ...downstreamJobBase,
              evaluationId: persistence.compatibilityEvaluation.evaluationId,
            });
          }
          return result({
            stage: "evaluation.run",
            outcome:
              persistence.status === "created" ? "completed" : "replayed",
            attemptId: job.attemptId,
            artifactId: persistence.compatibilityEvaluation.evaluationId,
          });
        }
        if (dependencies.judgeProvider === undefined) {
          throw new ProviderError(
            "INVALID_INPUT",
            "review",
            "No multimodal judge path is configured",
          );
        }
        let providerEvaluation: ProofEvaluationV1;
        try {
          providerEvaluation = await dependencies.judgeProvider.evaluate(
            evaluationInput,
            providerContext(
              job.attemptId,
              job.idempotencyKey,
              dependencies,
              context.deleteAfter,
            ),
          );
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError(
            "PROVIDER_UNAVAILABLE",
            "retryable",
            "Private multimodal evaluation failed",
            { cause: error },
          );
        }
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          throw new PrivateProviderStageUnavailableError();
        }
        const evaluation = validateProofEvaluationAgainstInput(
          providerEvaluation,
          evaluationInput,
        );
        const evaluationId = deterministicUuid(
          [
            "evaluation",
            job.attemptId,
            evaluation.provider,
            evaluation.model,
            evaluation.systemInstructionVersion,
            evaluation.evaluationVersion,
            "rubric-v1",
          ].join(":"),
        );
        const encryptedPayload = JSON.stringify(
          dependencies.payloadCipher.encryptJson(
            evaluation,
            evaluationAad(job.attemptId, evaluationId),
          ),
        );
        const bundle = EncryptedEvaluationBundleV1Schema.parse({
          schemaVersion: "1",
          payloadKind: "proof_evaluation",
          evaluationId,
          attemptId: job.attemptId,
          provider: evaluation.provider,
          model: evaluation.model,
          promptVersion: evaluation.systemInstructionVersion,
          evaluationSchemaVersion: evaluation.evaluationVersion,
          rubricVersion: "rubric-v1",
          recommendation: evaluation.recommendation,
          encryptedPayload,
          deleteAfter: context.deleteAfter,
        });
        const downstreamJob = {
          ...downstreamJobBase,
          evaluationId,
        } as const;
        const persistence =
          await dependencies.repository.persistEvaluation(bundle);
        await dependencies.dispatcher.enqueue("evaluation.apply-policy", {
          ...downstreamJob,
          evaluationId: persistence.evaluation.evaluationId,
        });
        return result({
          stage: "evaluation.run",
          outcome: persistence.status === "created" ? "completed" : "replayed",
          attemptId: job.attemptId,
          artifactId: persistence.evaluation.evaluationId,
        });
      } catch (error) {
        return routeProviderFailure(
          error,
          "evaluation.run",
          job,
          dependencies.repository,
        );
      }
    },

    async applyPolicy(rawJob) {
      const job = parseJobPayload("evaluation.apply-policy", rawJob);
      try {
        const context = await dependencies.repository.loadEvaluationPolicy(job);
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          return result({
            stage: "evaluation.apply-policy",
            outcome:
              context.status === "review_required" ? "replayed" : "stale",
            attemptId: job.attemptId,
            artifactId: job.evaluationId,
          });
        }
        const evaluation = decryptVersionedProviderPayload(
          dependencies.payloadCipher,
          context.evaluation.encryptedPayload,
          evaluationAad(job.attemptId, job.evaluationId),
          ProofEvaluationV1Schema,
        );
        if (
          evaluation.recommendation !== context.evaluation.recommendation ||
          evaluation.attemptId !== job.attemptId ||
          evaluation.headSha !== context.headSha
        ) {
          throw new ProviderError(
            "INVALID_OUTPUT",
            "review",
            "Stored evaluation metadata does not match its encrypted payload",
          );
        }
        const decision = applyRepositoryPolicyV1(context.repositoryPolicy, {
          attemptId: job.attemptId,
          revisionId: context.revisionId,
          evaluationId: job.evaluationId,
          expectedHeadSha: job.expectedHeadSha,
          currentHeadSha: context.headSha,
          recommendation: evaluation.recommendation,
          evaluatedQuestionIds: evaluation.questionEvaluations.map(
            (question) => question.questionId,
          ),
        });
        if (
          !isPrivateStageEligible(
            context,
            job.expectedHeadSha,
            dependencies.clock.now(),
          )
        ) {
          return result({
            stage: "evaluation.apply-policy",
            outcome: "stale",
            attemptId: job.attemptId,
            artifactId: job.evaluationId,
          });
        }
        const transition =
          await dependencies.repository.transitionToReviewRequired({
            attemptId: job.attemptId,
            expectedHeadSha: job.expectedHeadSha,
            idempotencyKey: nextIdempotencyKey(
              job.idempotencyKey,
              "policy-review",
            ),
            evaluationId: job.evaluationId,
            providerRecommendation: decision.providerRecommendation,
            reason: "valid_policy",
          });
        return result({
          stage: "evaluation.apply-policy",
          outcome:
            transition === "updated"
              ? "completed"
              : transition === "replayed"
                ? "replayed"
                : "stale",
          attemptId: job.attemptId,
          artifactId: job.evaluationId,
        });
      } catch (error) {
        return routeProviderFailure(
          error,
          "evaluation.apply-policy",
          job,
          dependencies.repository,
        );
      }
    },
  };
}

export class PgBossProviderPipelineDispatcher implements ProviderPipelineDispatcher {
  constructor(private readonly queue: PgBoss) {}

  async enqueue(
    name: ProviderPipelineJobName,
    payload: ProviderPipelineJobPayload,
  ): Promise<void> {
    switch (name) {
      case "media.select-frames":
        await expediteJob(
          this.queue,
          name,
          MediaSelectFramesJobSchema.parse(payload),
        );
        return;
      case "evaluation.run":
        await expediteJob(
          this.queue,
          name,
          EvaluationRunJobSchema.parse(payload),
        );
        return;
      case "evaluation.apply-policy":
        await expediteJob(
          this.queue,
          name,
          EvaluationApplyPolicyJobSchema.parse(payload),
        );
    }
  }
}

export type ProviderPipelineRegistrationDependencies = Omit<
  ProviderPipelineDependencies,
  "dispatcher"
>;

export async function registerProviderPipelineWorkers(
  queue: PgBoss,
  dependencies: ProviderPipelineRegistrationDependencies,
): Promise<{
  extractTranscriptWorkerId: string;
  selectFramesWorkerId: string;
  runEvaluationWorkerId: string;
  applyPolicyWorkerId: string;
}> {
  const handlers = createProviderPipelineHandlers({
    ...dependencies,
    dispatcher: new PgBossProviderPipelineDispatcher(queue),
  });
  const extractTranscriptWorkerId = await registerJobWorker(
    queue,
    "media.extract-transcript",
    async (job) => handlers.extractTranscript(job.data),
  );
  const selectFramesWorkerId = await registerJobWorker(
    queue,
    "media.select-frames",
    async (job) => handlers.selectFrames(job.data),
  );
  const runEvaluationWorkerId = await registerJobWorker(
    queue,
    "evaluation.run",
    async (job) => handlers.runEvaluation(job.data),
  );
  const applyPolicyWorkerId = await registerJobWorker(
    queue,
    "evaluation.apply-policy",
    async (job) => handlers.applyPolicy(job.data),
  );
  return {
    extractTranscriptWorkerId,
    selectFramesWorkerId,
    runEvaluationWorkerId,
    applyPolicyWorkerId,
  };
}

export function decodeProviderPayloadKeyBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("PROVIDER_PAYLOAD_KEY_BASE64 must be canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("PROVIDER_PAYLOAD_KEY_BASE64 must decode to 32 bytes");
  }
  return new Uint8Array(decoded);
}

export function createLocalFakeProviderPipeline(dependencies: {
  repository: ProviderPipelineRepository;
  dispatcher: ProviderPipelineDispatcher;
  payloadKey: Uint8Array;
  clock: ProviderClock;
  providerTimeoutMs?: number;
  fakeTranscriptText?: (question: StoredProofQuestionV1) => string;
}): ProviderPipelineHandlers {
  return createProviderPipelineHandlers({
    repository: dependencies.repository,
    dispatcher: dependencies.dispatcher,
    payloadCipher: new PayloadCipher(dependencies.payloadKey),
    transcriptionProvider: new LocalFakeTranscriptionProvider(
      dependencies.clock,
    ),
    frameSelectionAdapter: new EmptyLocalFrameSelectionAdapter(),
    judgeProvider: new LocalFakeMultimodalJudgeProvider(dependencies.clock),
    clock: dependencies.clock,
    ...(dependencies.providerTimeoutMs === undefined
      ? {}
      : { providerTimeoutMs: dependencies.providerTimeoutMs }),
    ...(dependencies.fakeTranscriptText === undefined
      ? {}
      : { fakeTranscriptText: dependencies.fakeTranscriptText }),
  });
}
