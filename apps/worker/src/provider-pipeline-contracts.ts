import {
  EvaluationApplyPolicyJobSchema,
  EvaluationRunJobSchema,
  MediaExtractTranscriptJobSchema,
  MediaSelectFramesJobSchema,
  type JobPayload,
} from "@slopproof/db";
import {
  AttemptStatusSchema,
  GitShaSchema,
  UuidSchema,
} from "@slopproof/domain";
import {
  ProviderRecommendationSchema,
  RepositoryPolicyV1Schema,
} from "@slopproof/policy";
import { FrameSelectionMetadataV1Schema } from "@slopproof/providers";
import { z } from "zod";
import { RecordingAudioTranscriptionSourceV1Schema } from "./audio-transcription";

/** Private evidence is no longer authorized for this stage. */
export class PrivateProviderStageUnavailableError extends Error {
  constructor() {
    super("Private provider stage is unavailable");
    this.name = "PrivateProviderStageUnavailableError";
  }
}

export const StoredProofQuestionV1Schema = z
  .object({
    id: UuidSchema,
    ordinal: z.number().int().nonnegative().max(4),
    prompt: z.string().min(1).max(2_000),
    diffAnchor: z.unknown(),
    rubric: z.unknown(),
  })
  .strict();

export type StoredProofQuestionV1 = z.infer<typeof StoredProofQuestionV1Schema>;

const CurrentAttemptBindingSchema = z
  .object({
    attemptId: UuidSchema,
    revisionId: UuidSchema,
    repositoryId: UuidSchema,
    headSha: GitShaSchema,
    status: AttemptStatusSchema,
    isCurrent: z.boolean(),
    privateAccessEligible: z.boolean(),
    deleteAfter: z.date(),
  })
  .strict();

export const TranscriptExtractionContextV1Schema =
  CurrentAttemptBindingSchema.extend({
    schemaVersion: z.literal("1"),
    recordingObjectId: UuidSchema,
    recordingDurationMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1_000),
    recordingManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    questions: z.array(StoredProofQuestionV1Schema).min(1).max(5),
    existingTranscript: z
      .lazy(() => EncryptedTranscriptBundleV1Schema)
      .optional(),
    recordingAudio: z
      .object({
        objectKey: z.string().min(1).max(1_024),
        source: RecordingAudioTranscriptionSourceV1Schema,
      })
      .strict()
      .optional(),
  }).strict();

export type TranscriptExtractionContextV1 = z.infer<
  typeof TranscriptExtractionContextV1Schema
>;

export const EncryptedTranscriptBundleV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    payloadKind: z.literal("transcript"),
    transcriptId: UuidSchema,
    attemptId: UuidSchema,
    provider: z.string().min(1).max(100),
    transcriptSchemaVersion: z.literal("transcript-v1"),
    encryptedPayload: z.string().min(1).max(5_000_000),
    deleteAfter: z.date(),
  })
  .strict();

export type EncryptedTranscriptBundleV1 = z.infer<
  typeof EncryptedTranscriptBundleV1Schema
>;

export const FrameSelectionContextV1Schema = CurrentAttemptBindingSchema.extend(
  {
    schemaVersion: z.literal("1"),
    recordingObjectId: UuidSchema,
    recordingDurationMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1_000),
    transcript: EncryptedTranscriptBundleV1Schema,
  },
).strict();

export type FrameSelectionContextV1 = z.infer<
  typeof FrameSelectionContextV1Schema
>;

export const FrameSelectionStageBundleV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    payloadKind: z.literal("frame_selection"),
    attemptId: UuidSchema,
    metadata: FrameSelectionMetadataV1Schema,
  })
  .strict();

export type FrameSelectionStageBundleV1 = z.infer<
  typeof FrameSelectionStageBundleV1Schema
>;

export const EvaluationRunContextV1Schema = CurrentAttemptBindingSchema.extend({
  schemaVersion: z.literal("1"),
  transcript: EncryptedTranscriptBundleV1Schema,
  questions: z.array(StoredProofQuestionV1Schema).min(1).max(5),
  frameSelection: FrameSelectionMetadataV1Schema,
  existingEvaluation: z
    .lazy(() => EncryptedEvaluationBundleV1Schema)
    .optional(),
}).strict();

export type EvaluationRunContextV1 = z.infer<
  typeof EvaluationRunContextV1Schema
>;

export const EncryptedEvaluationBundleV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    payloadKind: z.literal("proof_evaluation"),
    evaluationId: UuidSchema,
    attemptId: UuidSchema,
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(100),
    promptVersion: z.literal("proof-judge-system-v1"),
    evaluationSchemaVersion: z.literal("proof-evaluation-v1"),
    rubricVersion: z.literal("rubric-v1"),
    recommendation: ProviderRecommendationSchema,
    encryptedPayload: z.string().min(1).max(5_000_000),
    deleteAfter: z.date(),
  })
  .strict();

export type EncryptedEvaluationBundleV1 = z.infer<
  typeof EncryptedEvaluationBundleV1Schema
>;

export const EvaluationPolicyContextV1Schema =
  CurrentAttemptBindingSchema.extend({
    schemaVersion: z.literal("1"),
    evaluation: EncryptedEvaluationBundleV1Schema,
    repositoryPolicy: RepositoryPolicyV1Schema,
  }).strict();

export type EvaluationPolicyContextV1 = z.infer<
  typeof EvaluationPolicyContextV1Schema
>;

export const ProviderPipelineStageResultV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    stage: z.enum([
      "media.extract-transcript",
      "media.select-frames",
      "evaluation.run",
      "evaluation.apply-policy",
    ]),
    outcome: z.enum([
      "completed",
      "replayed",
      "manual_review",
      "technical_retry",
      "stale",
    ]),
    attemptId: UuidSchema,
    artifactId: UuidSchema.optional(),
  })
  .strict();

export type ProviderPipelineStageResultV1 = z.infer<
  typeof ProviderPipelineStageResultV1Schema
>;

export type ProviderPipelineJobName =
  "media.select-frames" | "evaluation.run" | "evaluation.apply-policy";

export type ProviderPipelineJobPayload =
  | JobPayload<"media.select-frames">
  | JobPayload<"evaluation.run">
  | JobPayload<"evaluation.apply-policy">;

export const ProviderPipelineInputSchemas = {
  extractTranscript: MediaExtractTranscriptJobSchema,
  selectFrames: MediaSelectFramesJobSchema,
  runEvaluation: EvaluationRunJobSchema,
  applyPolicy: EvaluationApplyPolicyJobSchema,
} as const;

export interface ProviderPipelineRepository {
  loadTranscriptExtraction(
    job: JobPayload<"media.extract-transcript">,
  ): Promise<TranscriptExtractionContextV1>;
  persistTranscript(bundle: EncryptedTranscriptBundleV1): Promise<{
    status: "created" | "replayed";
    transcript: EncryptedTranscriptBundleV1;
  }>;
  schedulePersistedTranscript(
    transcript: EncryptedTranscriptBundleV1,
    downstreamJob: JobPayload<"media.select-frames">,
  ): Promise<boolean>;
  loadFrameSelection(
    job: JobPayload<"media.select-frames">,
  ): Promise<FrameSelectionContextV1>;
  persistFrameSelection(
    bundle: FrameSelectionStageBundleV1,
  ): Promise<"created" | "replayed">;
  loadEvaluationRun(
    job: JobPayload<"evaluation.run">,
  ): Promise<EvaluationRunContextV1>;
  persistEvaluation(bundle: EncryptedEvaluationBundleV1): Promise<{
    status: "created" | "replayed";
    evaluation: EncryptedEvaluationBundleV1;
  }>;
  schedulePersistedEvaluation(
    evaluation: EncryptedEvaluationBundleV1,
    downstreamJob: JobPayload<"evaluation.apply-policy">,
  ): Promise<boolean>;
  loadEvaluationPolicy(
    job: JobPayload<"evaluation.apply-policy">,
  ): Promise<EvaluationPolicyContextV1>;
  transitionToReviewRequired(input: {
    attemptId: string;
    expectedHeadSha: string;
    idempotencyKey: string;
    evaluationId?: string;
    providerRecommendation?: "pass" | "review_required" | "retry";
    reason: "valid_policy" | "provider_manual_review";
  }): Promise<"updated" | "replayed" | "stale">;
  transitionToTechnicalRetry(input: {
    attemptId: string;
    expectedHeadSha: string;
    idempotencyKey: string;
    errorClass: string;
  }): Promise<"updated" | "replayed" | "stale">;
}

export interface ProviderPipelineDispatcher {
  enqueue(
    name: ProviderPipelineJobName,
    payload: ProviderPipelineJobPayload,
  ): Promise<void>;
}
