"use client";

import QRCode from "qrcode";
import { useState } from "react";

export function ProofHandoff({ attemptId }: { attemptId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; url: string; qr: string; expiresAt: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function create(): Promise<void> {
    setState({ kind: "loading" });
    try {
      const login = await fetch("/api/demo/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "author", attemptId }),
      });
      if (!login.ok)
        throw new Error("The local author session could not be created.");
      const csrf = readCookie("slopproof_csrf");
      if (!csrf) throw new Error("The CSRF credential was not issued.");
      const response = await fetch(`/api/attempts/${attemptId}/handoff`, {
        method: "POST",
        headers: {
          "x-slopproof-csrf": csrf,
          "idempotency-key": `handoff:${crypto.randomUUID()}`,
        },
      });
      const result = (await response.json()) as {
        handoffUrl?: string;
        expiresAt?: string;
        error?: string;
      };
      if (!response.ok || !result.handoffUrl || !result.expiresAt) {
        throw new Error(result.error ?? "The handoff was rejected.");
      }
      const qr = await QRCode.toDataURL(result.handoffUrl, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
        color: { dark: "#171711", light: "#fffdf6" },
      });
      setState({
        kind: "ready",
        url: result.handoffUrl,
        expiresAt: result.expiresAt,
        qr,
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Handoff failed.",
      });
    }
  }

  return (
    <div className="handoff-panel" aria-live="polite">
      {state.kind === "ready" ? (
        <>
          {/* The local data URL contains only the short-lived handoff URL. */}
          <img
            className="qr-code"
            src={state.qr}
            alt="QR code for the mobile proof handoff"
          />
          <div>
            <p className="eyebrow">One-time handoff</p>
            <p>Scan with the phone that will record the explanation.</p>
            <a className="button" href={state.url}>
              Open on this device
            </a>
            <small>
              Expires {new Date(state.expiresAt).toLocaleTimeString()}
            </small>
          </div>
        </>
      ) : (
        <button
          className="button primary"
          disabled={state.kind === "loading"}
          onClick={() => void create()}
          type="button"
        >
          {state.kind === "loading"
            ? "Creating secure handoff…"
            : "Prove your understanding"}
        </button>
      )}
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
