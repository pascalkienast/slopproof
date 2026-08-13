import { describe, expect, it } from "vitest";
import {
  captureProofQuestionIntervalV1,
  finalizeProofQuestionIntervalsV1,
} from "./proof-question-timing";

const QUESTION_ONE = "10000000-0000-4000-8000-000000000001";
const QUESTION_TWO = "10000000-0000-4000-8000-000000000002";

describe("mobile monotonic proof question timing", () => {
  it("captures recorder-start and Next boundaries without equal slicing", () => {
    const recordingStartedAtMs = 10_000.25;
    const first = captureProofQuestionIntervalV1({
      questionId: QUESTION_ONE,
      ordinal: 0,
      recordingStartedAtMs,
      questionStartedAtMs: 0,
      nowMs: 10_712.6,
    });
    const second = captureProofQuestionIntervalV1({
      questionId: QUESTION_TWO,
      ordinal: 1,
      recordingStartedAtMs,
      questionStartedAtMs: first.endMs,
      nowMs: 12_047.9,
    });
    const intervals = finalizeProofQuestionIntervalsV1({
      drafts: [first, second],
      expectedQuestionIds: [QUESTION_ONE, QUESTION_TWO],
      recordedDurationMs: 2_075,
    });

    expect(intervals.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 712],
      [712, 2_048],
    ]);
    expect(intervals[1]?.recordedDurationMs).toBe(2_075);
  });

  it("rejects non-monotonic clocks and an incomplete question order", () => {
    expect(() =>
      captureProofQuestionIntervalV1({
        questionId: QUESTION_ONE,
        ordinal: 0,
        recordingStartedAtMs: 2_000,
        questionStartedAtMs: 0,
        nowMs: 1_999,
      }),
    ).toThrow("monotonic");
    const first = captureProofQuestionIntervalV1({
      questionId: QUESTION_ONE,
      ordinal: 0,
      recordingStartedAtMs: 2_000,
      questionStartedAtMs: 0,
      nowMs: 2_500,
    });
    expect(() =>
      finalizeProofQuestionIntervalsV1({
        drafts: [first],
        expectedQuestionIds: [QUESTION_ONE, QUESTION_TWO],
        recordedDurationMs: 500,
      }),
    ).toThrow("server-owned proof plan");
  });
});
