import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PROMPT_INJECTION_FIXTURES } from "./__fixtures__/prompt-injection";
import {
  FrameSelectionMetadataV1Schema,
  LocalFakeMultimodalJudgeProvider,
  LocalFakeTranscriptionProvider,
  ProofEvaluationInputV1Schema,
  ProofEvaluationV1Schema,
  ProviderContextV1Schema,
  ProviderError,
  TranscriptV1Schema,
  validateProofEvaluationAgainstInput,
  type ProofEvaluationInputV1,
  type ProviderClock,
  type ProviderContextV1,
  type TranscriptV1,
} from "./index";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "10000000-0000-4000-8000-000000000002";
const REQUEST_ID = "10000000-0000-4000-8000-000000000003";
const QUESTION_1 = "10000000-0000-4000-8000-000000000004";
const QUESTION_2 = "10000000-0000-4000-8000-000000000005";
const CRITERION_1 = "10000000-0000-4000-8000-000000000006";
const CRITERION_2 = "10000000-0000-4000-8000-000000000007";
const CRITERION_3 = "10000000-0000-4000-8000-000000000008";
const FRAME_ID = "10000000-0000-4000-8000-000000000009";
const DERIVATIVE_ID = "10000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-08-12T10:00:00.000Z");
const SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(64);
const CIPHERTEXT_SHA = "c".repeat(64);

const clock: ProviderClock = { now: () => NOW };
const context: ProviderContextV1 = {
  schemaVersion: "1",
  requestId: REQUEST_ID,
  attemptId: ATTEMPT_ID,
  deadlineAt: new Date("2026-08-12T10:01:00.000Z"),
};

async function makeTranscript(
  overrides: {
    first?: string;
    second?: string;
    secondQuestionId?: string;
  } = {},
): Promise<TranscriptV1> {
  const provider = new LocalFakeTranscriptionProvider(clock);
  return provider.transcribe(
    {
      schemaVersion: "1",
      attemptId: ATTEMPT_ID,
      sourceSha256: SOURCE_SHA,
      language: "en",
      durationMs: 20_000,
      segments: [
        {
          questionId: QUESTION_1,
          startMs: 0,
          endMs: 8_000,
          text:
            overrides.first ??
            "The transaction locks the session and rollback restores the prior state.",
        },
        {
          questionId: overrides.secondQuestionId ?? QUESTION_2,
          startMs: 9_000,
          endMs: 18_000,
          text:
            overrides.second ??
            "The authorization scope is checked before the protected action.",
        },
      ],
    },
    context,
  );
}

async function makeInput(
  transcriptOverrides: Parameters<typeof makeTranscript>[0] = {},
): Promise<ProofEvaluationInputV1> {
  return ProofEvaluationInputV1Schema.parse({
    schemaVersion: "1",
    inputVersion: "proof-evaluation-input-v1",
    attemptId: ATTEMPT_ID,
    revisionId: REVISION_ID,
    headSha: SHA,
    systemInstructionVersion: "proof-judge-system-v1",
    questions: [
      {
        id: QUESTION_1,
        promptVersion: "proof-questions-v1",
        prompt:
          "Explain the transaction behavior and how rollback restores a safe state.",
        patchAnchorIds: ["a0"],
        rubricVersion: "rubric-v1",
        rubric: [
          {
            id: CRITERION_1,
            description: "Explains the transaction boundary.",
            requiredTerms: ["transaction"],
          },
          {
            id: CRITERION_2,
            description: "Explains the rollback behavior.",
            requiredTerms: ["rollback"],
          },
        ],
      },
      {
        id: QUESTION_2,
        promptVersion: "proof-questions-v1",
        prompt:
          "Explain when the authorization scope is checked before the protected action.",
        patchAnchorIds: ["a1"],
        rubricVersion: "rubric-v1",
        rubric: [
          {
            id: CRITERION_3,
            description: "Identifies the authorization scope check.",
            requiredTerms: ["authorization", "scope"],
          },
        ],
      },
    ],
    patchEvidence: [
      {
        anchorId: "a0",
        filename: {
          trust: "untrusted",
          source: "pull_request_filename",
          content: PROMPT_INJECTION_FIXTURES.filename,
        },
        patch: {
          trust: "untrusted",
          source: "pull_request_patch",
          content: `+${PROMPT_INJECTION_FIXTURES.patchComment}`,
        },
      },
      {
        anchorId: "a1",
        filename: {
          trust: "untrusted",
          source: "pull_request_filename",
          content: "src/auth/session.ts",
        },
        patch: {
          trust: "untrusted",
          source: "pull_request_patch",
          content: "+authorize(session, scope)",
        },
      },
    ],
    transcript: await makeTranscript(transcriptOverrides),
    frameSelection: {
      schemaVersion: "1",
      selectionVersion: "frame-selection-v1",
      attemptId: ATTEMPT_ID,
      recordingDurationMs: 20_000,
      frames: [
        {
          id: FRAME_ID,
          timestampMs: 5_000,
          reasonCode: "answer_midpoint",
          reason: "Question-bound answer midpoint selected by local fixture.",
          encryptedDerivativeRef: DERIVATIVE_ID,
          ciphertextSha256: CIPHERTEXT_SHA,
          width: 640,
          height: 360,
        },
      ],
    },
  });
}

function expectProviderCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected ProviderError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe(code);
  }
}

describe("strict versioned provider contracts", () => {
  it("labels transcript text as untrusted and produces deterministic IDs", async () => {
    const first = await makeTranscript();
    const second = await makeTranscript();

    expect(second).toEqual(first);
    expect(first.createdAt).toEqual(NOW);
    expect(
      first.segments.every((segment) => segment.text.trust === "untrusted"),
    ).toBe(true);
    expect(
      first.segments.every((segment) => segment.text.source === "transcript"),
    ).toBe(true);
    expect(TranscriptV1Schema.parse(first)).toEqual(first);
  });

  it("rejects unknown fields at transcript, frame, input, output and context boundaries", async () => {
    const transcript = await makeTranscript();
    expect(() =>
      TranscriptV1Schema.parse({ ...transcript, rawProviderResponse: {} }),
    ).toThrow(z.ZodError);
    expect(() =>
      FrameSelectionMetadataV1Schema.parse({
        schemaVersion: "1",
        selectionVersion: "frame-selection-v1",
        attemptId: ATTEMPT_ID,
        recordingDurationMs: 100,
        frames: [],
        publicVideoUrl: "https://example.invalid/video",
      }),
    ).toThrow(z.ZodError);
    const input = await makeInput();
    expect(() =>
      ProofEvaluationInputV1Schema.parse({ ...input, tools: ["fetch"] }),
    ).toThrow(z.ZodError);
    expect(() =>
      ProviderContextV1Schema.parse({ ...context, fetch: globalThis.fetch }),
    ).toThrow(z.ZodError);
  });

  it("rejects transcript question IDs and patch anchors outside the stored plan", async () => {
    await expect(
      makeInput({
        secondQuestionId: "20000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("unknown question ID");

    const input = await makeInput();
    expect(() =>
      ProofEvaluationInputV1Schema.parse({
        ...input,
        questions: [
          { ...input.questions[0], patchAnchorIds: ["a99"] },
          input.questions[1],
        ],
      }),
    ).toThrow("missing patch anchor");
  });
});

describe("deterministic local multimodal judge", () => {
  it("returns only an assistive pass recommendation when every stored rubric matches", async () => {
    const input = await makeInput();
    const output = await new LocalFakeMultimodalJudgeProvider(clock).evaluate(
      input,
      context,
    );

    expect(output.recommendation).toBe("pass");
    expect(
      output.questionEvaluations.map((result) => result.questionId),
    ).toEqual([QUESTION_1, QUESTION_2]);
    expect(output).not.toHaveProperty("attemptStatus");
    expect(output).not.toHaveProperty("checkConclusion");
    expect(output.privateReason).toContain(
      "only a freshly authorized maintainer",
    );
  });

  it("treats filename, patch and transcript injection attempts only as untrusted data", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const input = await makeInput({
        first: PROMPT_INJECTION_FIXTURES.transcript,
      });
      const output = await new LocalFakeMultimodalJudgeProvider(clock).evaluate(
        input,
        context,
      );

      expect(output.recommendation).toBe("review_required");
      expect(output.questionEvaluations[0]?.outcome).toBe("not_met");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(output)).not.toContain("attacker.invalid");
      expect(JSON.stringify(output)).not.toContain("invented question ID");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("recommends retry when an answer is not evaluable", async () => {
    const input = await makeInput();
    const withoutSecondAnswer = ProofEvaluationInputV1Schema.parse({
      ...input,
      transcript: {
        ...input.transcript,
        segments: input.transcript.segments.filter(
          (segment) => segment.questionId !== QUESTION_2,
        ),
      },
    });
    const output = await new LocalFakeMultimodalJudgeProvider(clock).evaluate(
      withoutSecondAnswer,
      context,
    );

    expect(output.recommendation).toBe("retry");
    expect(output.questionEvaluations[1]?.outcome).toBe("not_evaluable");
  });

  it("rejects unknown question IDs and any mismatch with the exact stored rubric", async () => {
    const input = await makeInput();
    const output = await new LocalFakeMultimodalJudgeProvider(clock).evaluate(
      input,
      context,
    );

    expectProviderCode(
      () =>
        validateProofEvaluationAgainstInput(
          {
            ...output,
            questionEvaluations: [
              {
                ...output.questionEvaluations[0],
                questionId: "20000000-0000-4000-8000-000000000002",
              },
              output.questionEvaluations[1],
            ],
          },
          input,
        ),
      "UNKNOWN_QUESTION_ID",
    );

    expectProviderCode(
      () =>
        validateProofEvaluationAgainstInput(
          {
            ...output,
            questionEvaluations: [
              {
                ...output.questionEvaluations[0],
                rubricFindings: [
                  output.questionEvaluations[0]?.rubricFindings[0],
                ],
              },
              output.questionEvaluations[1],
            ],
          },
          input,
        ),
      "RUBRIC_MISMATCH",
    );
  });

  it("strictly rejects auto-pass values, state mutations and unknown output fields", async () => {
    const input = await makeInput();
    const output = await new LocalFakeMultimodalJudgeProvider(clock).evaluate(
      input,
      context,
    );

    expect(() =>
      ProofEvaluationV1Schema.parse({ ...output, recommendation: "auto_pass" }),
    ).toThrow(z.ZodError);
    expect(() =>
      ProofEvaluationV1Schema.parse({
        ...output,
        attemptStatus: "passed",
        checkConclusion: "success",
      }),
    ).toThrow(z.ZodError);
  });

  it("returns a typed retryable error after the provider deadline", async () => {
    const input = await makeInput();
    await expect(
      new LocalFakeMultimodalJudgeProvider(clock).evaluate(input, {
        ...context,
        deadlineAt: NOW,
      }),
    ).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
      disposition: "retryable",
    });
  });
});
