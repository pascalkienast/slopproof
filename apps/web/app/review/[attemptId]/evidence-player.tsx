"use client";

import { useRef, useState } from "react";

type PlayerState =
  | { kind: "idle" }
  | { kind: "ready"; streamUrl: string }
  | { kind: "error"; message: string };

export function EvidencePlayer({
  attemptId,
  markers,
}: {
  attemptId: string;
  markers: { id: string; label: string; timestampMs: number }[];
}) {
  const [state, setState] = useState<PlayerState>({ kind: "idle" });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  function openEvidence(): void {
    setState({
      kind: "ready",
      streamUrl: `/api/review/${attemptId}/evidence?request=${crypto.randomUUID()}`,
    });
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
            autoPlay
            className="review-video"
            controls
            onError={() => {
              setState({
                kind: "error",
                message:
                  "The recording could not be opened. Reload this review and try again.",
              });
            }}
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
          <p className="review-help">The video stays in this tab.</p>
        </>
      ) : (
        <button className="button" onClick={openEvidence} type="button">
          Play the recording
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
