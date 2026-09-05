import {
  validateProofQuestionIntervalsV1,
  type ProofQuestionIntervalV1,
} from "@understandproof/media";

export type ProofQuestionIntervalDraft = Omit<
  ProofQuestionIntervalV1,
  "recordedDurationMs"
>;

export function captureProofQuestionIntervalV1(input: {
  questionId: string;
  ordinal: number;
  recordingStartedAtMs: number;
  questionStartedAtMs: number;
  nowMs: number;
}): ProofQuestionIntervalDraft {
  if (
    !Number.isFinite(input.recordingStartedAtMs) ||
    !Number.isFinite(input.questionStartedAtMs) ||
    !Number.isFinite(input.nowMs) ||
    input.recordingStartedAtMs < 0 ||
    input.questionStartedAtMs < 0 ||
    input.nowMs < input.recordingStartedAtMs
  ) {
    throw new Error("Invalid monotonic proof question timing");
  }
  const endMs = Math.max(
    input.questionStartedAtMs + 1,
    Math.round(input.nowMs - input.recordingStartedAtMs),
  );
  return {
    schemaVersion: "1",
    intervalVersion: "proof-question-interval-v1",
    questionId: input.questionId,
    ordinal: input.ordinal,
    startMs: input.questionStartedAtMs,
    endMs,
    source: "mobile_navigation_v1",
  };
}

export function finalizeProofQuestionIntervalsV1(input: {
  drafts: readonly ProofQuestionIntervalDraft[];
  expectedQuestionIds: readonly string[];
  recordedDurationMs: number;
}): ProofQuestionIntervalV1[] {
  const intervals = input.drafts.map((draft) => ({
    ...draft,
    recordedDurationMs: input.recordedDurationMs,
  }));
  return validateProofQuestionIntervalsV1({
    intervals,
    expectedQuestionIds: input.expectedQuestionIds,
    recordingDurationMs: input.recordedDurationMs,
  });
}
