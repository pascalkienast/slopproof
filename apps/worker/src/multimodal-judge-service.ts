import {
  InlineFrameNormalizationResultV1Schema,
  PrivateFrameLoadDeadlineExceededError,
  loadNormalizedInlineJudgeFrames,
  type InlineFrameNormalizationDependencies,
  type InlineFrameNormalizationResultV1,
} from "./inline-frame-normalization";
import {
  AuthoritativeMultimodalEvaluationV1Schema,
  MultimodalJudgeProviderInputV1Schema,
  ProofEvaluationInputV1Schema,
  ProviderContextV1Schema,
  ProviderError,
  describeJudgeEvaluateFailure,
  manualReviewFallbackMultimodalJudgeResultV1,
  validateMultimodalJudgeProviderResultV1,
  type InlineMultimodalJudgeProvider,
  type AuthoritativeMultimodalEvaluationV1,
  type MultimodalJudgeProviderInputV1,
  type ProofEvaluationInputV1,
  type ProviderContextV1,
} from "@understandproof/providers";

export const MultimodalProofEvaluationV1Schema =
  AuthoritativeMultimodalEvaluationV1Schema;

export type MultimodalProofEvaluationV1 = AuthoritativeMultimodalEvaluationV1;

export type MultimodalJudgeServiceDependencies = {
  provider: InlineMultimodalJudgeProvider;
  frameDependencies?: InlineFrameNormalizationDependencies;
  loadFrames?: (input: {
    attemptId: string;
    frameSelection: ProofEvaluationInputV1["frameSelection"];
    deadlineAt: Date;
    signal: AbortSignal;
  }) => Promise<InlineFrameNormalizationResultV1>;
  now?: () => Date;
};

/**
 * Produces a private assistive evaluation. V1 always routes to a maintainer,
 * independently of the provider recommendation.
 */
export async function runMultimodalJudgeEvaluation(
  rawEvaluationInput: ProofEvaluationInputV1,
  rawContext: ProviderContextV1,
  dependencies: MultimodalJudgeServiceDependencies,
): Promise<MultimodalProofEvaluationV1> {
  const evaluationInput =
    ProofEvaluationInputV1Schema.safeParse(rawEvaluationInput);
  const context = ProviderContextV1Schema.safeParse(rawContext);
  const now = dependencies.now ?? (() => new Date());
  const requestStartedAt = now();
  if (
    !evaluationInput.success ||
    !context.success ||
    context.data.attemptId !== evaluationInput.data.attemptId
  ) {
    throw new ProviderError(
      "INVALID_INPUT",
      "terminal",
      "Multimodal evaluation input failed its private binding contract",
    );
  }
  assertBeforeMultimodalDeadline(context.data, requestStartedAt);

  if (!hasCompleteQuestionBoundTranscriptEvidence(evaluationInput.data)) {
    const completedAt = now();
    assertBeforeMultimodalDeadline(context.data, completedAt);
    const providerInput = projectMultimodalJudgeProviderInputV1(
      evaluationInput.data,
      [],
    );
    const providerResult = manualReviewFallbackMultimodalJudgeResultV1(
      providerInput,
      dependencies.provider.descriptor,
      ["question_transcript_unavailable"],
      completedAt,
    );
    return MultimodalProofEvaluationV1Schema.parse({
      schemaVersion: "1",
      evaluationVersion: "multimodal-proof-evaluation-v1",
      attemptId: evaluationInput.data.attemptId,
      revisionId: evaluationInput.data.revisionId,
      headSha: evaluationInput.data.headSha,
      candidate: providerResult.candidate,
      invocationMetadata: providerResult.metadata,
      frameWarnings: [],
      frameCount: 0,
      workflowOutcome: "review_required",
      manualReviewRequired: true,
      createdAt: completedAt,
    });
  }

  const loadFrames = resolveFrameLoader(dependencies);
  let rawLoadedFrames: unknown;
  try {
    rawLoadedFrames = await runUntilMultimodalDeadline(
      context.data,
      requestStartedAt,
      (signal) =>
        loadFrames({
          attemptId: evaluationInput.data.attemptId,
          frameSelection: evaluationInput.data.frameSelection,
          deadlineAt: context.data.deadlineAt,
          signal,
        }),
      wipeLoadedFrameResult,
    );
  } catch (error) {
    if (isMultimodalDeadlineError(error)) throw multimodalDeadlineError();
    assertBeforeMultimodalDeadline(context.data, now());
    rawLoadedFrames = { frames: [], warnings: ["frames_unavailable"] };
  }
  const parsedFrames =
    InlineFrameNormalizationResultV1Schema.safeParse(rawLoadedFrames);
  if (!parsedFrames.success) wipeMalformedLoadedFrames(rawLoadedFrames);
  const loadedFrames = parsedFrames.success
    ? parsedFrames.data
    : { frames: [], warnings: ["frames_unavailable"] as const };
  try {
    assertBeforeMultimodalDeadline(context.data, now());
  } catch (error) {
    for (const frame of loadedFrames.frames) frame.jpegBytes.fill(0);
    throw error;
  }
  try {
    const frameWarnings = [
      ...new Set([
        ...loadedFrames.warnings,
        ...(loadedFrames.frames.length === 0
          ? ["frames_unavailable" as const]
          : []),
      ]),
    ];
    const providerInput = projectMultimodalJudgeProviderInputV1(
      evaluationInput.data,
      loadedFrames.frames,
    );
    let providerResult;
    const evaluateStartedAt = now();
    try {
      providerResult = validateMultimodalJudgeProviderResultV1(
        await runUntilMultimodalDeadline(context.data, evaluateStartedAt, () =>
          dependencies.provider.evaluate(providerInput, context.data),
        ),
        providerInput,
        [
          dependencies.provider.descriptor,
          ...(dependencies.provider.transportFallbackDescriptor === undefined
            ? []
            : [dependencies.provider.transportFallbackDescriptor]),
        ],
      );
      assertProviderCompletionBounds(
        providerResult.metadata.completedAt,
        requestStartedAt,
        now(),
        context.data.deadlineAt,
      );
    } catch (error) {
      if (isMultimodalDeadlineError(error)) throw multimodalDeadlineError();
      const completedAt = now();
      providerResult = manualReviewFallbackMultimodalJudgeResultV1(
        providerInput,
        dependencies.provider.descriptor,
        [...frameWarnings, "provider_evaluation_unavailable"],
        completedAt,
        describeJudgeEvaluateFailure(error, {
          hopUsed:
            dependencies.provider.transportFallbackDescriptor === undefined
              ? "none"
              : "primary",
          latencyMs: completedAt.getTime() - evaluateStartedAt.getTime(),
          frameCount: loadedFrames.frames.length,
        }),
      );
    }
    const completedAt = now();
    assertBeforeMultimodalDeadline(context.data, completedAt);
    assertProviderCompletionBounds(
      providerResult.metadata.completedAt,
      requestStartedAt,
      completedAt,
      context.data.deadlineAt,
    );
    return MultimodalProofEvaluationV1Schema.parse({
      schemaVersion: "1",
      evaluationVersion: "multimodal-proof-evaluation-v1",
      attemptId: evaluationInput.data.attemptId,
      revisionId: evaluationInput.data.revisionId,
      headSha: evaluationInput.data.headSha,
      candidate: providerResult.candidate,
      invocationMetadata: providerResult.metadata,
      frameWarnings,
      frameCount: loadedFrames.frames.length,
      workflowOutcome: "review_required",
      manualReviewRequired: true,
      createdAt: completedAt,
    });
  } finally {
    for (const frame of loadedFrames.frames) frame.jpegBytes.fill(0);
  }
}

export function projectMultimodalJudgeProviderInputV1(
  evaluationInput: ProofEvaluationInputV1,
  frames: MultimodalJudgeProviderInputV1["frames"],
): MultimodalJudgeProviderInputV1 {
  return MultimodalJudgeProviderInputV1Schema.parse({
    schemaVersion: "1",
    inputVersion: "multimodal-judge-input-v1",
    headSha: evaluationInput.headSha,
    questions: evaluationInput.questions.map((question) => ({
      id: question.id,
      promptVersion: question.promptVersion,
      prompt: {
        trust: "untrusted",
        source: "stored_proof_question",
        content: question.prompt,
      },
      patchAnchorIds: question.patchAnchorIds,
      rubricVersion: question.rubricVersion,
      criteria: question.rubric.map((criterion) => ({
        id: criterion.id,
        description: {
          trust: "untrusted",
          source: "stored_rubric",
          content: criterion.description,
        },
        requiredTerms: criterion.requiredTerms.map((term) => ({
          trust: "untrusted" as const,
          source: "stored_rubric" as const,
          content: term,
        })),
      })),
    })),
    patchAnchors: evaluationInput.patchEvidence.map((anchor) => ({
      anchorId: anchor.anchorId,
      filename: {
        trust: "untrusted",
        source: "bounded_patch_anchor",
        content: anchor.filename.content,
      },
      patch: {
        trust: "untrusted",
        source: "bounded_patch_anchor",
        content: anchor.patch.content,
      },
    })),
    transcriptSegments: evaluationInput.transcript.segments.flatMap(
      (segment) =>
        segment.questionId === undefined
          ? []
          : [
              {
                questionId: segment.questionId,
                startMs: segment.startMs,
                endMs: segment.endMs,
                text: {
                  trust: "untrusted" as const,
                  source: "question_bound_transcript" as const,
                  content: segment.text.content,
                },
              },
            ],
    ),
    timing: {
      recordingDurationMs: evaluationInput.transcript.durationMs,
    },
    frames,
  });
}

function hasCompleteQuestionBoundTranscriptEvidence(
  evaluationInput: ProofEvaluationInputV1,
): boolean {
  const questionIdsWithTranscriptEvidence = new Set(
    evaluationInput.transcript.segments.flatMap((segment) =>
      segment.questionId !== undefined && segment.text.content.trim().length > 0
        ? [segment.questionId]
        : [],
    ),
  );
  return evaluationInput.questions.every((question) =>
    questionIdsWithTranscriptEvidence.has(question.id),
  );
}

function resolveFrameLoader(
  dependencies: MultimodalJudgeServiceDependencies,
): NonNullable<MultimodalJudgeServiceDependencies["loadFrames"]> {
  if (dependencies.loadFrames !== undefined) return dependencies.loadFrames;
  if (dependencies.frameDependencies === undefined) {
    throw new ProviderError(
      "INVALID_INPUT",
      "terminal",
      "Multimodal evaluation requires a private frame loader",
    );
  }
  return (input) =>
    loadNormalizedInlineJudgeFrames(input, {
      ...dependencies.frameDependencies!,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
}

async function runUntilMultimodalDeadline<T>(
  context: ProviderContextV1,
  startedAt: Date,
  operation: (signal: AbortSignal) => Promise<T>,
  disposeLateValue?: (value: T) => void,
): Promise<T> {
  assertBeforeMultimodalDeadline(context, startedAt);
  const controller = new AbortController();
  const deadlineError = multimodalDeadlineError();
  const delayMs = Math.max(
    0,
    context.deadlineAt.getTime() - startedAt.getTime(),
  );
  let timedOut = false;
  const operationPromise = Promise.resolve().then(() =>
    operation(controller.signal),
  );
  void operationPromise.then(
    (value) => {
      if (timedOut) disposeLateValue?.(value);
    },
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(deadlineError);
      reject(deadlineError);
    }, delayMs);
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function wipeLoadedFrameResult(value: unknown): void {
  if (typeof value !== "object" || value === null || !("frames" in value)) {
    return;
  }
  const { frames } = value;
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    if (
      typeof frame === "object" &&
      frame !== null &&
      "jpegBytes" in frame &&
      frame.jpegBytes instanceof Uint8Array
    ) {
      frame.jpegBytes.fill(0);
    }
  }
}

function wipeMalformedLoadedFrames(value: unknown): void {
  if (typeof value !== "object" || value === null || !("frames" in value)) {
    return;
  }
  const frames = (value as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    if (
      typeof frame === "object" &&
      frame !== null &&
      "jpegBytes" in frame &&
      frame.jpegBytes instanceof Uint8Array
    ) {
      frame.jpegBytes.fill(0);
    }
  }
}

function assertProviderCompletionBounds(
  providerCompletedAt: Date,
  requestStartedAt: Date,
  serviceCompletedAt: Date,
  deadlineAt: Date,
): void {
  if (
    providerCompletedAt.getTime() < requestStartedAt.getTime() ||
    providerCompletedAt.getTime() > serviceCompletedAt.getTime() ||
    providerCompletedAt.getTime() >= deadlineAt.getTime()
  ) {
    throw new ProviderError(
      "INVALID_OUTPUT",
      "review",
      "Multimodal provider completion metadata is outside the request window",
    );
  }
}

function isMultimodalDeadlineError(error: unknown): boolean {
  return (
    error instanceof PrivateFrameLoadDeadlineExceededError ||
    (error instanceof ProviderError && error.code === "DEADLINE_EXCEEDED")
  );
}

function multimodalDeadlineError(): ProviderError {
  return new ProviderError(
    "DEADLINE_EXCEEDED",
    "retryable",
    "Multimodal evaluation exceeded its private retention deadline",
  );
}

function assertBeforeMultimodalDeadline(
  context: ProviderContextV1,
  at: Date,
): void {
  if (context.deadlineAt.getTime() <= at.getTime()) {
    throw multimodalDeadlineError();
  }
}
