import { readFileSync } from "node:fs";
import type { PrivateReviewContext } from "@slopproof/providers";
import { describe, expect, it } from "vitest";
import {
  AUTOMATED_JUDGMENT_UNAVAILABLE,
  GITHUB_CHECK_NOTICE,
  JUDGE_OPINION_UNAVAILABLE,
  SPOKEN_ANSWER_UNBOUND,
  SPOKEN_ANSWER_UNAVAILABLE,
  buildMaintainerReviewView,
  extractRequiredPoints,
  formatAuthorLabel,
  isAutomatedJudgeUnavailable,
  isGithubHandle,
} from "./review-page-model";

const QUESTION_ID = "83000000-0000-4000-8000-000000000003";
const CRITERION_ID = "83000000-0000-4000-8000-000000000004";
const ATTEMPT_ID = "83000000-0000-4000-8000-000000000001";
const REVISION_ID = "83000000-0000-4000-8000-000000000002";

describe("maintainer review copy", () => {
  it("prefers a GitHub login over a raw numeric author id", () => {
    expect(
      formatAuthorLabel({
        authorId: "500004",
        authorLogin: "demo-contributor",
      }),
    ).toBe("demo-contributor");
    expect(isGithubHandle("demo-contributor")).toBe(true);
    expect(
      formatAuthorLabel({ authorId: "500004", authorLogin: "500004" }),
    ).toBe("500004");
    expect(formatAuthorLabel({ authorId: "500004", authorLogin: null })).toBe(
      "500004",
    );
    expect(isGithubHandle("500004")).toBe(false);
  });

  it("turns stored rubrics into plain sentences and never returns raw JSON", () => {
    expect(
      extractRequiredPoints({
        requiredPoints: [
          "Name the previous empty-string fallback.",
          "Name the new null miss return.",
        ],
        rejectsGenericAnswer: true,
      }),
    ).toEqual([
      "Name the previous empty-string fallback.",
      "Name the new null miss return.",
    ]);
    expect(
      extractRequiredPoints({
        schemaVersion: "2",
        requiredPoints: [
          { description: "Say what the cache returns on a miss." },
        ],
      }),
    ).toEqual(["Say what the cache returns on a miss."]);
    expect(extractRequiredPoints({ requiredPoints: "not-an-array" })).toEqual(
      [],
    );
  });

  it("binds the spoken answer to its question and hides codes from the maintainer", () => {
    const view = buildMaintainerReviewView({
      authorId: "500004",
      authorLogin: "octocat",
      recommendation: "review_required",
      evaluationModel: "manual-review-projection-v1",
      evaluationProvider: "multimodal-compatibility-v1",
      questions: [
        {
          id: QUESTION_ID,
          ordinal: 0,
          prompt: "What does the cache return on a miss?",
          rubric: {
            requiredPoints: ["Name the new null miss return."],
            rejectsGenericAnswer: true,
          },
        },
      ],
      privateContext: scoredContext(),
    });

    expect(view.authorLabel).toBe("octocat");
    expect(view.authorIsHandle).toBe(true);
    expect(view.judgeUnavailable).toBe(false);
    expect(view.recommendationLabel).toBe("Needs a look");
    expect(view.githubCheckNotice).toBe(GITHUB_CHECK_NOTICE);
    expect(view.questions[0]).toMatchObject({
      heading: "Question 1",
      prompt: "What does the cache return on a miss?",
      spokenAnswer: "It now returns null instead of an empty string.",
      requiredPoints: ["Name the new null miss return."],
      judgeOpinion:
        "The judge thinks the spoken answer missed required points. The spoken answer conflicts with the patch.",
      judgeFinished: true,
    });
    expect(view.videoMarkers).toEqual([
      {
        id: `question:${QUESTION_ID}`,
        label: "Question 1",
        timestampMs: 1_000,
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("not_evaluable");
    expect(JSON.stringify(view)).not.toContain("question_evidence_unavailable");
    expect(JSON.stringify(view)).not.toContain(
      "criterion_requires_maintainer_assessment",
    );
    expect(JSON.stringify(view)).not.toContain("AUTHORITATIVE");
    expect(JSON.stringify(view)).not.toContain("rejectsGenericAnswer");
    expect(JSON.stringify(view)).not.toMatch(
      /83000000-0000-4000-8000-000000000004/,
    );
  });

  it("shows a generated sidecar even when evaluations is the persistPair stub", () => {
    const view = buildMaintainerReviewView({
      authorId: "99",
      authorLogin: "octocat",
      recommendation: "review_required",
      evaluationModel: "manual-review-projection-v1",
      evaluationProvider: "multimodal-compatibility-v1",
      questions: [questionFixture()],
      privateContext: persistPairGeneratedContext(),
    });
    expect(
      isAutomatedJudgeUnavailable({
        evaluationModel: "manual-review-projection-v1",
        evaluationProvider: "multimodal-compatibility-v1",
        privateContext: persistPairGeneratedContext(),
      }),
    ).toBe(false);
    expect(view.judgeUnavailable).toBe(false);
    expect(view.recommendationLabel).toBe("Needs a look");
    expect(view.questions[0]?.judgeFinished).toBe(true);
    expect(view.questions[0]?.judgeOpinion).toBe(
      "The judge thinks the spoken answer missed required points. The spoken answer conflicts with the patch.",
    );
    expect(JSON.stringify(view)).not.toContain("Judge did not finish");
  });

  it("presents a completed manual-review fallback without claiming the judge hung", () => {
    const fallback = buildMaintainerReviewView({
      authorId: "99",
      authorLogin: null,
      recommendation: "review_required",
      evaluationModel: "manual-review-projection-v1",
      evaluationProvider: "multimodal-compatibility-v1",
      questions: [questionFixture()],
      privateContext: fallbackContext(),
    });
    expect(fallback.judgeUnavailable).toBe(false);
    expect(fallback.recommendationLabel).toBe("Needs a look");
    expect(fallback.questions[0]?.judgeOpinion).toBe(
      AUTOMATED_JUDGMENT_UNAVAILABLE,
    );
    expect(fallback.questions[0]?.judgeFinished).toBe(true);
    expect(JSON.stringify(fallback)).not.toContain("not_evaluable");
    expect(JSON.stringify(fallback)).not.toContain("not a model opinion");

    const projection = buildMaintainerReviewView({
      authorId: "99",
      authorLogin: "pascalkienast",
      recommendation: "review_required",
      evaluationModel: "manual-review-projection-v1",
      evaluationProvider: "multimodal-compatibility-v1",
      questions: [questionFixture()],
      privateContext: compatibilityOnlyContext(),
    });
    expect(
      isAutomatedJudgeUnavailable({
        evaluationModel: "manual-review-projection-v1",
        evaluationProvider: "multimodal-compatibility-v1",
        privateContext: compatibilityOnlyContext(),
      }),
    ).toBe(true);
    expect(projection.questions[0]?.judgeOpinion).toBe(
      AUTOMATED_JUDGMENT_UNAVAILABLE,
    );
    expect(projection.recommendationLabel).toBeNull();
  });

  it("says plainly when the judge thinks the required points were covered", () => {
    const view = buildMaintainerReviewView({
      authorId: "99",
      authorLogin: "octocat",
      recommendation: "review_required",
      evaluationModel: "manual-review-projection-v1",
      evaluationProvider: "multimodal-compatibility-v1",
      questions: [questionFixture()],
      privateContext: passingContext(),
    });
    expect(view.recommendationLabel).toBe("Looks covered");
    expect(view.questions[0]?.judgeOpinion).toBe(
      "The judge thinks the spoken answer covered the required points.",
    );
    expect(view.questions[0]?.judgeFinished).toBe(true);
  });

  it("keeps the maintainer page as question, answer, required points, opinion, video", () => {
    const queue = readFileSync(
      new URL("../app/review/page.tsx", import.meta.url),
      "utf8",
    );
    const page = readFileSync(
      new URL("../app/review/[attemptId]/page.tsx", import.meta.url),
      "utf8",
    );
    const questions = readFileSync(
      new URL("../app/review/[attemptId]/question-review.tsx", import.meta.url),
      "utf8",
    );
    const player = readFileSync(
      new URL("../app/review/[attemptId]/evidence-player.tsx", import.meta.url),
      "utf8",
    );
    const decision = readFileSync(
      new URL(
        "../app/review/[attemptId]/review-decision-form.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(queue).toContain("Review queue");
    expect(queue).not.toContain("Human review");
    expect(queue).not.toContain("never the decision");
    expect(page).toContain(">Proof<");
    expect(page).not.toContain("not a score");
    expect(page).not.toContain("JUDGE_DID_NOT_FINISH");
    expect(page).toContain("recommendationLabel");
    expect(questions).toContain("Spoken answer");
    expect(questions).toContain("Needed in the answer");
    expect(questions).toContain("Judge opinion");
    expect(questions).not.toContain("JSON.stringify");
    expect(page).toContain("QuestionReviewList");
    expect(page).toContain("EvidencePlayer");
    expect(page).not.toContain("AUTHORITATIVE");
    expect(page).not.toContain("review-frame-grid");
    expect(page).not.toContain("Transcript-aligned frames");
    expect(player).toContain("Watch the proof");
    expect(player).toContain(`/evidence?request=`);
    expect(player).toContain("autoPlay");
    expect(player).not.toContain("fetch(");
    expect(player).not.toContain("evidence-capability");
    expect(player).not.toContain("slopproof_csrf");
    expect(player).not.toContain("Selected frame");
    expect(decision).toContain("Decide for this SHA");
    expect(decision).not.toContain("Human decision only");
    expect(decision).not.toContain("The model cannot");
  });

  it("keeps missing transcript honest and does not invent an answer", () => {
    const view = buildMaintainerReviewView({
      authorId: "99",
      authorLogin: "octocat",
      recommendation: null,
      evaluationModel: null,
      evaluationProvider: null,
      questions: [questionFixture()],
      privateContext: null,
    });
    expect(view.questions[0]?.spokenAnswer).toBe(SPOKEN_ANSWER_UNAVAILABLE);
    expect(view.questions[0]?.judgeOpinion).toBe(JUDGE_OPINION_UNAVAILABLE);
    expect(view.judgeUnavailable).toBe(true);
    expect(view.recommendationLabel).toBeNull();
    expect(view.videoMarkers).toEqual([]);

    const stubWithoutContext = buildMaintainerReviewView({
      authorId: "99",
      authorLogin: "octocat",
      recommendation: "review_required",
      evaluationModel: "manual-review-projection-v1",
      evaluationProvider: "multimodal-compatibility-v1",
      questions: [questionFixture()],
      privateContext: null,
    });
    expect(stubWithoutContext.judgeUnavailable).toBe(true);
    expect(stubWithoutContext.recommendationLabel).toBeNull();
    expect(stubWithoutContext.questions[0]?.judgeOpinion).toBe(
      JUDGE_OPINION_UNAVAILABLE,
    );
    expect(stubWithoutContext.questions[0]?.judgeFinished).toBe(false);

    const unbound = buildMaintainerReviewView({
      authorId: "99",
      authorLogin: "octocat",
      recommendation: "review_required",
      evaluationModel: "manual-review-projection-v1",
      evaluationProvider: "multimodal-compatibility-v1",
      questions: [questionFixture()],
      privateContext: scoredContext({ bindTranscript: false }),
    });
    expect(unbound.questions[0]?.spokenAnswer).toBe(SPOKEN_ANSWER_UNBOUND);
  });
});

function questionFixture() {
  return {
    id: QUESTION_ID,
    ordinal: 0,
    prompt: "What does the cache return on a miss?",
    rubric: {
      requiredPoints: ["Name the new null miss return."],
      rejectsGenericAnswer: true,
    },
  };
}

function scoredContext(
  options: { bindTranscript?: boolean } = {},
): PrivateReviewContext {
  return v2Context({
    authoritative: true,
    fallback: false,
    bindTranscript: options.bindTranscript ?? true,
  });
}

function persistPairGeneratedContext(): PrivateReviewContext {
  const context = scoredContext();
  if (
    context.schemaVersion !== "2" ||
    context.authoritativeEvaluation === null
  ) {
    throw new Error("expected generated V2 sidecar");
  }
  return {
    ...context,
    authoritativeEvaluation: {
      ...context.authoritativeEvaluation,
      invocationMetadata: {
        ...context.authoritativeEvaluation.invocationMetadata,
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        outcome: "generated",
        degraded: false,
      },
    },
  };
}

function passingContext(): PrivateReviewContext {
  const context = scoredContext();
  if (
    context.schemaVersion !== "2" ||
    context.authoritativeEvaluation === null
  ) {
    throw new Error("expected scored V2 context");
  }
  return {
    ...context,
    authoritativeEvaluation: {
      ...context.authoritativeEvaluation,
      candidate: {
        ...context.authoritativeEvaluation.candidate,
        recommendation: "pass",
        questionEvaluations: [
          {
            ...context.authoritativeEvaluation.candidate
              .questionEvaluations[0]!,
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
      },
    },
  };
}

function fallbackContext(): PrivateReviewContext {
  return v2Context({
    authoritative: true,
    fallback: true,
    bindTranscript: true,
  });
}

function compatibilityOnlyContext(): PrivateReviewContext {
  return v2Context({
    authoritative: false,
    fallback: false,
    bindTranscript: true,
  });
}

function v2Context(input: {
  authoritative: boolean;
  fallback: boolean;
  bindTranscript: boolean;
}): PrivateReviewContext {
  return {
    schemaVersion: "2",
    attemptId: ATTEMPT_ID,
    transcript: {
      schemaVersion: "1",
      transcriptVersion: "transcript-v1",
      id: "83000000-0000-4000-8000-000000000005",
      attemptId: ATTEMPT_ID,
      provider: "openrouter",
      model: "whisper",
      language: "en",
      durationMs: 4_000,
      sourceSha256: "a".repeat(64),
      segments: [
        {
          id: "83000000-0000-4000-8000-000000000006",
          ...(input.bindTranscript ? { questionId: QUESTION_ID } : {}),
          startMs: 1_000,
          endMs: 4_000,
          speaker: "contributor",
          text: {
            trust: "untrusted",
            source: "transcript",
            content: "It now returns null instead of an empty string.",
          },
        },
      ],
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
    },
    compatibilityEvaluation: {
      schemaVersion: "1",
      evaluationVersion: "proof-evaluation-v1",
      attemptId: ATTEMPT_ID,
      revisionId: REVISION_ID,
      headSha: "b".repeat(40),
      provider: "multimodal-compatibility-v1",
      model: "manual-review-projection-v1",
      systemInstructionVersion: "proof-judge-system-v1",
      recommendation: "review_required",
      questionEvaluations: [
        {
          questionId: QUESTION_ID,
          outcome: "not_evaluable",
          rubricFindings: [
            {
              criterionId: CRITERION_ID,
              result: "met",
              reason: "Compatibility sentinel",
            },
          ],
          supportedPatchAnchorIds: [],
          reason: "Consult sidecar",
        },
      ],
      privateReason: "Compatibility-only projection",
      warnings: ["authoritative_multimodal_sidecar_required"],
      createdAt: new Date("2026-08-13T00:00:01.000Z"),
    },
    authoritativeEvaluation: input.authoritative
      ? {
          schemaVersion: "1",
          evaluationVersion: "multimodal-proof-evaluation-v1",
          attemptId: ATTEMPT_ID,
          revisionId: REVISION_ID,
          headSha: "b".repeat(40),
          candidate: {
            schemaVersion: "1",
            candidateVersion: "multimodal-judge-candidate-v1",
            recommendation: "review_required",
            questionEvaluations: [
              {
                questionId: QUESTION_ID,
                criterionResults: [
                  {
                    criterionId: CRITERION_ID,
                    result: input.fallback ? "not_evaluable" : "not_met",
                    supportedPatchAnchorIds: input.fallback ? [] : ["a0"],
                    reason: input.fallback
                      ? "question_evidence_unavailable"
                      : "patch_evidence_conflicts_with_criterion",
                  },
                ],
                contradictions: input.fallback
                  ? []
                  : ["transcript_conflicts_with_patch_evidence"],
                uncertainty: input.fallback
                  ? ["criterion_requires_maintainer_assessment"]
                  : [],
              },
            ],
            privateReason: input.fallback
              ? "automated_evaluation_unavailable"
              : "stored_criteria_not_fully_supported",
            warnings: input.fallback ? ["provider_evaluation_unavailable"] : [],
          },
          invocationMetadata: {
            schemaVersion: "1",
            provider: "hetzner-inference",
            model: input.fallback
              ? "manual-review-projection-v1"
              : "judge-model",
            promptVersion: "proof-judge-system-v2",
            outputSchemaVersion: "multimodal-judge-candidate-v1",
            inputHash: "c".repeat(64),
            outputHash: "d".repeat(64),
            tokenUsage: null,
            latencyMs: 100,
            invocationCount: input.fallback ? 0 : 1,
            outcome: input.fallback ? "fallback" : "generated",
            degraded: input.fallback,
            completedAt: new Date("2026-08-13T00:00:00.000Z"),
          },
          frameWarnings: [],
          workflowOutcome: "review_required",
          manualReviewRequired: true,
          createdAt: new Date("2026-08-13T00:00:01.000Z"),
        }
      : null,
    frames: [],
  };
}
