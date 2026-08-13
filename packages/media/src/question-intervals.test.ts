import { describe, expect, it } from "vitest";
import {
  ProofQuestionIntervalsV1Schema,
  validateProofQuestionIntervalsV1,
  type ProofQuestionIntervalV1,
} from "./question-intervals";

const QUESTION_ONE = "10000000-0000-4000-8000-000000000001";
const QUESTION_TWO = "10000000-0000-4000-8000-000000000002";

function interval(
  questionId: string,
  ordinal: number,
  startMs: number,
  endMs: number,
  recordedDurationMs = 2_000,
): ProofQuestionIntervalV1 {
  return {
    schemaVersion: "1",
    intervalVersion: "proof-question-interval-v1",
    questionId,
    ordinal,
    startMs,
    endMs,
    recordedDurationMs,
    source: "mobile_navigation_v1",
  };
}

describe("authenticated proof question intervals", () => {
  it("accepts the exact complete server-owned question order", () => {
    const intervals = [
      interval(QUESTION_ONE, 0, 0, 800),
      interval(QUESTION_TWO, 1, 800, 2_000),
    ];
    expect(
      validateProofQuestionIntervalsV1({
        intervals,
        expectedQuestionIds: [QUESTION_ONE, QUESTION_TWO],
        recordingDurationMs: 2_000,
      }),
    ).toEqual(intervals);
  });

  it("rejects missing, reordered, duplicate, overlapping and gapped sets", () => {
    const invalidSets = [
      [interval(QUESTION_ONE, 0, 0, 2_000)],
      [
        interval(QUESTION_TWO, 0, 0, 800),
        interval(QUESTION_ONE, 1, 800, 2_000),
      ],
      [
        interval(QUESTION_ONE, 0, 0, 800),
        interval(QUESTION_ONE, 1, 800, 2_000),
      ],
      [
        interval(QUESTION_ONE, 0, 0, 900),
        interval(QUESTION_TWO, 1, 800, 2_000),
      ],
      [
        interval(QUESTION_ONE, 0, 0, 700),
        interval(QUESTION_TWO, 1, 800, 2_000),
      ],
    ];
    for (const intervals of invalidSets) {
      expect(() =>
        validateProofQuestionIntervalsV1({
          intervals,
          expectedQuestionIds: [QUESTION_ONE, QUESTION_TWO],
          recordingDurationMs: 2_000,
        }),
      ).toThrow();
    }
  });

  it("rejects unbounded start/end drift and recording-duration mismatches", () => {
    expect(() =>
      validateProofQuestionIntervalsV1({
        intervals: [interval(QUESTION_ONE, 0, 1_001, 2_000)],
        expectedQuestionIds: [QUESTION_ONE],
        recordingDurationMs: 2_000,
      }),
    ).toThrow();
    expect(() =>
      validateProofQuestionIntervalsV1({
        intervals: [interval(QUESTION_ONE, 0, 0, 900)],
        expectedQuestionIds: [QUESTION_ONE],
        recordingDurationMs: 2_000,
      }),
    ).toThrow();
    expect(() =>
      validateProofQuestionIntervalsV1({
        intervals: [interval(QUESTION_ONE, 0, 0, 2_000, 1_999)],
        expectedQuestionIds: [QUESTION_ONE],
        recordingDurationMs: 2_000,
      }),
    ).toThrow();
  });

  it("rejects a client assigning more than 120 seconds to one answer", () => {
    expect(() =>
      validateProofQuestionIntervalsV1({
        intervals: [interval(QUESTION_ONE, 0, 0, 120_001, 120_001)],
        expectedQuestionIds: [QUESTION_ONE],
        recordingDurationMs: 120_001,
      }),
    ).toThrow("server-owned answer duration limit");
  });

  it("is strict about extra interval fields", () => {
    expect(() =>
      ProofQuestionIntervalsV1Schema.parse([
        { ...interval(QUESTION_ONE, 0, 0, 2_000), answer: "private" },
      ]),
    ).toThrow();
  });
});
