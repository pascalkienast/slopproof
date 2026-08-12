"use client";

import { useState } from "react";

export function RetryAttempt({
  attemptId,
  headSha,
  establishDemoSession = false,
}: {
  attemptId: string;
  headSha: string;
  establishDemoSession?: boolean;
}) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function retry(): Promise<void> {
    setState({ kind: "loading" });
    try {
      if (establishDemoSession) {
        const login = await fetch("/api/demo/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "author", attemptId }),
        });
        if (!login.ok)
          throw new Error("The local author session could not be created.");
      }
      const csrf = readCookie("slopproof_csrf");
      if (!csrf) throw new Error("The CSRF credential was not issued.");
      const response = await fetch(`/api/attempts/${attemptId}/retry`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slopproof-csrf": csrf,
          "idempotency-key": `retry:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ expectedHeadSha: headSha }),
      });
      const result = (await response.json()) as {
        contributorUrl?: string;
        error?: string;
      };
      if (!response.ok || !result.contributorUrl) {
        throw new Error(result.error ?? "The technical retry was rejected.");
      }
      window.location.assign(result.contributorUrl);
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The retry could not be created.",
      });
    }
  }

  return (
    <div className="handoff-panel" aria-live="polite">
      <button
        className="button primary"
        disabled={state.kind === "loading"}
        onClick={() => void retry()}
        type="button"
      >
        {state.kind === "loading"
          ? "Creating retry…"
          : "Create a fresh attempt"}
      </button>
      {state.kind === "error" ? (
        <p className="error-text">{state.message}</p>
      ) : null}
    </div>
  );
}

function readCookie(name: string): string | undefined {
  for (const pair of document.cookie.split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
