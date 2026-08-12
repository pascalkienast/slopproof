"use client";

import { useState } from "react";

export function DemoMaintainerLogin() {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  async function signIn(): Promise<void> {
    setState("loading");
    try {
      const response = await fetch("/api/demo/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "maintainer" }),
      });
      if (!response.ok) throw new Error("Demo sign-in was rejected");
      window.location.reload();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="review-login" aria-live="polite">
      <button
        className="button primary"
        disabled={state === "loading"}
        onClick={() => void signIn()}
        type="button"
      >
        {state === "loading"
          ? "Opening local session…"
          : "Enter as demo maintainer"}
      </button>
      {state === "error" ? (
        <p className="error-text">
          The local maintainer session could not be created.
        </p>
      ) : null}
    </div>
  );
}
