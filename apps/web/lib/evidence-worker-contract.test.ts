import { describe, expect, it } from "vitest";
import {
  PracticeAnswerTextSchema,
  WorkerPracticeMutationSchema,
  WorkerPracticeViewSchema,
} from "./evidence-worker-contract";

describe("private practice web-worker contract", () => {
  it("trims answers and enforces the 4,000 UTF-8 byte boundary", () => {
    expect(
      PracticeAnswerTextSchema.parse("  explain the changed branch  "),
    ).toBe("explain the changed branch");
    expect(() => PracticeAnswerTextSchema.parse("🧠".repeat(1_001))).toThrow();
    expect(() =>
      WorkerPracticeMutationSchema.parse({
        operation: "answer",
        sessionId: "10000000-0000-4000-8000-000000000001",
        questionId: "10000000-0000-4000-8000-000000000002",
        answer: "valid answer",
        score: 1,
      }),
    ).toThrow();
  });

  it("rejects scores, proof material and unknown private fields from responses", () => {
    for (const unexpected of [
      { score: 100 },
      { proofQuestions: ["secret"] },
      { rubric: { required: ["secret"] } },
      { contributorAnswer: "private" },
      { providerMetadata: { model: "secret" } },
    ]) {
      expect(() =>
        WorkerPracticeViewSchema.parse({
          schemaVersion: "1",
          state: "unavailable",
          ...unexpected,
        }),
      ).toThrow();
    }
  });
});
