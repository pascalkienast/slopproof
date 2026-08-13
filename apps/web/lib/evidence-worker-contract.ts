/**
 * Contract expected from the worker without coupling the web app to worker code:
 *
 * GET /internal/review/evidence/:attemptId
 * Authorization: Bearer <EvidenceCapability>
 *
 * The evidence-stream worker verifies the token with WORKER_INTERNAL_SECRET using
 * EvidenceCapabilityPayloadSchema semantics, re-checks attempt/repository/current
 * revision and retention state, consumes the capability JTI once, decrypts only
 * into a response stream, and returns 200 with video/webm. It never redirects and
 * never returns an object-store URL, wrapped key or provider payload.
 *
 * GET /internal/review/context/:attemptId uses a separate one-use capability.
 * It returns only schema-validated transcript segments, selected JPEG frames and
 * structured evaluation findings. The worker decrypts them after rechecking the
 * current review binding; the web never receives the persistent payload key.
 */
import {
  LearningBundleV1Schema,
  PracticeFeedbackV1Schema,
  PracticeQuestionV2Schema,
} from "@slopproof/questions";
import { z } from "zod";

export const WORKER_REVIEW_EVIDENCE_PATH = "/internal/review/evidence" as const;
export const WORKER_REVIEW_CONTEXT_PATH = "/internal/review/context" as const;

export const WORKER_EVIDENCE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
] as const;

/**
 * Private contributor practice follows the same worker-only decryption
 * boundary as review evidence. The web issues an action-bound, one-use
 * capability only after rechecking the current PR author. The worker repeats
 * that check, consumes the JTI, and is the only process that decrypts learning,
 * answers, or feedback with PROVIDER_PAYLOAD_KEY_BASE64.
 *
 * GET  /internal/practice/:revisionId reads the author's private view.
 * POST /internal/practice/:revisionId starts a session or submits one answer.
 * Neither response contains answers, provider payloads, invocation metadata,
 * proof questions, rubrics, scores, or object-store references.
 */
export const WORKER_PRACTICE_PATH = "/internal/practice" as const;
export const WORKER_PRACTICE_MAX_REQUEST_BYTES = 8 * 1024;
export const WORKER_PRACTICE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const PRACTICE_ANSWER_MAX_UTF8_BYTES = 4_000;

const IsoInstantSchema = z.iso.datetime({ offset: false, precision: 3 });
const LearningBundleWireSchema = z
  .object({
    ...LearningBundleV1Schema.shape,
    createdAt: IsoInstantSchema,
    deleteAfter: IsoInstantSchema,
  })
  .strict();
const PracticeFeedbackWireSchema = z
  .object({
    ...PracticeFeedbackV1Schema.shape,
    createdAt: IsoInstantSchema,
    deleteAfter: IsoInstantSchema,
  })
  .strict();
const PracticePatchPreviewWireSchema = z
  .object({
    title: z.string().max(4_096),
    anchors: z
      .array(
        z
          .object({
            id: z.string().regex(/^a(?:0|[1-9][0-9]{0,2})$/u),
            file: z.string().min(1).max(1_024),
            hunkHeader: z.string().min(1).max(2_048),
            oldStart: z.number().int().nonnegative(),
            newStart: z.number().int().nonnegative(),
            changedLines: z.number().int().positive(),
            evidence: z.string().min(1).max(32_768),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const PracticeAnswerTextSchema = z
  .string()
  .transform((answer) => answer.trim())
  .pipe(z.string().min(1).max(4_000))
  .refine(
    (answer) =>
      Buffer.byteLength(answer, "utf8") <= PRACTICE_ANSWER_MAX_UTF8_BYTES,
    { message: "Practice answer exceeds its UTF-8 byte limit" },
  );

export const WorkerPracticeMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start") }).strict(),
  z
    .object({
      operation: z.literal("answer"),
      sessionId: z.string().uuid(),
      questionId: z.string().uuid(),
      answer: PracticeAnswerTextSchema,
    })
    .strict(),
]);

const PracticeSessionWireSchema = z
  .object({
    id: z.string().uuid(),
    deleteAfter: IsoInstantSchema,
    questions: z.array(PracticeQuestionV2Schema).min(3).max(5),
    pendingQuestionIds: z.array(z.string().uuid()).max(5),
    feedbackByQuestionId: z.record(
      z.string().uuid(),
      PracticeFeedbackWireSchema,
    ),
  })
  .strict()
  .superRefine((session, context) => {
    const questionIds = new Set(
      session.questions.map((question) => question.id),
    );
    if (
      new Set(session.pendingQuestionIds).size !==
        session.pendingQuestionIds.length ||
      session.pendingQuestionIds.some(
        (questionId) =>
          !questionIds.has(questionId) ||
          session.feedbackByQuestionId[questionId] !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingQuestionIds"],
        message: "Pending practice questions are not bound to this session",
      });
    }
    for (const [questionId, feedback] of Object.entries(
      session.feedbackByQuestionId,
    )) {
      if (
        !questionIds.has(questionId) ||
        feedback.practiceQuestionId !== questionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["feedbackByQuestionId", questionId],
          message: "Practice feedback is not bound to a visible question",
        });
      }
    }
  });

export const WorkerPracticeViewSchema = z.discriminatedUnion("state", [
  z
    .object({
      schemaVersion: z.literal("1"),
      state: z.literal("unavailable"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      state: z.literal("generating"),
      revisionId: z.string().uuid(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      state: z.literal("generation_failed"),
      revisionId: z.string().uuid(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      state: z.literal("ready"),
      revisionId: z.string().uuid(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/u),
      patchPreview: PracticePatchPreviewWireSchema,
      learning: LearningBundleWireSchema,
      practiceSession: PracticeSessionWireSchema.nullable(),
    })
    .strict()
    .superRefine((view, context) => {
      if (
        view.learning.revisionId !== view.revisionId ||
        view.learning.headSha !== view.headSha
      ) {
        context.addIssue({
          code: "custom",
          path: ["learning"],
          message: "Learning material is not bound to the response revision",
        });
      }
      if (view.practiceSession) {
        const bundleQuestionIds = view.learning.practiceQuestions.map(
          (question) => question.id,
        );
        const sessionQuestionIds = view.practiceSession.questions.map(
          (question) => question.id,
        );
        if (
          JSON.stringify(bundleQuestionIds) !==
          JSON.stringify(sessionQuestionIds)
        ) {
          context.addIssue({
            code: "custom",
            path: ["practiceSession", "questions"],
            message:
              "Practice session questions differ from its learning bundle",
          });
        }
      }
    }),
]);

export type WorkerPracticeMutation = z.infer<
  typeof WorkerPracticeMutationSchema
>;
export type WorkerPracticeView = z.infer<typeof WorkerPracticeViewSchema>;
