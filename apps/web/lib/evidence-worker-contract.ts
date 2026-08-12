/**
 * Contract expected from the worker without coupling the web app to worker code:
 *
 * GET /internal/review/evidence/:attemptId
 * Authorization: Bearer <EvidenceCapability>
 *
 * The evidence-stream worker verifies the token with WORKER_INTERNAL_SECRET using
 * EvidenceCapabilityPayloadSchema semantics, re-checks attempt/repository/current
 * revision and retention state, consumes the capability JTI once, decrypts only
 * into a response stream, and returns 200 with video/webm. It never redirects and
 * never returns an object-store URL, wrapped key or provider payload.
 *
 * GET /internal/review/context/:attemptId uses a separate one-use capability.
 * It returns only schema-validated transcript segments, selected JPEG frames and
 * structured evaluation findings. The worker decrypts them after rechecking the
 * current review binding; the web never receives the persistent payload key.
 */
export const WORKER_REVIEW_EVIDENCE_PATH = "/internal/review/evidence" as const;
export const WORKER_REVIEW_CONTEXT_PATH = "/internal/review/context" as const;

export const WORKER_EVIDENCE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
] as const;
