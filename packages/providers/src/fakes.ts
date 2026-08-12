import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  FakeTranscriptionRequestV1Schema,
  ProofEvaluationInputV1Schema,
  ProofEvaluationV1Schema,
  ProviderContextV1Schema,
  TranscriptV1Schema,
  type FakeTranscriptionRequestV1,
  type MultimodalJudgeProvider,
  type ProofEvaluationInputV1,
  type ProofEvaluationV1,
  type ProviderContextV1,
  type TranscriptV1,
  type TranscriptionProvider,
} from "./contracts";
import { ProviderError } from "./errors";

export interface ProviderClock {
  now(): Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "retryable",
      "Local hash provider returned an invalid digest",
    );
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ProviderError(
      "INVALID_INPUT",
      "terminal",
      "Provider input failed its versioned schema",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function assertContext(
  rawContext: unknown,
  attemptId: string,
  clock: ProviderClock,
): ProviderContextV1 {
  const context = parseInput(ProviderContextV1Schema, rawContext);
  if (context.attemptId !== attemptId) {
    throw new ProviderError(
      "INVALID_INPUT",
      "terminal",
      "Provider context belongs to a different attempt",
    );
  }
  if (context.deadlineAt.getTime() <= clock.now().getTime()) {
    throw new ProviderError(
      "DEADLINE_EXCEEDED",
      "retryable",
      "Provider deadline elapsed before local execution",
    );
  }
  return context;
}

export class LocalFakeTranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly clock: ProviderClock) {}

  async transcribe(
    rawInput: FakeTranscriptionRequestV1,
    rawContext: ProviderContextV1,
  ): Promise<TranscriptV1> {
    const input = parseInput(FakeTranscriptionRequestV1Schema, rawInput);
    assertContext(rawContext, input.attemptId, this.clock);
    const transcript = {
      schemaVersion: "1" as const,
      transcriptVersion: "transcript-v1" as const,
      id: deterministicUuid(
        `fake-transcript:${input.attemptId}:${input.sourceSha256}:${input.language}`,
      ),
      attemptId: input.attemptId,
      provider: "local-fake",
      model: "deterministic-transcription-v1",
      language: input.language,
      durationMs: input.durationMs,
      sourceSha256: input.sourceSha256,
      segments: input.segments.map((segment, index) => ({
        id: deterministicUuid(
          `fake-transcript-segment:${input.attemptId}:${String(index)}:${segment.startMs}:${segment.endMs}:${sha256(segment.text)}`,
        ),
        ...(segment.questionId === undefined
          ? {}
          : { questionId: segment.questionId }),
        startMs: segment.startMs,
        endMs: segment.endMs,
        speaker: "contributor" as const,
        text: {
          trust: "untrusted" as const,
          source: "transcript" as const,
          content: segment.text,
        },
      })),
      createdAt: this.clock.now(),
    };

    const output = TranscriptV1Schema.safeParse(transcript);
    if (!output.success) {
      throw new ProviderError(
        "INVALID_INPUT",
        "terminal",
        "Fake transcription request has invalid timing or segment ordering",
        { cause: output.error },
      );
    }
    return output.data;
  }
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateProofEvaluationAgainstInput(
  rawOutput: unknown,
  input: ProofEvaluationInputV1,
): ProofEvaluationV1 {
  const parsed = ProofEvaluationV1Schema.safeParse(rawOutput);
  if (!parsed.success) {
    throw new ProviderError(
      "INVALID_OUTPUT",
      "review",
      "Provider output failed the strict ProofEvaluationV1 schema",
      { cause: parsed.error },
    );
  }
  const output = parsed.data;
  if (
    output.attemptId !== input.attemptId ||
    output.revisionId !== input.revisionId ||
    output.headSha !== input.headSha ||
    output.systemInstructionVersion !== input.systemInstructionVersion
  ) {
    throw new ProviderError(
      "INVALID_OUTPUT",
      "review",
      "Provider output is not bound to the evaluation input",
    );
  }

  const questions = new Map(
    input.questions.map((question) => [question.id, question]),
  );
  const seenQuestions = new Set<string>();
  for (const questionEvaluation of output.questionEvaluations) {
    const question = questions.get(questionEvaluation.questionId);
    if (
      question === undefined ||
      seenQuestions.has(questionEvaluation.questionId)
    ) {
      throw new ProviderError(
        "UNKNOWN_QUESTION_ID",
        "review",
        "Provider output contains an unknown or duplicate question ID",
      );
    }
    seenQuestions.add(questionEvaluation.questionId);

    const expectedCriteria = new Set(
      question.rubric.map((criterion) => criterion.id),
    );
    const actualCriteria = new Set(
      questionEvaluation.rubricFindings.map((finding) => finding.criterionId),
    );
    if (
      actualCriteria.size !== questionEvaluation.rubricFindings.length ||
      actualCriteria.size !== expectedCriteria.size ||
      [...expectedCriteria].some(
        (criterionId) => !actualCriteria.has(criterionId),
      )
    ) {
      throw new ProviderError(
        "RUBRIC_MISMATCH",
        "review",
        "Provider output does not cover the exact stored rubric",
      );
    }

    const allowedAnchors = new Set(question.patchAnchorIds);
    if (
      questionEvaluation.supportedPatchAnchorIds.some(
        (anchorId) => !allowedAnchors.has(anchorId),
      )
    ) {
      throw new ProviderError(
        "PATCH_ANCHOR_MISMATCH",
        "review",
        "Provider output cites a patch anchor not bound to the question",
      );
    }
  }
  if (seenQuestions.size !== questions.size) {
    throw new ProviderError(
      "UNKNOWN_QUESTION_ID",
      "review",
      "Provider output omits a stored question ID",
    );
  }
  return output;
}

export class LocalFakeMultimodalJudgeProvider implements MultimodalJudgeProvider {
  constructor(private readonly clock: ProviderClock) {}

  async evaluate(
    rawInput: ProofEvaluationInputV1,
    rawContext: ProviderContextV1,
  ): Promise<ProofEvaluationV1> {
    const input = parseInput(ProofEvaluationInputV1Schema, rawInput);
    assertContext(rawContext, input.attemptId, this.clock);

    const questionEvaluations = input.questions.map((question) => {
      const answer = input.transcript.segments
        .filter((segment) => segment.questionId === question.id)
        .map((segment) => segment.text.content)
        .join(" ");
      const normalizedAnswer = normalize(answer);
      const rubricFindings = question.rubric.map((criterion) => {
        const met =
          normalizedAnswer.length > 0 &&
          criterion.requiredTerms.every((term) =>
            normalizedAnswer.includes(normalize(term)),
          );
        return {
          criterionId: criterion.id,
          result: met ? ("met" as const) : ("not_met" as const),
          reason: met
            ? "The deterministic fake found every required rubric term in the question-bound transcript data."
            : "The deterministic fake did not find every required rubric term in the question-bound transcript data.",
        };
      });
      const metCount = rubricFindings.filter(
        (finding) => finding.result === "met",
      ).length;
      const outcome =
        normalizedAnswer.length === 0
          ? ("not_evaluable" as const)
          : metCount === rubricFindings.length
            ? ("met" as const)
            : metCount === 0
              ? ("not_met" as const)
              : ("partial" as const);
      return {
        questionId: question.id,
        outcome,
        rubricFindings,
        supportedPatchAnchorIds:
          outcome === "met" || outcome === "partial"
            ? question.patchAnchorIds
            : [],
        reason:
          outcome === "met"
            ? "All stored rubric criteria were matched by deterministic fixture signals."
            : outcome === "not_evaluable"
              ? "No transcript segment was bound to this question."
              : "One or more stored rubric criteria need maintainer review.",
      };
    });

    const recommendation = questionEvaluations.every(
      (evaluation) => evaluation.outcome === "met",
    )
      ? ("pass" as const)
      : questionEvaluations.some(
            (evaluation) => evaluation.outcome === "not_evaluable",
          )
        ? ("retry" as const)
        : ("review_required" as const);

    const output = {
      schemaVersion: "1" as const,
      evaluationVersion: "proof-evaluation-v1" as const,
      attemptId: input.attemptId,
      revisionId: input.revisionId,
      headSha: input.headSha,
      provider: "local-fake",
      model: "deterministic-multimodal-judge-v1",
      systemInstructionVersion: input.systemInstructionVersion,
      recommendation,
      questionEvaluations,
      privateReason:
        "This is an assistive deterministic provider recommendation; only a freshly authorized maintainer may decide the attempt.",
      warnings:
        input.frameSelection.frames.length === 0
          ? [
              "No frame metadata was available; recommendation uses transcript fixtures only.",
            ]
          : [],
      createdAt: this.clock.now(),
    };

    return validateProofEvaluationAgainstInput(output, input);
  }
}
