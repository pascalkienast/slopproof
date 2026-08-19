"use client";

import { MAX_RECORDING_OBJECT_BYTES } from "@slopproof/media";
import { useEffect, useRef, useState } from "react";

type PlayerState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; streamUrl: string; expiresAt: string }
  | { kind: "error"; message: string };

export function EvidencePlayer({
  attemptId,
  markers,
}: {
  attemptId: string;
  markers: { id: string; label: string; timestampMs: number }[];
}) {
  const [state, setState] = useState<PlayerState>({ kind: "idle" });
  const objectUrlRef = useRef<string | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function openEvidence(): Promise<void> {
    const csrf = readCookie("slopproof_csrf");
    if (!csrf) {
      setState({ kind: "error", message: "The CSRF credential is missing." });
      return;
    }
    setState({ kind: "loading" });
    try {
      const response = await fetch(
        `/api/review/${attemptId}/evidence-capability`,
        { method: "POST", headers: { "x-slopproof-csrf": csrf } },
      );
      const result = (await response.json().catch(() => null)) as {
        streamUrl?: string;
        expiresAt?: string;
        error?: string;
      } | null;
      if (!response.ok || !result?.streamUrl || !result.expiresAt) {
        throw new Error(result?.error ?? "Evidence access was rejected.");
      }
      const stream = await fetch(result.streamUrl, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      const contentType = stream.headers.get("content-type")?.toLowerCase();
      const contentLength = Number(stream.headers.get("content-length"));
      if (
        !stream.ok ||
        !contentType?.startsWith("video/webm") ||
        !Number.isSafeInteger(contentLength) ||
        contentLength <= 0 ||
        contentLength > MAX_RECORDING_OBJECT_BYTES
      ) {
        throw new Error("The evidence stream was rejected.");
      }
      const blob = await stream.blob();
      if (blob.size !== contentLength) {
        throw new Error("The evidence stream ended before its declared size.");
      }
      const objectUrl = URL.createObjectURL(blob);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = objectUrl;
      setState({
        kind: "ready",
        streamUrl: objectUrl,
        expiresAt: result.expiresAt,
      });
    } catch {
      setState({
        kind: "error",
        message:
          "The video is not available. Request fresh access and try again.",
      });
    }
  }

  return (
    <section className="evidence-card" aria-labelledby="evidence-heading">
      <div className="check-header">
        <div>
          <p className="eyebrow">Video</p>
          <h2 id="evidence-heading">Watch the proof</h2>
        </div>
      </div>
      {state.kind === "ready" ? (
        <>
          <video
            className="review-video"
            controls
            playsInline
            preload="none"
            ref={videoRef}
            src={state.streamUrl}
          >
            Your browser cannot play this WebM recording.
          </video>
          {markers.length > 0 ? (
            <div className="evidence-markers" aria-label="Question timestamps">
              {markers.map((marker) => (
                <button
                  key={marker.id}
                  onClick={() => {
                    if (videoRef.current) {
                      videoRef.current.currentTime = marker.timestampMs / 1_000;
                      videoRef.current.focus();
                    }
                  }}
                  type="button"
                >
                  {formatTimestamp(marker.timestampMs)} · {marker.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="review-help">
            Access expires at {new Date(state.expiresAt).toLocaleTimeString()}.
            The video stays in this tab.
          </p>
        </>
      ) : (
        <button
          className="button"
          disabled={state.kind === "loading"}
          onClick={() => void openEvidence()}
          type="button"
        >
          {state.kind === "loading" ? "Opening…" : "Play the recording"}
        </button>
      )}
      {state.kind === "error" ? (
        <p className="error-text">{state.message}</p>
      ) : null}
    </section>
  );
}

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function readCookie(name: string): string | undefined {
  for (const pair of document.cookie.split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (rawName === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
