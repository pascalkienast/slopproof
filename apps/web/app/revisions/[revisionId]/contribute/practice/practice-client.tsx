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
      state: "ready";
      revisionId: string;
      headSha: string;
      learning: LearningBundle;
      practiceSession: null | {
        id: string;
        deleteAfter: string;
        questions: PracticeQuestion[];
        pendingQuestionIds: string[];
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

  const applyView = useCallback((next: PracticeView) => {
    setView(next);
    setError(null);
    if (next.state === "ready" && next.practiceSession) {
      setPendingQuestionIds(new Set(next.practiceSession.pendingQuestionIds));
    }
  }, []);

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
        const initial = await requestPractice(revisionId, "GET");
        if (active) applyView(initial);
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

  return (
    <div className="practice-content">
      {error ? (
        <section className="notice-card error-card" aria-live="polite">
          {error}
        </section>
      ) : null}
      <LearningMaterial learning={view.learning} />
      {view.practiceSession ? (
        <section className="practice-question-stack">
          <div className="practice-section-heading">
            <div>
              <p className="eyebrow">Separate practice prompt pool</p>
              <h2>Try the patch in your own words.</h2>
            </div>
            <small>
              Private until {formatExpiry(view.practiceSession.deleteAfter)}
            </small>
          </div>
          {view.practiceSession.questions.map((question) => (
            <PracticeQuestionCard
              key={question.id}
              question={question}
              {...(view.practiceSession!.feedbackByQuestionId[question.id]
                ? {
                    feedback:
                      view.practiceSession!.feedbackByQuestionId[question.id],
                  }
                : {})}
              pending={pendingQuestionIds.has(question.id)}
              disabled={working}
              onSubmit={submitAnswer}
            />
          ))}
        </section>
      ) : (
        <section className="choice-card practice-start-card">
          <p className="eyebrow">Optional private session</p>
          <h2>Ready to try it?</h2>
          <p>
            Practice answers and feedback expire with this learning bundle and
            are never sent to the proof question provider or judge.
          </p>
          <button
            className="button"
            type="button"
            disabled={working}
            onClick={() => void startPractice()}
          >
            {working ? "Starting…" : "Start private practice"}
          </button>
        </section>
      )}
    </div>
  );
}

function LearningMaterial({ learning }: { learning: LearningBundle }) {
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
    <section className="practice-learning">
      <div className="practice-section-heading">
        <div>
          <p className="eyebrow">Exact revision learning map</p>
          <h2>What this patch changes.</h2>
        </div>
        <span className="status-pill">
          {learning.generationOutcome === "fallback"
            ? "safe fallback"
            : learning.generationOutcome}
        </span>
      </div>
      <article className="choice-card practice-intent-card">
        <p className="eyebrow">Patch intent</p>
        <p className="practice-statement">{learning.patchIntent.text}</p>
        <References references={learning.patchIntent.patchReferences} />
      </article>
      <div className="practice-learning-grid">
        {groups.map(([title, statements]) => (
          <article className="choice-card" key={title}>
            <h3>{title}</h3>
            {statements.length === 0 ? (
              <p className="practice-muted">
                No separate signal in this patch.
              </p>
            ) : (
              <ul className="practice-statement-list">
                {statements.map((statement, index) => (
                  <li key={`${title}:${index}`}>
                    <p>{statement.text}</p>
                    <References references={statement.patchReferences} />
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
      <p className="practice-expiry">
        This private material expires {formatExpiry(learning.deleteAfter)}.
      </p>
    </section>
  );
}

function PracticeQuestionCard({
  question,
  feedback,
  pending,
  disabled,
  onSubmit,
}: {
  question: PracticeQuestion;
  feedback?: PracticeFeedback;
  pending: boolean;
  disabled: boolean;
  onSubmit(questionId: string, answer: string): Promise<boolean>;
}) {
  const [answer, setAnswer] = useState("");
  const byteLength = new TextEncoder().encode(answer.trim()).byteLength;
  const canSubmit =
    !feedback && !pending && !disabled && byteLength > 0 && byteLength <= 4_000;

  return (
    <article className="choice-card practice-question-card">
      <div className="practice-question-label">
        <span>{question.order}</span>
        <p className="eyebrow">{question.focus.replaceAll("_", " ")}</p>
      </div>
      <h3>{question.prompt}</h3>
      <References references={question.patchReferences} />
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
      ) : (
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
          {pending ? (
            <p className="practice-muted" aria-live="polite">
              Feedback is queued. It does not delay or affect your proof.
            </p>
          ) : null}
        </form>
      )}
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
