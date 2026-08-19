import type {
  AuthoritativeMultimodalEvaluationV1,
  PrivateReviewContext,
  ProofEvaluationV1,
  TranscriptV1,
} from "@slopproof/providers";

export const JUDGE_DID_NOT_FINISH =
  "Judge did not finish; this is not a model opinion.";
export const GITHUB_CHECK_NOTICE =
  "This recommendation cannot update the GitHub check.";
export const SPOKEN_ANSWER_UNAVAILABLE = "Spoken answer is not available.";
export const SPOKEN_ANSWER_UNBOUND =
  "No spoken answer was bound to this question.";
export const REQUIRED_POINTS_UNAVAILABLE =
  "No required points were stored for this question.";
export const JUDGE_OPINION_UNAVAILABLE =
  "No judge opinion is available for this question.";

const COMPATIBILITY_PROJECTION_MODEL = "manual-review-projection-v1";

export type ReviewQuestionInput = {
  id: string;
  ordinal: number;
  prompt: string;
  rubric: Record<string, unknown>;
};

export type MaintainerQuestionReview = {
  questionId: string;
  number: number;
  heading: string;
  prompt: string;
  spokenAnswer: string;
  requiredPoints: string[];
  judgeOpinion: string;
  judgeFinished: boolean;
};

export type MaintainerReviewPageView = {
  authorLabel: string;
  authorIsHandle: boolean;
  judgeUnavailable: boolean;
  recommendationLabel: string | null;
  githubCheckNotice: string;
  questions: MaintainerQuestionReview[];
  videoMarkers: { id: string; label: string; timestampMs: number }[];
};

export function formatAuthorLabel(input: {
  authorId: string;
  authorLogin: string | null | undefined;
}): string {
  const login = input.authorLogin?.trim() ?? "";
  if (login.length > 0 && !isBareNumericId(login)) return login;
  return input.authorId;
}

export function isGithubHandle(label: string): boolean {
  return label.trim().length > 0 && !isBareNumericId(label.trim());
}

export function extractRequiredPoints(
  rubric: Record<string, unknown>,
): string[] {
  const raw = rubric.requiredPoints;
  if (!Array.isArray(raw)) return [];
  const points: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text.length > 0) points.push(text);
      continue;
    }
    if (
      item !== null &&
      typeof item === "object" &&
      "description" in item &&
      typeof item.description === "string"
    ) {
      const text = item.description.trim();
      if (text.length > 0) points.push(text);
    }
  }
  return points;
}

export function isCompatibilityOnlyProjection(input: {
  evaluationModel?: string | null;
  evaluationProvider?: string | null;
  evaluation?: Pick<ProofEvaluationV1, "model" | "provider" | "privateReason">;
}): boolean {
  const model = input.evaluation?.model ?? input.evaluationModel;
  const provider = input.evaluation?.provider ?? input.evaluationProvider;
  const reason = input.evaluation?.privateReason ?? "";
  return (
    model === COMPATIBILITY_PROJECTION_MODEL ||
    provider === "multimodal-compatibility-v1" ||
    /compatibility-only projection/i.test(reason)
  );
}

export function isAutomatedJudgeUnavailable(input: {
  evaluationModel?: string | null;
  evaluationProvider?: string | null;
  privateContext: PrivateReviewContext | null;
}): boolean {
  if (isCompatibilityOnlyProjection(input)) return true;
  if (input.privateContext === null) return false;
  if (input.privateContext.schemaVersion === "1") {
    return isCompatibilityOnlyProjection({
      evaluation: input.privateContext.evaluation,
    });
  }
  const evaluation = input.privateContext.authoritativeEvaluation;
  if (evaluation === null) return true;
  return isAuthoritativeFallback(evaluation);
}

export function buildMaintainerReviewView(input: {
  authorId: string;
  authorLogin: string | null;
  recommendation: string | null;
  evaluationModel: string | null;
  evaluationProvider: string | null;
  questions: readonly ReviewQuestionInput[];
  privateContext: PrivateReviewContext | null;
}): MaintainerReviewPageView {
  const authorLabel = formatAuthorLabel(input);
  const judgeUnavailable = isAutomatedJudgeUnavailable(input);
  const transcript = input.privateContext?.transcript ?? null;
  const questions = input.questions.map((question) =>
    buildQuestionReview({
      question,
      transcript,
      judgeUnavailable,
      privateContext: input.privateContext,
    }),
  );
  return {
    authorLabel,
    authorIsHandle: isGithubHandle(authorLabel),
    judgeUnavailable,
    recommendationLabel: judgeUnavailable
      ? null
      : humanRecommendation(
          resolveStoredRecommendation(input, judgeUnavailable),
        ),
    githubCheckNotice: GITHUB_CHECK_NOTICE,
    questions,
    videoMarkers: questionVideoMarkers(questions, transcript),
  };
}

function buildQuestionReview(input: {
  question: ReviewQuestionInput;
  transcript: TranscriptV1 | null;
  judgeUnavailable: boolean;
  privateContext: PrivateReviewContext | null;
}): MaintainerQuestionReview {
  const number = input.question.ordinal + 1;
  const requiredPoints = extractRequiredPoints(input.question.rubric);
  return {
    questionId: input.question.id,
    number,
    heading: `Question ${String(number)}`,
    prompt: input.question.prompt,
    spokenAnswer: spokenAnswerForQuestion(input.transcript, input.question.id),
    requiredPoints,
    judgeOpinion: judgeOpinionForQuestion(input),
    judgeFinished: !input.judgeUnavailable,
  };
}

function spokenAnswerForQuestion(
  transcript: TranscriptV1 | null,
  questionId: string,
): string {
  if (transcript === null) return SPOKEN_ANSWER_UNAVAILABLE;
  const bound = transcript.segments.filter(
    (segment) => segment.questionId === questionId,
  );
  if (bound.length === 0) return SPOKEN_ANSWER_UNBOUND;
  const text = bound
    .map((segment) => segment.text.content.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return text.length > 0 ? text : SPOKEN_ANSWER_UNBOUND;
}

function judgeOpinionForQuestion(input: {
  question: ReviewQuestionInput;
  judgeUnavailable: boolean;
  privateContext: PrivateReviewContext | null;
}): string {
  if (input.judgeUnavailable) return JUDGE_DID_NOT_FINISH;
  if (input.privateContext === null) return JUDGE_OPINION_UNAVAILABLE;
  if (input.privateContext.schemaVersion === "1") {
    return legacyJudgeOpinion(
      input.privateContext.evaluation.questionEvaluations.find(
        (evaluation) => evaluation.questionId === input.question.id,
      ),
    );
  }
  const evaluation = input.privateContext.authoritativeEvaluation;
  if (evaluation === null || isAuthoritativeFallback(evaluation)) {
    return JUDGE_DID_NOT_FINISH;
  }
  return authoritativeJudgeOpinion(
    evaluation.candidate.questionEvaluations.find(
      (question) => question.questionId === input.question.id,
    ),
  );
}

function authoritativeJudgeOpinion(
  evaluation:
    | AuthoritativeMultimodalEvaluationV1["candidate"]["questionEvaluations"][number]
    | undefined,
): string {
  if (evaluation === undefined) return JUDGE_OPINION_UNAVAILABLE;
  const results = evaluation.criterionResults;
  const allMet = results.every((criterion) => criterion.result === "met");
  const anyMissed = results.some((criterion) => criterion.result === "not_met");
  const anyUnclear = results.some(
    (criterion) => criterion.result === "not_evaluable",
  );
  const parts: string[] = [];
  if (
    allMet &&
    evaluation.contradictions.length === 0 &&
    evaluation.uncertainty.length === 0
  ) {
    parts.push(
      "The judge thinks the spoken answer covered the required points.",
    );
  } else if (anyMissed) {
    parts.push("The judge thinks the spoken answer missed required points.");
  } else if (anyUnclear) {
    parts.push(
      "The judge could not tell whether the spoken answer covered the required points.",
    );
  } else {
    parts.push(
      "The judge thinks the spoken answer only partly covered the required points.",
    );
  }
  if (
    evaluation.contradictions.includes(
      "transcript_conflicts_with_patch_evidence",
    )
  ) {
    parts.push("The spoken answer conflicts with the patch.");
  }
  if (
    evaluation.contradictions.includes(
      "question_evidence_is_internally_inconsistent",
    )
  ) {
    parts.push("The spoken answer is inconsistent.");
  }
  if (evaluation.uncertainty.includes("transcript_evidence_incomplete")) {
    parts.push("The spoken answer looks incomplete.");
  }
  return parts.join(" ");
}

function legacyJudgeOpinion(
  evaluation: ProofEvaluationV1["questionEvaluations"][number] | undefined,
): string {
  if (evaluation === undefined) return JUDGE_OPINION_UNAVAILABLE;
  if (isHumanSentence(evaluation.reason)) return evaluation.reason;
  switch (evaluation.outcome) {
    case "met":
      return "The judge thinks the spoken answer covered the required points.";
    case "partial":
      return "The judge thinks the spoken answer only partly covered the required points.";
    case "not_met":
      return "The judge thinks the spoken answer missed required points.";
    case "not_evaluable":
      return "The judge could not tell whether the spoken answer covered the required points.";
  }
}

function resolveStoredRecommendation(
  input: {
    recommendation: string | null;
    privateContext: PrivateReviewContext | null;
  },
  judgeUnavailable: boolean,
): string | null {
  if (judgeUnavailable) return null;
  if (input.privateContext?.schemaVersion === "2") {
    const evaluation = input.privateContext.authoritativeEvaluation;
    if (evaluation === null || isAuthoritativeFallback(evaluation)) return null;
    return evaluation.candidate.recommendation;
  }
  if (input.privateContext?.schemaVersion === "1") {
    return input.privateContext.evaluation.recommendation;
  }
  return input.recommendation;
}

function humanRecommendation(value: string | null): string | null {
  switch (value) {
    case "pass":
      return "Looks covered";
    case "retry":
      return "Looks incomplete";
    case "review_required":
      return "Needs a look";
    default:
      return null;
  }
}

function questionVideoMarkers(
  questions: readonly MaintainerQuestionReview[],
  transcript: TranscriptV1 | null,
): { id: string; label: string; timestampMs: number }[] {
  if (transcript === null) return [];
  const markers: { id: string; label: string; timestampMs: number }[] = [];
  for (const question of questions) {
    const first = transcript.segments.find(
      (segment) => segment.questionId === question.questionId,
    );
    if (first === undefined) continue;
    markers.push({
      id: `question:${question.questionId}`,
      label: question.heading,
      timestampMs: first.startMs,
    });
  }
  return markers;
}

function isAuthoritativeFallback(
  evaluation: AuthoritativeMultimodalEvaluationV1,
): boolean {
  const candidate = evaluation.candidate;
  return (
    evaluation.invocationMetadata.outcome === "fallback" ||
    evaluation.invocationMetadata.model === COMPATIBILITY_PROJECTION_MODEL ||
    candidate.privateReason === "automated_evaluation_unavailable" ||
    candidate.warnings.includes("provider_evaluation_unavailable") ||
    candidate.warnings.includes("local_fake_manual_review")
  );
}

function isHumanSentence(value: string): boolean {
  const text = value.trim();
  return (
    text.length > 0 &&
    !/^[a-z0-9_]+$/u.test(text) &&
    /[A-Za-z]/u.test(text) &&
    (text.includes(" ") || text.length > 24)
  );
}

function isBareNumericId(value: string): boolean {
  return /^[0-9]+$/u.test(value);
}
