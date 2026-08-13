import { z } from "zod";
import { MAX_RECORDING_DURATION_MS } from "./constants";

export const PROOF_QUESTION_INTERVAL_VERSION =
  "proof-question-interval-v1" as const;
export const PROOF_QUESTION_INTERVAL_SOURCE = "mobile_navigation_v1" as const;
export const MAX_PROOF_QUESTION_COUNT = 5;
export const MAX_INITIAL_QUESTION_GAP_MS = 1_000;
export const MAX_FINAL_QUESTION_END_DRIFT_MS = 1_000;
export const MAX_PROOF_QUESTION_ANSWER_MS = 120_000;

export const ProofQuestionIntervalV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    intervalVersion: z.literal(PROOF_QUESTION_INTERVAL_VERSION),
    questionId: z.string().uuid(),
    ordinal: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_PROOF_QUESTION_COUNT - 1),
    startMs: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_RECORDING_DURATION_MS - 1),
    endMs: z.number().int().positive().max(MAX_RECORDING_DURATION_MS),
    recordedDurationMs: z
      .number()
      .int()
      .positive()
      .max(MAX_RECORDING_DURATION_MS),
    source: z.literal(PROOF_QUESTION_INTERVAL_SOURCE),
  })
  .strict()
  .superRefine((interval, context) => {
    if (
      interval.endMs <= interval.startMs ||
      interval.endMs > interval.recordedDurationMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Question interval exceeds its recording duration binding",
      });
    }
  });

export const ProofQuestionIntervalsV1Schema = z
  .array(ProofQuestionIntervalV1Schema)
  .min(1)
  .max(MAX_PROOF_QUESTION_COUNT)
  .superRefine((intervals, context) => {
    const questionIds = new Set<string>();
    let previousEnd: number | undefined;
    for (const [index, interval] of intervals.entries()) {
      if (interval.ordinal !== index) {
        context.addIssue({
          code: "custom",
          path: [index, "ordinal"],
          message: "Question interval ordinals must be complete and ordered",
        });
      }
      if (questionIds.has(interval.questionId)) {
        context.addIssue({
          code: "custom",
          path: [index, "questionId"],
          message: "Question interval IDs must be unique",
        });
      }
      if (previousEnd !== undefined && interval.startMs !== previousEnd) {
        context.addIssue({
          code: "custom",
          path: [index, "startMs"],
          message: "Question intervals must be contiguous and non-overlapping",
        });
      }
      if (
        index > 0 &&
        interval.recordedDurationMs !== intervals[0]?.recordedDurationMs
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "recordedDurationMs"],
          message: "Question intervals must share one recording duration",
        });
      }
      previousEnd = interval.endMs;
      questionIds.add(interval.questionId);
    }
  });

export type ProofQuestionIntervalV1 = z.infer<
  typeof ProofQuestionIntervalV1Schema
>;

/**
 * Rebinds the authenticated client timing envelope to the server-owned proof
 * plan and the accepted recording duration. It never invents equal slices.
 */
export function validateProofQuestionIntervalsV1(input: {
  intervals: unknown;
  expectedQuestionIds: readonly string[];
  recordingDurationMs: number;
}): ProofQuestionIntervalV1[] {
  const intervals = ProofQuestionIntervalsV1Schema.parse(input.intervals);
  if (
    input.expectedQuestionIds.length !== intervals.length ||
    intervals.some(
      (interval, index) =>
        interval.questionId !== input.expectedQuestionIds[index] ||
        interval.recordedDurationMs !== input.recordingDurationMs,
    )
  ) {
    throw new Error(
      "Question intervals do not match the complete server-owned proof plan",
    );
  }
  if (
    intervals.some(
      (interval) =>
        interval.endMs - interval.startMs > MAX_PROOF_QUESTION_ANSWER_MS,
    )
  ) {
    throw new Error(
      "Question interval exceeds the server-owned answer duration limit",
    );
  }
  const first = intervals[0];
  const last = intervals.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    first.startMs > MAX_INITIAL_QUESTION_GAP_MS ||
    Math.abs(input.recordingDurationMs - last.endMs) >
      MAX_FINAL_QUESTION_END_DRIFT_MS
  ) {
    throw new Error(
      "Question intervals do not cover the accepted recording timeline",
    );
  }
  return intervals;
}
