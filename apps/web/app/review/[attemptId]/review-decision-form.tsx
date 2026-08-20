"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ReviewAction } from "../../../lib/maintainer-review";

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting"; action: ReviewAction }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

export function ReviewDecisionForm({
  attemptId,
  headSha,
}: {
  attemptId: string;
  headSha: string;
}) {
  const router = useRouter();
  const [explanation, setExplanation] = useState("");
  const [state, setState] = useState<SubmissionState>({ kind: "idle" });
  const requestKey = useRef<{ action: ReviewAction; key: string } | null>(null);

  async function submit(action: ReviewAction): Promise<void> {
    const csrf = readCookie("slopproof_csrf");
    if (!csrf) {
      setState({ kind: "error", message: "The CSRF credential is missing." });
      return;
    }
    if (requestKey.current?.action !== action) {
      requestKey.current = {
        action,
        key: `review:${crypto.randomUUID()}`,
      };
    }
    setState({ kind: "submitting", action });
    try {
      const response = await fetch(`/api/review/${attemptId}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slopproof-csrf": csrf,
        },
        body: JSON.stringify({
          action,
          expectedHeadSha: headSha,
          explanation: explanation.trim() || undefined,
          idempotencyKey: requestKey.current.key,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        status?: string;
      } | null;
      if (!response.ok) {
        throw new Error(
          result?.error === "review_conflict"
            ? "The SHA or review state changed. Reload before deciding."
            : "The review decision could not be recorded.",
        );
      }
      setState({
        kind: "done",
        message: `Decision recorded: ${result?.status?.replaceAll("_", " ") ?? action}.`,
      });
      router.refresh();
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Decision failed.",
      });
    }
  }

  const submitting = state.kind === "submitting";
  return (
    <section
      className="review-decision-card"
      aria-labelledby="decision-heading"
    >
      <p className="eyebrow">Decision</p>
      <h2 id="decision-heading">Decide for this SHA</h2>
      <label htmlFor="review-explanation">Reason or reviewer note</label>
      <textarea
        id="review-explanation"
        maxLength={2_000}
        onChange={(event) => setExplanation(event.target.value)}
        placeholder="Optional reviewer note"
        rows={5}
        value={explanation}
      />
      <div className="review-actions">
        <button
          className="button review-approve"
          disabled={submitting}
          onClick={() => void submit("approve")}
          type="button"
        >
          Approve proof
        </button>
        <button
          className="button review-reject"
          disabled={submitting}
          onClick={() => void submit("reject")}
          type="button"
        >
          Reject · contributor retry
        </button>
        <button
          className="button"
          disabled={submitting}
          onClick={() => void submit("manual_retry")}
          type="button"
        >
          Technical retry
        </button>
      </div>
      <p className="review-help">
        Approve passes the current SHA. Reject requests a new contributor proof.
        Technical retry records a neutral system retry.
      </p>
      <div aria-live="polite">
        {state.kind === "submitting" ? (
          <p>Recording append-only decision…</p>
        ) : null}
        {state.kind === "error" ? (
          <p className="error-text">{state.message}</p>
        ) : null}
        {state.kind === "done" ? <p>{state.message}</p> : null}
      </div>
    </section>
  );
}

function readCookie(name: string): string | undefined {
  for (const pair of document.cookie.split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
