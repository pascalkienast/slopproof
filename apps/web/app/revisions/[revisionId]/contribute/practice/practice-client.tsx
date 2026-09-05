"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type PatchReference = {
  anchorId: string;
  file: string;
  oldStart: number;
  newStart: number;
};

type LearningStatement = {
  text: string;
  patchReferences: PatchReference[];
};

type PracticeQuestion = {
  id: string;
  order: number;
  prompt: string;
  focus: string;
  patchReferences: PatchReference[];
};

type PracticeFeedback = {
  practiceQuestionId: string;
  understood: LearningStatement;
  missingPatchDetail: LearningStatement;
  hint: LearningStatement;
};

type PracticePatchPreview = {
  title: string;
  anchors: Array<{
    id: string;
    file: string;
    hunkHeader: string;
    oldStart: number;
    newStart: number;
    changedLines: number;
    evidence: string;
  }>;
};

type LearningBundle = {
  id: string;
  generationOutcome: "generated" | "repaired" | "fallback";
  deleteAfter: string;
  patchIntent: LearningStatement;
  changedAreas: LearningStatement[];
  behaviors: LearningStatement[];
  interfaces: LearningStatement[];
  risks: LearningStatement[];
  testGaps: LearningStatement[];
  testIdeas: LearningStatement[];
  rollbackSignals: LearningStatement[];
  practiceQuestions: PracticeQuestion[];
};

type PracticeView =
  | { schemaVersion: "1"; state: "unavailable" }
  | {
      schemaVersion: "1";
      state: "generating";
      revisionId: string;
      headSha: string;
    }
  | {
      schemaVersion: "1";
      state: "generation_failed";
      revisionId: string;
      headSha: string;
    }
  | {
      schemaVersion: "1";
      state: "ready";
      revisionId: string;
      headSha: string;
      patchPreview: PracticePatchPreview;
      learning: LearningBundle;
      practiceSession: null | {
        id: string;
        deleteAfter: string;
        questions: PracticeQuestion[];
        pendingQuestionIds: string[];
        answersByQuestionId: Record<string, string>;
        feedbackByQuestionId: Record<string, PracticeFeedback>;
      };
    };

type PracticeMutation =
  | { operation: "start" }
  | {
      operation: "answer";
      sessionId: string;
      questionId: string;
      answer: string;
    };

export function PracticeClient({
  revisionId,
  establishDemoSession,
}: {
  revisionId: string;
  establishDemoSession: boolean;
}) {
  const [view, setView] = useState<PracticeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [pendingQuestionIds, setPendingQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pollAttempts, setPollAttempts] = useState(0);

  const applyView = useCallback(
    (next: PracticeView) => {
      setView(next);
      setError(null);
      if (next.state === "ready" && next.practiceSession) {
        rememberPracticeSessionId(revisionId, next.practiceSession.id);
        setPendingQuestionIds(new Set(next.practiceSession.pendingQuestionIds));
      }
    },
    [revisionId],
  );

  const refresh = useCallback(async () => {
    const sessionId =
      view?.state === "ready" ? view.practiceSession?.id : undefined;
    applyView(await requestPractice(revisionId, "GET", sessionId));
  }, [applyView, revisionId, view]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (establishDemoSession) {
          const login = await fetch("/api/demo/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: "author" }),
            credentials: "same-origin",
          });
          if (!login.ok) throw new Error("demo_session_failed");
        }
        const storedSessionId = readStoredPracticeSessionId(revisionId);
        const initial = await requestPractice(
          revisionId,
          "GET",
          storedSessionId,
        );
        if (initial.state === "unavailable" && storedSessionId !== undefined) {
          forgetPracticeSessionId(revisionId);
          const retry = await requestPractice(revisionId, "GET");
          if (active) applyView(retry);
        } else if (active) {
          applyView(initial);
        }
      } catch {
        if (active) {
          setError(
            "Practice is temporarily unavailable. Your proof is still ready.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [applyView, establishDemoSession, revisionId]);

  const shouldPoll =
    (view?.state === "generating" || pendingQuestionIds.size > 0) &&
    pollAttempts < 20;
  useEffect(() => {
    if (!shouldPoll) return;
    const timeout = window.setTimeout(() => {
      setPollAttempts((current) => current + 1);
      void refresh().catch(() => undefined);
    }, 3_000);
    return () => window.clearTimeout(timeout);
  }, [refresh, shouldPoll]);

  useEffect(() => {
    if (pollAttempts !== 20) return;
    setError(
      "Private material is taking longer than expected. Reload this page to check again; your proof is unaffected.",
    );
  }, [pollAttempts]);

  async function startPractice() {
    setWorking(true);
    setPollAttempts(0);
    try {
      applyView(await mutatePractice(revisionId, { operation: "start" }));
    } catch (error) {
      setError(practiceFailureMessage(error, "start"));
    } finally {
      setWorking(false);
    }
  }

  async function submitAnswer(
    questionId: string,
    answer: string,
  ): Promise<boolean> {
    if (view?.state !== "ready" || !view.practiceSession) return false;
    setWorking(true);
    setPollAttempts(0);
    setPendingQuestionIds((current) => new Set(current).add(questionId));
    try {
      applyView(
        await mutatePractice(revisionId, {
          operation: "answer",
          sessionId: view.practiceSession.id,
          questionId,
          answer,
        }),
      );
    } catch (error) {
      setPendingQuestionIds((current) => {
        const next = new Set(current);
        next.delete(questionId);
        return next;
      });
      setError(practiceFailureMessage(error, "answer"));
      return false;
    } finally {
      setWorking(false);
    }
    return true;
  }

  if (error && !view) {
    return <section className="notice-card error-card">{error}</section>;
  }
  if (!view) {
    return (
      <section className="notice-card practice-loading" aria-live="polite">
        Loading private learning material…
      </section>
    );
  }
  if (view.state === "unavailable") {
    return (
      <section className="notice-card" aria-live="polite">
        Practice material is no longer available for this revision. This never
        blocks the proof.
      </section>
    );
  }
  if (view.state === "generating") {
    return (
      <section className="notice-card practice-loading" aria-live="polite">
        The patch-bound learning bundle is being prepared. This page will
        refresh automatically; you can return to the proof at any time.
      </section>
    );
  }
  if (view.state === "generation_failed") {
    return (
      <section className="practice-generation-failed" aria-live="polite">
        <div>
          <p className="eyebrow">Practice generator unavailable</p>
          <h2>No generic replacement questions.</h2>
          <p>
            The patch-bound generator did not return usable material. Practice
            stays optional and the live proof is unaffected. Reload later to
            check whether fresh material is available.
          </p>
        </div>
      </section>
    );
  }
  if (view.learning.generationOutcome === "fallback") {
    return (
      <section className="practice-generation-failed" aria-live="polite">
        <div>
          <p className="eyebrow">Practice generator unavailable</p>
          <h2>Fallback material has been withheld.</h2>
          <p>
            UnderstandProof will not present template questions as if they were
            a real reading of this patch.
          </p>
        </div>
      </section>
    );
  }

  return (
    <div className="practice-content">
      {error ? (
        <section className="notice-card error-card" aria-live="polite">
          {error}
        </section>
      ) : null}
      <PracticeWorkspace
        learning={view.learning}
        patchPreview={view.patchPreview}
        practiceSession={view.practiceSession}
        pendingQuestionIds={pendingQuestionIds}
        working={working}
        onStart={startPractice}
        onSubmit={submitAnswer}
      />
    </div>
  );
}

function PracticeWorkspace({
  learning,
  patchPreview,
  practiceSession,
  pendingQuestionIds,
  working,
  onStart,
  onSubmit,
}: {
  learning: LearningBundle;
  patchPreview: PracticePatchPreview;
  practiceSession: Extract<PracticeView, { state: "ready" }>["practiceSession"];
  pendingQuestionIds: Set<string>;
  working: boolean;
  onStart(): Promise<void>;
  onSubmit(questionId: string, answer: string): Promise<boolean>;
}) {
  const questions = practiceSession?.questions ?? learning.practiceQuestions;
  const [activeQuestionId, setActiveQuestionId] = useState(
    () => questions[0]?.id ?? "",
  );
  const activeQuestion =
    questions.find((question) => question.id === activeQuestionId) ??
    questions[0];
  const activeReference = activeQuestion?.patchReferences[0];
  const activeAnchor =
    patchPreview.anchors.find(
      (anchor) => anchor.id === activeReference?.anchorId,
    ) ?? patchPreview.anchors[0];
  const groups = useMemo(
    () =>
      [
        ["Changed areas", learning.changedAreas],
        ["Changed behavior", learning.behaviors],
        ["Interfaces", learning.interfaces],
        ["Risk signals", learning.risks],
        ["Test gaps", learning.testGaps],
        ["Test ideas", learning.testIdeas],
        ["Rollback signals", learning.rollbackSignals],
      ] as const,
    [learning],
  );

  return (
    <section className="practice-workspace">
      <div className="practice-workspace-grid">
        <aside className="practice-patch-pane">
          <div className="practice-pane-heading">
            <div>
              <p className="eyebrow">{patchPreview.title}</p>
              <h2>{activeAnchor?.file ?? patchPreview.title}</h2>
            </div>
            <span>{questions.length} learning goals</span>
          </div>
          {activeAnchor ? (
            <div className="practice-diff" aria-label="Selected patch hunk">
              <code>{activeAnchor.hunkHeader}</code>
              <DiffEvidence evidence={activeAnchor.evidence} />
            </div>
          ) : (
            <div className="practice-diff is-empty">
              <p>No bounded text hunk is available for preview.</p>
            </div>
          )}
          <div className="practice-goal-list" aria-label="Practice goals">
            {questions.map((question, index) => (
              <button
                key={question.id}
                type="button"
                aria-pressed={question.id === activeQuestion?.id}
                className={
                  question.id === activeQuestion?.id ? "is-active" : undefined
                }
                onClick={() => setActiveQuestionId(question.id)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {formatFocus(question.focus)}
              </button>
            ))}
          </div>
        </aside>

        <section className="practice-coach-pane">
          <div className="practice-coach-heading">
            <p className="eyebrow">// Understanding coach</p>
            <h2>
              {activeQuestion
                ? formatFocus(activeQuestion.focus)
                : "Read the patch"}
            </h2>
            <p>
              Practice questions are private and are never reused in the live
              proof.
            </p>
          </div>
          {activeQuestion ? (
            practiceSession ? (
              <PracticeQuestionCard
                key={activeQuestion.id}
                question={activeQuestion}
                {...(practiceSession.answersByQuestionId[activeQuestion.id]
                  ? {
                      submittedAnswer:
                        practiceSession.answersByQuestionId[activeQuestion.id],
                    }
                  : {})}
                {...(practiceSession.feedbackByQuestionId[activeQuestion.id]
                  ? {
                      feedback:
                        practiceSession.feedbackByQuestionId[activeQuestion.id],
                    }
                  : {})}
                pending={pendingQuestionIds.has(activeQuestion.id)}
                disabled={working}
                onSubmit={onSubmit}
              />
            ) : (
              <article className="practice-question-preview">
                <p className="eyebrow">Practice question · private</p>
                <h3>{activeQuestion.prompt}</h3>
                <References references={activeQuestion.patchReferences} />
                <p>
                  Start a short-lived session to answer this prompt and receive
                  a concrete hint.
                </p>
                <button
                  className="button"
                  type="button"
                  disabled={working}
                  onClick={() => void onStart()}
                >
                  {working ? "Starting…" : "Start private practice"}
                </button>
              </article>
            )
          ) : null}
          <div
            className="practice-progress"
            role="progressbar"
            aria-label="Completed practice questions"
            aria-valuemin={0}
            aria-valuemax={questions.length}
            aria-valuenow={
              practiceSession
                ? Object.keys(practiceSession.feedbackByQuestionId).length
                : 0
            }
          >
            {questions.map((question) => (
              <span
                key={question.id}
                aria-hidden="true"
                className={
                  practiceSession?.feedbackByQuestionId[question.id]
                    ? "is-complete"
                    : question.id === activeQuestion?.id
                      ? "is-current"
                      : undefined
                }
              />
            ))}
          </div>
          <small>
            {practiceSession
              ? `Private until ${formatExpiry(practiceSession.deleteAfter)}`
              : `Learning map expires ${formatExpiry(learning.deleteAfter)}`}
          </small>
        </section>
      </div>
      <details className="practice-map-details">
        <summary>Explore the full patch map</summary>
        <article className="practice-map-intent">
          <p className="eyebrow">Patch intent</p>
          <p>{learning.patchIntent.text}</p>
          <References references={learning.patchIntent.patchReferences} />
        </article>
        <div className="practice-map-groups">
          {groups.map(([title, statements]) => (
            <section key={title}>
              <h3>{title}</h3>
              {statements.length === 0 ? (
                <p className="practice-muted">
                  No separate signal in this patch.
                </p>
              ) : (
                statements.map((statement, index) => (
                  <div key={`${title}:${index}`}>
                    <p>{statement.text}</p>
                    <References references={statement.patchReferences} />
                  </div>
                ))
              )}
            </section>
          ))}
        </div>
      </details>
    </section>
  );
}

function DiffEvidence({ evidence }: { evidence: string }) {
  const lines = evidence.split("\n");
  return (
    <pre>
      {lines.map((line, index) => (
        <span
          key={`${String(index)}:${line}`}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "practice-diff-line is-added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "practice-diff-line is-removed"
                : line.startsWith("@@")
                  ? "practice-diff-line is-metadata"
                  : "practice-diff-line"
          }
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function PracticeQuestionCard({
  question,
  submittedAnswer,
  feedback,
  pending,
  disabled,
  onSubmit,
}: {
  question: PracticeQuestion;
  submittedAnswer?: string;
  feedback?: PracticeFeedback;
  pending: boolean;
  disabled: boolean;
  onSubmit(questionId: string, answer: string): Promise<boolean>;
}) {
  const [answer, setAnswer] = useState("");
  const byteLength = new TextEncoder().encode(answer.trim()).byteLength;
  const canSubmit =
    !feedback &&
    !pending &&
    submittedAnswer === undefined &&
    !disabled &&
    byteLength > 0 &&
    byteLength <= 4_000;
  const showComposer =
    feedback === undefined && submittedAnswer === undefined && !pending;

  return (
    <article className="choice-card practice-question-card">
      <div className="practice-question-label">
        <span>{question.order}</span>
        <p className="eyebrow">{question.focus.replaceAll("_", " ")}</p>
      </div>
      <h3>{question.prompt}</h3>
      <References references={question.patchReferences} />
      {submittedAnswer ? (
        <section className="practice-submitted-answer">
          <p className="eyebrow">Your explanation</p>
          <p>{submittedAnswer}</p>
        </section>
      ) : null}
      {feedback ? (
        <div className="practice-feedback" aria-live="polite">
          <FeedbackBlock
            title="What you understood"
            value={feedback.understood}
          />
          <FeedbackBlock
            title="Patch detail to add"
            value={feedback.missingPatchDetail}
          />
          <FeedbackBlock title="Hint for another pass" value={feedback.hint} />
        </div>
      ) : showComposer ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const submitted = answer.trim();
            if (!canSubmit) return;
            void onSubmit(question.id, submitted).then((accepted) => {
              if (accepted) setAnswer("");
            });
          }}
        >
          <label htmlFor={`practice-answer-${question.id}`}>
            Your explanation
          </label>
          <textarea
            id={`practice-answer-${question.id}`}
            value={answer}
            rows={5}
            maxLength={4_000}
            disabled={pending || disabled}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="practice-answer-actions">
            <small>{byteLength.toLocaleString()} / 4,000 UTF-8 bytes</small>
            <button className="button" type="submit" disabled={!canSubmit}>
              {pending ? "Preparing private feedback…" : "Get a concrete hint"}
            </button>
          </div>
        </form>
      ) : pending ? (
        <p className="practice-muted" aria-live="polite">
          Feedback is queued. It does not delay or affect your proof.
        </p>
      ) : null}
    </article>
  );
}

function FeedbackBlock({
  title,
  value,
}: {
  title: string;
  value: LearningStatement;
}) {
  return (
    <section>
      <p className="eyebrow">{title}</p>
      <p>{value.text}</p>
      <References references={value.patchReferences} />
    </section>
  );
}

function References({ references }: { references: PatchReference[] }) {
  return (
    <div className="practice-references" aria-label="Patch references">
      {references.map((reference) => (
        <code
          key={`${reference.anchorId}:${reference.file}:${reference.oldStart}:${reference.newStart}`}
        >
          {reference.file} · −{reference.oldStart} / +{reference.newStart}
        </code>
      ))}
    </div>
  );
}

async function requestPractice(
  revisionId: string,
  method: "GET",
  practiceSessionId?: string,
): Promise<PracticeView> {
  const url = new URL(
    `/api/revisions/${encodeURIComponent(revisionId)}/practice`,
    window.location.origin,
  );
  if (practiceSessionId) url.searchParams.set("sessionId", practiceSessionId);
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("practice_read_failed");
  return (await response.json()) as PracticeView;
}

async function mutatePractice(
  revisionId: string,
  mutation: PracticeMutation,
): Promise<PracticeView> {
  const csrf = readCookie("slopproof_csrf");
  if (!csrf) throw new Error("csrf_unavailable");
  const response = await fetch(
    `/api/revisions/${encodeURIComponent(revisionId)}/practice`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-slopproof-csrf": csrf,
      },
      body: JSON.stringify(mutation),
    },
  );
  if (!response.ok) {
    const rawRetryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = rawRetryAfter ? Number(rawRetryAfter) : undefined;
    throw new PracticeRequestFailure(
      response.status,
      retryAfterSeconds !== undefined &&
        Number.isSafeInteger(retryAfterSeconds) &&
        retryAfterSeconds >= 1 &&
        retryAfterSeconds <= 3_600
        ? retryAfterSeconds
        : undefined,
    );
  }
  return (await response.json()) as PracticeView;
}

class PracticeRequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super("practice_request_failed");
    this.name = "PracticeRequestFailure";
  }
}

function practiceSessionStorageKey(revisionId: string): string {
  return `slopproof:practice-session:${revisionId}`;
}

function readStoredPracticeSessionId(revisionId: string): string | undefined {
  try {
    const raw = sessionStorage.getItem(practiceSessionStorageKey(revisionId));
    return raw !== null && /^[0-9a-f-]{36}$/iu.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function rememberPracticeSessionId(
  revisionId: string,
  sessionId: string,
): void {
  try {
    sessionStorage.setItem(practiceSessionStorageKey(revisionId), sessionId);
  } catch {
    // Restoring the private session after reload is best-effort.
  }
}

function forgetPracticeSessionId(revisionId: string): void {
  try {
    sessionStorage.removeItem(practiceSessionStorageKey(revisionId));
  } catch {
    // Ignoring storage failures keeps practice usable.
  }
}

function practiceFailureMessage(
  error: unknown,
  operation: "start" | "answer",
): string {
  if (error instanceof PracticeRequestFailure && error.status === 429) {
    return `Too many private practice requests. Try again in about ${error.retryAfterSeconds ?? 60} seconds.`;
  }
  return operation === "start"
    ? "The private practice session could not be started yet."
    : "Feedback could not be queued. Please try that answer again.";
}

function readCookie(name: string): string | undefined {
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }
  return undefined;
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : "soon";
}

function formatFocus(value: string): string {
  const normalized = value.replaceAll("_", " ").trim();
  return normalized.length === 0
    ? "Patch understanding"
    : normalized[0]!.toUpperCase() + normalized.slice(1);
}
