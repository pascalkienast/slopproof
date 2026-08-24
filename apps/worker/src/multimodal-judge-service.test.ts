import {
  ProofEvaluationInputV1Schema,
  ProviderError,
  multimodalJudgeCandidateHashV1,
  multimodalJudgeProviderInputHashV1,
  type InlineMultimodalJudgeProvider,
  type MultimodalJudgeCandidateV1,
  type MultimodalJudgeProviderInputV1,
  type ProviderContextV1,
} from "@slopproof/providers";
import { describe, expect, it, vi } from "vitest";
import {
  projectMultimodalJudgeProviderInputV1,
  runMultimodalJudgeEvaluation,
} from "./multimodal-judge-service";

const NOW = new Date("2026-08-13T02:00:00.000Z");
const ATTEMPT_ID = "71000000-0000-4000-8000-000000000001";
const REVISION_ID = "71000000-0000-4000-8000-000000000002";
const QUESTION_ID = "71000000-0000-4000-8000-000000000003";
const CRITERION_ID = "71000000-0000-4000-8000-000000000004";
const TRANSCRIPT_ID = "71000000-0000-4000-8000-000000000005";
const BOUND_SEGMENT_ID = "71000000-0000-4000-8000-000000000006";
const UNBOUND_SEGMENT_ID = "71000000-0000-4000-8000-000000000007";
const FRAME_ID = "71000000-0000-4000-8000-000000000008";
const FRAME_REFERENCE = "71000000-0000-4000-8000-000000000009";

describe("multimodal judge service", () => {
  it("sends only proof-bound evidence and always ends in maintainer review", async () => {
    let observedInput: MultimodalJudgeProviderInputV1 | undefined;
    const provider = successfulProvider(async (input) => {
      observedInput = input;
      return resultFixture(input, validCandidate());
    });
    const frameBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [frameFixture(frameBytes)],
          warnings: [],
        })),
        now: () => NOW,
      },
    );

    expect(observedInput).toBeDefined();
    const serialized = JSON.stringify(observedInput);
    expect(serialized).not.toContain("attemptId");
    expect(serialized).not.toContain("revisionId");
    expect(serialized).not.toContain("private practice answer");
    expect(observedInput?.transcriptSegments).toHaveLength(1);
    expect(observedInput?.transcriptSegments[0]?.questionId).toBe(QUESTION_ID);
    expect(observedInput?.questions[0]?.criteria[0]?.requiredTerms).toEqual([
      {
        trust: "untrusted",
        source: "stored_rubric",
        content: "rollback",
      },
    ]);
    expect(result).toMatchObject({
      attemptId: ATTEMPT_ID,
      revisionId: REVISION_ID,
      candidate: { recommendation: "pass" },
      workflowOutcome: "review_required",
      manualReviewRequired: true,
      frameWarnings: [],
    });
    expect(frameBytes).toEqual(new Uint8Array(4));
  });

  it("invokes the provider with the transcript when no normalized frame is available", async () => {
    const provider = successfulProvider();
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [],
          warnings: ["frame_ciphertext_unavailable" as const],
        })),
        now: () => NOW,
      },
    );
    expect(provider.evaluate).toHaveBeenCalledOnce();
    const observedInput = provider.evaluate.mock.calls[0]?.[0] as
      MultimodalJudgeProviderInputV1 | undefined;
    expect(observedInput?.frames).toEqual([]);
    expect(observedInput?.transcriptSegments).toHaveLength(1);
    expect(observedInput?.transcriptSegments[0]?.questionId).toBe(QUESTION_ID);
    expect(result.frameWarnings).toEqual([
      "frame_ciphertext_unavailable",
      "frames_unavailable",
    ]);
    expect(result.candidate.recommendation).toBe("pass");
    expect(result.invocationMetadata).toMatchObject({
      outcome: "generated",
      invocationCount: 1,
      degraded: false,
      model: "judge-text",
    });
    expect(result.workflowOutcome).toBe("review_required");
    expect(result.manualReviewRequired).toBe(true);
  });

  it("routes missing question-bound transcript evidence to review without loading frames or invoking the provider", async () => {
    const input = inputFixture();
    input.transcript.segments[0] = {
      ...input.transcript.segments[0]!,
      questionId: undefined,
    };
    const provider = successfulProvider();
    const loadFrames = vi.fn();

    const result = await runMultimodalJudgeEvaluation(input, contextFixture(), {
      provider,
      loadFrames,
      now: () => NOW,
    });

    expect(loadFrames).not.toHaveBeenCalled();
    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      workflowOutcome: "review_required",
      manualReviewRequired: true,
      frameWarnings: [],
      frameCount: 0,
      invocationMetadata: {
        invocationCount: 0,
        outcome: "fallback",
        degraded: true,
      },
      candidate: {
        recommendation: "review_required",
        privateReason: "automated_evaluation_unavailable",
        warnings: ["question_transcript_unavailable"],
      },
    });
    expect(result.candidate.questionEvaluations[0]?.criterionResults).toEqual([
      expect.objectContaining({
        result: "not_evaluable",
        supportedPatchAnchorIds: [],
        reason: "question_evidence_unavailable",
      }),
    ]);
  });

  it("invokes the provider after a non-deadline frame-loader failure", async () => {
    const provider = successfulProvider();
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => {
          throw new Error("private frame storage detail");
        }),
        now: () => NOW,
      },
    );
    expect(provider.evaluate).toHaveBeenCalledOnce();
    expect(provider.evaluate.mock.calls[0]?.[0]?.frames).toEqual([]);
    expect(result.frameWarnings).toEqual(["frames_unavailable"]);
    expect(result.candidate.recommendation).toBe("pass");
    expect(result.invocationMetadata.outcome).toBe("generated");
    expect(JSON.stringify(result)).not.toContain("private frame storage");
  });

  it("keeps evaluate-throw fallback when no normalized frame is available", async () => {
    const provider: InlineMultimodalJudgeProvider = {
      descriptor: descriptorFixture(),
      evaluate: vi.fn(async () => {
        throw new Error("private raw provider payload and API key");
      }),
    };
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [],
          warnings: ["frame_ciphertext_unavailable" as const],
        })),
        now: () => NOW,
      },
    );
    expect(provider.evaluate).toHaveBeenCalledOnce();
    expect(result.frameWarnings).toEqual([
      "frame_ciphertext_unavailable",
      "frames_unavailable",
    ]);
    expect(result.candidate).toMatchObject({
      recommendation: "review_required",
      warnings: [
        "frame_ciphertext_unavailable",
        "frames_unavailable",
        "provider_evaluation_unavailable",
      ],
    });
    expect(result.invocationMetadata).toMatchObject({
      outcome: "fallback",
      invocationCount: 1,
      degraded: true,
      failureDiagnostics: {
        errorClass: "Error",
        hopUsed: "none",
        invocationCount: 1,
        frameCount: 0,
      },
    });
    expect(result.frameCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private raw provider");
  });

  it("aborts before provider access and wipes loaded frames when frame work crosses the deadline", async () => {
    const provider = successfulProvider();
    const frameBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    let currentTime = NOW;

    await expect(
      runMultimodalJudgeEvaluation(inputFixture(), contextFixture(), {
        provider,
        loadFrames: vi.fn(async () => {
          currentTime = contextFixture().deadlineAt;
          return { frames: [frameFixture(frameBytes)], warnings: [] };
        }),
        now: () => currentTime,
      }),
    ).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
      disposition: "retryable",
    });

    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(frameBytes).toEqual(new Uint8Array(4));
  });

  it("times out an indefinitely pending injected frame loader", async () => {
    vi.useFakeTimers();
    try {
      const provider = successfulProvider();
      let aborted = false;
      const loadFrames = vi.fn(
        async ({ signal }: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      );
      const pending = runMultimodalJudgeEvaluation(
        inputFixture(),
        contextFixture(),
        { provider, loadFrames, now: () => NOW },
      );
      const rejection = expect(pending).rejects.toMatchObject({
        code: "DEADLINE_EXCEEDED",
        disposition: "retryable",
      });

      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(aborted).toBe(true);
      expect(provider.evaluate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts provider errors into a content-free manual-review fallback", async () => {
    const frameBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const provider: InlineMultimodalJudgeProvider = {
      descriptor: descriptorFixture(),
      evaluate: vi.fn(async () => {
        throw new Error("private raw provider payload and API key");
      }),
    };
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [frameFixture(frameBytes)],
          warnings: [],
        })),
        now: () => NOW,
      },
    );
    expect(result.candidate).toMatchObject({
      recommendation: "review_required",
      warnings: ["provider_evaluation_unavailable"],
    });
    expect(JSON.stringify(result)).not.toContain("private raw provider");
    expect(frameBytes).toEqual(new Uint8Array(4));
  });

  it("persists httpStatus, hopUsed, and invocation count when evaluate throws a mocked 404", async () => {
    const provider: InlineMultimodalJudgeProvider = {
      descriptor: descriptorFixture(),
      transportFallbackDescriptor: {
        provider: "hetzner-inference",
        model: "hetzner-judge",
        visionModel: "hetzner-vision",
      },
      evaluate: vi.fn(async () => {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "retryable",
          "Multimodal provider is temporarily unavailable",
          {
            hopUsed: "transport_fallback",
            telemetry: {
              lastFailureKind: "upstream_unavailable",
              httpStatusClass: "4xx",
              transportAttemptCount: 3,
              httpStatus: 404,
            },
          },
        );
      }),
    };
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [frameFixture()],
          warnings: [],
        })),
        now: () => NOW,
      },
    );
    expect(result.invocationMetadata).toMatchObject({
      outcome: "fallback",
      invocationCount: 2,
      latencyMs: 0,
      failureDiagnostics: {
        httpStatus: 404,
        errorClass: "ProviderError",
        errorCode: "PROVIDER_UNAVAILABLE",
        disposition: "retryable",
        lastFailureKind: "upstream_unavailable",
        hopUsed: "transport_fallback",
        invocationCount: 2,
        frameCount: 1,
      },
    });
    expect(result.frameCount).toBe(1);
    expect(result.frameWarnings).toEqual([]);
  });

  it("records a network evaluate failure without logging the provider payload", async () => {
    const provider: InlineMultimodalJudgeProvider = {
      descriptor: descriptorFixture(),
      evaluate: vi.fn(async () => {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "retryable",
          "Multimodal provider is temporarily unavailable",
          {
            telemetry: {
              lastFailureKind: "network",
              httpStatusClass: null,
              transportAttemptCount: 1,
            },
          },
        );
      }),
    };
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [frameFixture()],
          warnings: [],
        })),
        now: () => NOW,
      },
    );
    expect(result.invocationMetadata.failureDiagnostics).toMatchObject({
      errorCode: "PROVIDER_UNAVAILABLE",
      lastFailureKind: "network",
      hopUsed: "none",
      invocationCount: 1,
      frameCount: 1,
    });
    expect(result.invocationMetadata.failureDiagnostics).not.toHaveProperty(
      "httpStatus",
    );
    expect(JSON.stringify(result)).not.toContain("temporarily unavailable");
  });

  it("persists no late provider result and wipes frames when provider work crosses the deadline", async () => {
    const frameBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    let currentTime = NOW;
    const provider = successfulProvider(async (input) => {
      currentTime = contextFixture().deadlineAt;
      return resultFixture(input, validCandidate());
    });

    await expect(
      runMultimodalJudgeEvaluation(inputFixture(), contextFixture(), {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [frameFixture(frameBytes)],
          warnings: [],
        })),
        now: () => currentTime,
      }),
    ).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
      disposition: "retryable",
    });

    expect(provider.evaluate).toHaveBeenCalledOnce();
    expect(frameBytes).toEqual(new Uint8Array(4));
  });

  it("degrades provider metadata completed outside the request window", async () => {
    const provider = successfulProvider(async (input) => {
      const result = resultFixture(input, validCandidate());
      result.metadata.completedAt = new Date(
        contextFixture().deadlineAt.getTime() + 1,
      );
      return result;
    });

    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [frameFixture()],
          warnings: [],
        })),
        now: () => NOW,
      },
    );

    expect(result.candidate).toMatchObject({
      recommendation: "review_required",
      warnings: ["provider_evaluation_unavailable"],
    });
    expect(result.invocationMetadata).toMatchObject({
      outcome: "fallback",
      completedAt: NOW,
    });
  });

  it("wipes loaded bytes when strict provider-input projection rejects a frame", async () => {
    const frameBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const provider = successfulProvider();

    await expect(
      runMultimodalJudgeEvaluation(inputFixture(), contextFixture(), {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [{ ...frameFixture(frameBytes), timestampMs: 999_999 }],
          warnings: [],
        })),
        now: () => NOW,
      }),
    ).rejects.toBeDefined();

    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(frameBytes).toEqual(new Uint8Array(4));
  });

  it("revalidates candidate IDs and hashes at the worker boundary", async () => {
    const provider = successfulProvider(async (input) => {
      const candidate = validCandidate();
      candidate.questionEvaluations[0]!.questionId =
        "71000000-0000-4000-8000-000000000099";
      return resultFixture(input, candidate);
    });
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider,
        loadFrames: vi.fn(async () => ({
          frames: [frameFixture()],
          warnings: [],
        })),
        now: () => NOW,
      },
    );
    expect(result.candidate.recommendation).toBe("review_required");
    expect(result.candidate.warnings).toEqual([
      "provider_evaluation_unavailable",
    ]);
  });

  it("wipes plaintext frames from a malformed injected loader result", async () => {
    const jpegBytes = frameFixture().jpegBytes;
    const result = await runMultimodalJudgeEvaluation(
      inputFixture(),
      contextFixture(),
      {
        provider: successfulProvider(),
        loadFrames: vi.fn(
          async () =>
            ({
              frames: [frameFixture(jpegBytes)],
              warnings: ["invalid-warning"],
            }) as never,
        ),
        now: () => NOW,
      },
    );
    expect(result.candidate.recommendation).toBe("pass");
    expect(result.frameWarnings).toEqual(["frames_unavailable"]);
    expect([...jpegBytes].every((byte) => byte === 0)).toBe(true);
  });

  it("rejects a context belonging to another attempt before evidence loading", async () => {
    const loadFrames = vi.fn();
    await expect(
      runMultimodalJudgeEvaluation(
        inputFixture(),
        {
          ...contextFixture(),
          attemptId: "71000000-0000-4000-8000-000000000099",
        },
        {
          provider: successfulProvider(),
          loadFrames,
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(loadFrames).not.toHaveBeenCalled();
  });

  it("projects only question-bound transcript segments", () => {
    const projected = projectMultimodalJudgeProviderInputV1(inputFixture(), [
      frameFixture(),
    ]);
    expect(projected.transcriptSegments).toEqual([
      expect.objectContaining({ questionId: QUESTION_ID }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("private practice answer");
  });
});

function successfulProvider(
  evaluate: InlineMultimodalJudgeProvider["evaluate"] = vi.fn(async (input) =>
    resultFixture(input, validCandidate()),
  ),
): InlineMultimodalJudgeProvider & { evaluate: ReturnType<typeof vi.fn> } {
  return {
    descriptor: descriptorFixture(),
    evaluate: vi.fn(evaluate),
  };
}

function descriptorFixture() {
  return {
    provider: "hetzner-inference",
    model: "judge-text",
    visionModel: "judge-vision",
  };
}

function resultFixture(
  input: MultimodalJudgeProviderInputV1,
  candidate: MultimodalJudgeCandidateV1,
) {
  return {
    candidate,
    metadata: {
      schemaVersion: "1" as const,
      provider: "hetzner-inference",
      model: input.frames.length > 0 ? "judge-vision" : "judge-text",
      promptVersion: "proof-judge-system-v2" as const,
      outputSchemaVersion: "multimodal-judge-candidate-v1" as const,
      inputHash: multimodalJudgeProviderInputHashV1(input),
      outputHash: multimodalJudgeCandidateHashV1(candidate),
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      latencyMs: 20,
      invocationCount: 1 as const,
      outcome: "generated" as const,
      degraded: false,
      completedAt: NOW,
    },
  };
}

function validCandidate(): MultimodalJudgeCandidateV1 {
  return {
    schemaVersion: "1",
    candidateVersion: "multimodal-judge-candidate-v1",
    recommendation: "pass",
    questionEvaluations: [
      {
        questionId: QUESTION_ID,
        criterionResults: [
          {
            criterionId: CRITERION_ID,
            result: "met",
            supportedPatchAnchorIds: ["a0"],
            reason: "patch_evidence_supports_criterion",
          },
        ],
        contradictions: [],
        uncertainty: [],
      },
    ],
    privateReason: "all_stored_criteria_supported",
    warnings: [],
  };
}

function frameFixture(jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) {
  return {
    id: FRAME_ID,
    timestampMs: 2_000,
    reasonCode: "transcript_alignment" as const,
    width: 320 as const,
    height: 180 as const,
    mediaType: "image/jpeg" as const,
    jpegBytes,
  };
}

function contextFixture(): ProviderContextV1 {
  return {
    schemaVersion: "1",
    requestId: "71000000-0000-4000-8000-000000000010",
    attemptId: ATTEMPT_ID,
    deadlineAt: new Date(NOW.getTime() + 30_000),
  };
}

function inputFixture() {
  return ProofEvaluationInputV1Schema.parse({
    schemaVersion: "1",
    inputVersion: "proof-evaluation-input-v1",
    attemptId: ATTEMPT_ID,
    revisionId: REVISION_ID,
    headSha: "a".repeat(40),
    systemInstructionVersion: "proof-judge-system-v1",
    questions: [
      {
        id: QUESTION_ID,
        promptVersion: "proof-questions-v1",
        prompt: "Explain why the changed transaction path rolls back safely.",
        patchAnchorIds: ["a0"],
        rubricVersion: "rubric-v1",
        rubric: [
          {
            id: CRITERION_ID,
            description: "Explains the rollback boundary.",
            requiredTerms: ["rollback"],
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
          content: "src/transaction.ts",
        },
        patch: {
          trust: "untrusted",
          source: "pull_request_patch",
          content: "+ await transaction.rollback();",
        },
      },
    ],
    transcript: {
      schemaVersion: "1",
      transcriptVersion: "transcript-v1",
      id: TRANSCRIPT_ID,
      attemptId: ATTEMPT_ID,
      provider: "openrouter",
      model: "transcription-model",
      language: "en",
      durationMs: 5_000,
      sourceSha256: "b".repeat(64),
      segments: [
        {
          id: BOUND_SEGMENT_ID,
          questionId: QUESTION_ID,
          startMs: 0,
          endMs: 4_000,
          speaker: "contributor",
          text: {
            trust: "untrusted",
            source: "transcript",
            content: "The transaction rolls back before state is published.",
          },
        },
        {
          id: UNBOUND_SEGMENT_ID,
          startMs: 4_000,
          endMs: 5_000,
          speaker: "unknown",
          text: {
            trust: "untrusted",
            source: "transcript",
            content: "private practice answer must never reach the judge",
          },
        },
      ],
      createdAt: NOW,
    },
    frameSelection: {
      schemaVersion: "1",
      selectionVersion: "frame-selection-v1",
      attemptId: ATTEMPT_ID,
      recordingDurationMs: 5_000,
      frames: [
        {
          id: FRAME_ID,
          timestampMs: 2_000,
          reasonCode: "transcript_alignment",
          reason: "Middle of the question-bound answer.",
          encryptedDerivativeRef: FRAME_REFERENCE,
          ciphertextSha256: "c".repeat(64),
          width: 320,
          height: 180,
        },
      ],
    },
  });
}
