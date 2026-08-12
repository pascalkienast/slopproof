export type UploadFinalizationState = {
  uploadState: string;
  attemptStatus: string;
  uploadExpiresAt: Date;
  storedManifestDigest: string | null;
};

export type UploadFinalizationDisposition = "fresh" | "replay" | "reject";

/**
 * Keeps the HTTP boundary aligned with the transactional DB helper: a retry of
 * an already accepted finalization must reach the helper instead of being
 * rejected by the route's optimistic preflight checks.
 */
export function classifyUploadFinalization(
  state: UploadFinalizationState,
  manifestDigest: string,
  now: Date,
): UploadFinalizationDisposition {
  if (state.uploadExpiresAt <= now) return "reject";
  if (state.uploadState === "active" && state.attemptStatus === "uploading") {
    return "fresh";
  }
  if (
    state.uploadState === "pending_finalization" &&
    state.attemptStatus === "processing" &&
    state.storedManifestDigest === manifestDigest
  ) {
    return "replay";
  }
  return "reject";
}
