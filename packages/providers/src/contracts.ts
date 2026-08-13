import { GitShaSchema, Sha256Schema, UuidSchema } from "@slopproof/domain";
import { z } from "zod";

export const UntrustedDataSchema = z
  .object({
    trust: z.literal("untrusted"),
    source: z.enum([
      "pull_request_filename",
      "pull_request_patch",
      "pull_request_comment",
      "pull_request_readme",
      "transcript",
      "contributor_answer",
    ]),
    content: z.string().max(100_000),
  })
  .strict();

export type UntrustedData = z.infer<typeof UntrustedDataSchema>;

export const ProviderContextV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    requestId: UuidSchema,
    attemptId: UuidSchema,
    deadlineAt: z.date(),
  })
  .strict();

export type ProviderContextV1 = z.infer<typeof ProviderContextV1Schema>;

export const TranscriptSegmentV1Schema = z
  .object({
    id: UuidSchema,
    questionId: UuidSchema.optional(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    speaker: z.enum(["contributor", "unknown"]),
    text: UntrustedDataSchema.refine((value) => value.source === "transcript", {
      message:
        "Transcript segment text must be labeled as untrusted transcript data",
    }),
  })
  .strict()
  .refine((segment) => segment.endMs > segment.startMs, {
    path: ["endMs"],
    message: "Transcript segment end must be after its start",
  });

export const TranscriptV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    transcriptVersion: z.literal("transcript-v1"),
    id: UuidSchema,
    attemptId: UuidSchema,
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(100),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
    durationMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1_000),
    sourceSha256: Sha256Schema,
    segments: z.array(TranscriptSegmentV1Schema).min(1).max(1_000),
    createdAt: z.date(),
  })
  .strict()
  .superRefine((transcript, context) => {
    let previousEnd = 0;
    const ids = new Set<string>();
    for (const [index, segment] of transcript.segments.entries()) {
      if (ids.has(segment.id)) {
        context.addIssue({
          code: "custom",
          path: ["segments", index, "id"],
          message: "Transcript segment IDs must be unique",
        });
      }
      ids.add(segment.id);
      if (segment.startMs < previousEnd) {
        context.addIssue({
          code: "custom",
          path: ["segments", index, "startMs"],
          message: "Transcript segments must be ordered and non-overlapping",
        });
      }
      if (segment.endMs > transcript.durationMs) {
        context.addIssue({
          code: "custom",
          path: ["segments", index, "endMs"],
          message: "Transcript segment exceeds media duration",
        });
      }
      previousEnd = segment.endMs;
    }
  });

export type TranscriptV1 = z.infer<typeof TranscriptV1Schema>;

export const FrameSelectionItemV1Schema = z
  .object({
    id: UuidSchema,
    timestampMs: z.number().int().nonnegative(),
    reasonCode: z.enum([
      "question_transition",
      "answer_midpoint",
      "transcript_alignment",
      "quality_check",
    ]),
    reason: z.string().min(1).max(300),
    encryptedDerivativeRef: UuidSchema,
    ciphertextSha256: Sha256Schema,
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
  })
  .strict();

export const FrameSelectionMetadataV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    selectionVersion: z.literal("frame-selection-v1"),
    attemptId: UuidSchema,
    recordingDurationMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1_000),
    frames: z.array(FrameSelectionItemV1Schema).max(12),
  })
  .strict()
  .superRefine((selection, context) => {
    const ids = new Set<string>();
    for (const [index, frame] of selection.frames.entries()) {
      if (ids.has(frame.id)) {
        context.addIssue({
          code: "custom",
          path: ["frames", index, "id"],
          message: "Frame IDs must be unique",
        });
      }
      ids.add(frame.id);
      if (frame.timestampMs > selection.recordingDurationMs) {
        context.addIssue({
          code: "custom",
          path: ["frames", index, "timestampMs"],
          message: "Frame timestamp exceeds recording duration",
        });
      }
    }
  });

export type FrameSelectionMetadataV1 = z.infer<
  typeof FrameSelectionMetadataV1Schema
>;

export const EvaluationRubricCriterionV1Schema = z
  .object({
    id: UuidSchema,
    description: z.string().min(5).max(500),
    requiredTerms: z.array(z.string().trim().min(2).max(80)).min(1).max(8),
  })
  .strict();

export const EvaluationQuestionV1Schema = z
  .object({
    id: UuidSchema,
    promptVersion: z.literal("proof-questions-v1"),
    prompt: z.string().min(20).max(1_000),
    patchAnchorIds: z
      .array(z.string().regex(/^a[0-9]+$/))
      .min(1)
      .max(5),
    rubricVersion: z.literal("rubric-v1"),
    rubric: z.array(EvaluationRubricCriterionV1Schema).min(1).max(8),
  })
  .strict()
  .superRefine((question, context) => {
    if (
      new Set(question.patchAnchorIds).size !== question.patchAnchorIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["patchAnchorIds"],
        message: "Patch anchor IDs must be unique per question",
      });
    }
    if (
      new Set(question.rubric.map((item) => item.id)).size !==
      question.rubric.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["rubric"],
        message: "Rubric criterion IDs must be unique per question",
      });
    }
  });

export const PatchEvidenceV1Schema = z
  .object({
    anchorId: z.string().regex(/^a[0-9]+$/),
    filename: UntrustedDataSchema.refine(
      (value) => value.source === "pull_request_filename",
      { message: "Filename must be labeled as untrusted filename data" },
    ),
    patch: UntrustedDataSchema.refine(
      (value) => value.source === "pull_request_patch",
      { message: "Patch must be labeled as untrusted patch data" },
    ),
  })
  .strict();

export const ProofEvaluationInputV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    inputVersion: z.literal("proof-evaluation-input-v1"),
    attemptId: UuidSchema,
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    systemInstructionVersion: z.literal("proof-judge-system-v1"),
    questions: z.array(EvaluationQuestionV1Schema).min(1).max(5),
    patchEvidence: z.array(PatchEvidenceV1Schema).min(1).max(25),
    transcript: TranscriptV1Schema,
    frameSelection: FrameSelectionMetadataV1Schema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.transcript.attemptId !== input.attemptId) {
      context.addIssue({
        code: "custom",
        path: ["transcript", "attemptId"],
        message: "Transcript belongs to a different attempt",
      });
    }
    if (input.frameSelection.attemptId !== input.attemptId) {
      context.addIssue({
        code: "custom",
        path: ["frameSelection", "attemptId"],
        message: "Frame selection belongs to a different attempt",
      });
    }

    const questionIds = new Set(input.questions.map((question) => question.id));
    if (questionIds.size !== input.questions.length) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Evaluation question IDs must be unique",
      });
    }
    for (const [index, segment] of input.transcript.segments.entries()) {
      if (
        segment.questionId !== undefined &&
        !questionIds.has(segment.questionId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["transcript", "segments", index, "questionId"],
          message: "Transcript references an unknown question ID",
        });
      }
    }

    const evidenceAnchors = new Set(
      input.patchEvidence.map((evidence) => evidence.anchorId),
    );
    if (evidenceAnchors.size !== input.patchEvidence.length) {
      context.addIssue({
        code: "custom",
        path: ["patchEvidence"],
        message: "Patch evidence anchor IDs must be unique",
      });
    }
    for (const [questionIndex, question] of input.questions.entries()) {
      for (const anchorId of question.patchAnchorIds) {
        if (!evidenceAnchors.has(anchorId)) {
          context.addIssue({
            code: "custom",
            path: ["questions", questionIndex, "patchAnchorIds"],
            message: `Question references missing patch anchor ${anchorId}`,
          });
        }
      }
    }
  });

export type ProofEvaluationInputV1 = z.infer<
  typeof ProofEvaluationInputV1Schema
>;

export const RubricFindingV1Schema = z
  .object({
    criterionId: UuidSchema,
    result: z.enum(["met", "not_met"]),
    reason: z.string().min(1).max(500),
  })
  .strict();

export const QuestionEvaluationV1Schema = z
  .object({
    questionId: UuidSchema,
    outcome: z.enum(["met", "partial", "not_met", "not_evaluable"]),
    rubricFindings: z.array(RubricFindingV1Schema).min(1).max(8),
    supportedPatchAnchorIds: z.array(z.string().regex(/^a[0-9]+$/)).max(5),
    reason: z.string().min(1).max(1_000),
  })
  .strict();

export const ProofEvaluationV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    evaluationVersion: z.literal("proof-evaluation-v1"),
    attemptId: UuidSchema,
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(100),
    systemInstructionVersion: z.literal("proof-judge-system-v1"),
    recommendation: z.enum(["pass", "review_required", "retry"]),
    questionEvaluations: z.array(QuestionEvaluationV1Schema).min(1).max(5),
    privateReason: z.string().min(1).max(2_000),
    warnings: z.array(z.string().min(1).max(500)).max(20),
    createdAt: z.date(),
  })
  .strict()
  .superRefine((evaluation, context) => {
    const questionIds = new Set<string>();
    for (const [
      questionIndex,
      question,
    ] of evaluation.questionEvaluations.entries()) {
      if (questionIds.has(question.questionId)) {
        context.addIssue({
          code: "custom",
          path: ["questionEvaluations", questionIndex, "questionId"],
          message: "Question evaluation IDs must be unique",
        });
      }
      questionIds.add(question.questionId);

      const criterionIds = question.rubricFindings.map(
        (finding) => finding.criterionId,
      );
      if (new Set(criterionIds).size !== criterionIds.length) {
        context.addIssue({
          code: "custom",
          path: ["questionEvaluations", questionIndex, "rubricFindings"],
          message: "Rubric finding IDs must be unique per question",
        });
      }
      if (
        new Set(question.supportedPatchAnchorIds).size !==
        question.supportedPatchAnchorIds.length
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "questionEvaluations",
            questionIndex,
            "supportedPatchAnchorIds",
          ],
          message: "Supported patch anchor IDs must be unique per question",
        });
      }
    }
  });

export type ProofEvaluationV1 = z.infer<typeof ProofEvaluationV1Schema>;

const AuthoritativeCriterionReasonCodeV1Schema = z.enum([
  "patch_evidence_supports_criterion",
  "patch_evidence_conflicts_with_criterion",
  "question_evidence_insufficient",
  "question_evidence_unavailable",
]);

const AuthoritativeContradictionCodeV1Schema = z.enum([
  "transcript_conflicts_with_patch_evidence",
  "question_evidence_is_internally_inconsistent",
]);

const AuthoritativeUncertaintyCodeV1Schema = z.enum([
  "transcript_evidence_incomplete",
  "frame_evidence_unavailable",
  "criterion_requires_maintainer_assessment",
]);

const AuthoritativePrivateReasonCodeV1Schema = z.enum([
  "all_stored_criteria_supported",
  "stored_criteria_not_fully_supported",
  "automated_evaluation_unavailable",
]);

const AuthoritativeWarningCodeV1Schema = z.enum([
  "frames_unavailable",
  "frames_truncated",
  "frame_metadata_invalid",
  "frame_ciphertext_unavailable",
  "frame_ciphertext_too_large",
  "frame_ciphertext_hash_mismatch",
  "frame_ciphertext_invalid",
  "frame_decryption_failed",
  "frame_jpeg_invalid",
  "frame_dimensions_invalid",
  "provider_evaluation_unavailable",
  "local_fake_manual_review",
]);

const AuthoritativeFrameWarningCodeV1Schema = z.enum([
  "frames_unavailable",
  "frames_truncated",
  "frame_metadata_invalid",
  "frame_ciphertext_unavailable",
  "frame_ciphertext_too_large",
  "frame_ciphertext_hash_mismatch",
  "frame_ciphertext_invalid",
  "frame_decryption_failed",
  "frame_jpeg_invalid",
  "frame_dimensions_invalid",
]);

const ExactReviewDateSchema = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : value;
}, z.date());

export const AuthoritativeMultimodalEvaluationV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    evaluationVersion: z.literal("multimodal-proof-evaluation-v1"),
    attemptId: UuidSchema,
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    candidate: z
      .object({
        schemaVersion: z.literal("1"),
        candidateVersion: z.literal("multimodal-judge-candidate-v1"),
        recommendation: z.enum(["pass", "retry", "review_required"]),
        questionEvaluations: z
          .array(
            z
              .object({
                questionId: UuidSchema,
                criterionResults: z
                  .array(
                    z
                      .object({
                        criterionId: UuidSchema,
                        result: z.enum(["met", "not_met", "not_evaluable"]),
                        supportedPatchAnchorIds: z
                          .array(z.string().regex(/^a[0-9]+$/u))
                          .max(5),
                        reason: AuthoritativeCriterionReasonCodeV1Schema,
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(8),
                contradictions: z
                  .array(AuthoritativeContradictionCodeV1Schema)
                  .max(5),
                uncertainty: z
                  .array(AuthoritativeUncertaintyCodeV1Schema)
                  .max(5),
              })
              .strict(),
          )
          .min(1)
          .max(5),
        privateReason: AuthoritativePrivateReasonCodeV1Schema,
        warnings: z.array(AuthoritativeWarningCodeV1Schema).max(20),
      })
      .strict()
      .superRefine((candidate, context) => {
        const questionIds = new Set<string>();
        let containsNonPassingCriterion = false;
        let containsUnresolvedEvidence = false;
        for (const [
          questionIndex,
          question,
        ] of candidate.questionEvaluations.entries()) {
          if (questionIds.has(question.questionId)) {
            context.addIssue({
              code: "custom",
              path: ["questionEvaluations", questionIndex, "questionId"],
              message: "Authoritative question IDs must be unique",
            });
          }
          questionIds.add(question.questionId);
          if (
            question.contradictions.length > 0 ||
            question.uncertainty.length > 0
          ) {
            containsUnresolvedEvidence = true;
          }
          const criterionIds = new Set<string>();
          for (const [
            criterionIndex,
            criterion,
          ] of question.criterionResults.entries()) {
            if (criterionIds.has(criterion.criterionId)) {
              context.addIssue({
                code: "custom",
                path: [
                  "questionEvaluations",
                  questionIndex,
                  "criterionResults",
                  criterionIndex,
                  "criterionId",
                ],
                message: "Authoritative criterion IDs must be unique",
              });
            }
            criterionIds.add(criterion.criterionId);
            if (criterion.result !== "met") containsNonPassingCriterion = true;
            const validBinding =
              (criterion.result === "met" &&
                criterion.supportedPatchAnchorIds.length > 0 &&
                criterion.reason === "patch_evidence_supports_criterion") ||
              (criterion.result === "not_met" &&
                criterion.supportedPatchAnchorIds.length > 0 &&
                criterion.reason ===
                  "patch_evidence_conflicts_with_criterion") ||
              (criterion.result === "not_evaluable" &&
                criterion.supportedPatchAnchorIds.length === 0 &&
                (criterion.reason === "question_evidence_insufficient" ||
                  criterion.reason === "question_evidence_unavailable"));
            if (!validBinding) {
              context.addIssue({
                code: "custom",
                path: [
                  "questionEvaluations",
                  questionIndex,
                  "criterionResults",
                  criterionIndex,
                ],
                message: "Authoritative criterion evidence is inconsistent",
              });
            }
          }
        }
        if (
          candidate.recommendation === "pass" &&
          (containsNonPassingCriterion || containsUnresolvedEvidence)
        ) {
          context.addIssue({
            code: "custom",
            path: ["recommendation"],
            message: "Non-passing evidence cannot recommend pass",
          });
        }
      }),
    invocationMetadata: z
      .object({
        schemaVersion: z.literal("1"),
        provider: z.string().trim().min(1).max(100),
        model: z.string().trim().min(1).max(100),
        promptVersion: z.literal("proof-judge-system-v2"),
        outputSchemaVersion: z.literal("multimodal-judge-candidate-v1"),
        inputHash: Sha256Schema,
        outputHash: Sha256Schema,
        tokenUsage: z
          .object({
            inputTokens: z.number().int().nonnegative().max(10_000_000),
            outputTokens: z.number().int().nonnegative().max(10_000_000),
          })
          .strict()
          .nullable(),
        latencyMs: z
          .number()
          .int()
          .nonnegative()
          .max(15 * 60_000),
        invocationCount: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        outcome: z.enum(["generated", "repaired", "fallback"]),
        degraded: z.boolean(),
        completedAt: ExactReviewDateSchema,
      })
      .strict(),
    frameWarnings: z.array(AuthoritativeFrameWarningCodeV1Schema).max(10),
    workflowOutcome: z.literal("review_required"),
    manualReviewRequired: z.literal(true),
    createdAt: ExactReviewDateSchema,
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (
      new Set(evaluation.frameWarnings).size !== evaluation.frameWarnings.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["frameWarnings"],
        message: "Authoritative frame warning codes must be unique",
      });
    }
    if (
      evaluation.invocationMetadata.completedAt.getTime() >
      evaluation.createdAt.getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["invocationMetadata", "completedAt"],
        message: "Provider completion cannot follow evaluation creation",
      });
    }
  });

export type AuthoritativeMultimodalEvaluationV1 = z.infer<
  typeof AuthoritativeMultimodalEvaluationV1Schema
>;

export const PrivateReviewFrameV1Schema = z
  .object({
    id: UuidSchema,
    timestampMs: z.number().int().nonnegative(),
    reasonCode: FrameSelectionItemV1Schema.shape.reasonCode,
    width: z.number().int().min(1).max(1_920),
    height: z.number().int().min(1).max(1_080),
    mediaType: z.literal("image/jpeg"),
    imageBase64: z
      .string()
      .min(4)
      .max(2_000_000)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict();

function reviveCreatedAt(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  ) {
    return { ...value, createdAt: new Date(value.createdAt) };
  }
  return value;
}

const PrivateReviewTranscriptV1Schema = z.preprocess(
  reviveCreatedAt,
  TranscriptV1Schema,
);
const PrivateReviewEvaluationV1Schema = z.preprocess(
  reviveCreatedAt,
  ProofEvaluationV1Schema,
);

const PrivateReviewTranscriptV2Schema = z.preprocess(
  reviveCreatedAt,
  TranscriptV1Schema,
);
const PrivateReviewCompatibilityEvaluationV2Schema = z.preprocess(
  reviveCreatedAt,
  ProofEvaluationV1Schema,
);

export const PrivateReviewContextV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    attemptId: UuidSchema,
    transcript: PrivateReviewTranscriptV1Schema,
    evaluation: PrivateReviewEvaluationV1Schema,
    frames: z.array(PrivateReviewFrameV1Schema).max(12),
  })
  .strict()
  .superRefine((context, issues) => {
    if (
      context.transcript.attemptId !== context.attemptId ||
      context.evaluation.attemptId !== context.attemptId
    ) {
      issues.addIssue({
        code: "custom",
        path: ["attemptId"],
        message:
          "Private review artifacts must belong to the requested attempt",
      });
    }
  });

export type PrivateReviewContextV1 = z.infer<
  typeof PrivateReviewContextV1Schema
>;

export const PrivateReviewContextV2Schema = z
  .object({
    schemaVersion: z.literal("2"),
    attemptId: UuidSchema,
    transcript: PrivateReviewTranscriptV2Schema,
    compatibilityEvaluation: PrivateReviewCompatibilityEvaluationV2Schema,
    authoritativeEvaluation:
      AuthoritativeMultimodalEvaluationV1Schema.nullable(),
    frames: z.array(PrivateReviewFrameV1Schema).max(12),
  })
  .strict()
  .superRefine((context, issues) => {
    if (
      context.transcript.attemptId !== context.attemptId ||
      context.compatibilityEvaluation.attemptId !== context.attemptId ||
      (context.authoritativeEvaluation !== null &&
        (context.authoritativeEvaluation.attemptId !== context.attemptId ||
          context.authoritativeEvaluation.revisionId !==
            context.compatibilityEvaluation.revisionId ||
          context.authoritativeEvaluation.headSha !==
            context.compatibilityEvaluation.headSha))
    ) {
      issues.addIssue({
        code: "custom",
        path: ["attemptId"],
        message: "Private V2 review artifacts must share one exact binding",
      });
    }
  });

export type PrivateReviewContextV2 = z.infer<
  typeof PrivateReviewContextV2Schema
>;

export const PrivateReviewContextSchema = z.union([
  PrivateReviewContextV2Schema,
  PrivateReviewContextV1Schema,
]);

export type PrivateReviewContext = z.infer<typeof PrivateReviewContextSchema>;

export const FakeTranscriptionRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    attemptId: UuidSchema,
    sourceSha256: Sha256Schema,
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
    durationMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1_000),
    segments: z
      .array(
        z
          .object({
            questionId: UuidSchema.optional(),
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
            text: z.string().max(20_000),
          })
          .strict()
          .refine((segment) => segment.endMs > segment.startMs, {
            path: ["endMs"],
            message: "Fake transcript segment end must be after start",
          }),
      )
      .min(1)
      .max(1_000),
  })
  .strict();

export type FakeTranscriptionRequestV1 = z.infer<
  typeof FakeTranscriptionRequestV1Schema
>;

export interface TranscriptionProvider {
  transcribe(
    input: FakeTranscriptionRequestV1,
    context: ProviderContextV1,
  ): Promise<TranscriptV1>;
}

export interface MultimodalJudgeProvider {
  evaluate(
    input: ProofEvaluationInputV1,
    context: ProviderContextV1,
  ): Promise<ProofEvaluationV1>;
}
