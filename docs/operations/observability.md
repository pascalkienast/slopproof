# Evidence-free observability

Stand: 2026-08-13

Operational signals are deliberately low-cardinality and content-free.

Allowed dimensions:

- fixed service and approved queue/job name;
- coarse outcome such as `ready`, `retry`, `failed`, `shredded` or
  `review_required`;
- bounded latency bucket and integer count;
- process build version.

Forbidden dimensions and values:

- repository/installation/PR/revision/attempt/question/evaluation IDs;
- Git SHA, author, login, IP, session, capability or request ID;
- paths originating from a PR, question/rubric text, answer, transcript, frame,
  media metadata or provider payload/error body;
- object keys, presigned URLs, secret/key names or secret-derived hashes;
- arbitrary provider model output or exception messages.

Structured `evaluation.run` and `evidence.stream` info logs may include attemptId plus content-free enums (stage, hopUsed, httpStatus, byte counts); those fields are diagnostic, not metric dimensions.

The value-free `/api/health/live` answers only process liveness.
`/api/health/ready` performs bounded DB, pg-boss and S3 `HeadBucket` capability
checks and returns only `ready` or `unavailable`; it never lists, reads or writes
Evidence. Metrics endpoints must remain on the internal Worker boundary and use
the existing authenticated internal request contract. Caddy does not proxy
them publicly.

Alert on sustained readiness failure, queue retry/failed growth, provider
fallback/unavailable growth, overdue retention, physical-delete failure and
check-reconciliation backlog. An alert should link to a runbook and deployment
version, never an Evidence object or user identity.

The one-hour provider window contains two distinct signal families. Semantic
generation exposes fixed purpose/outcome counts and cumulative latency buckets
from its content-free invocation metadata. The private media pipelines expose
only `artifact_persisted` counts for the fixed `speech_to_text` and
`multimodal_judge` stages. In production these count persisted OpenRouter
transcripts and persisted Hetzner multimodal sidecars respectively. They do not
decrypt either artifact, identify a model or claim an upstream success/latency
that the current cleartext schema cannot prove. In particular, a persisted
multimodal sidecar can contain a fail-closed manual-review fallback. Correlate a
stalled persistence count only with the matching fixed queue signal
(`media.extract-transcript` or `proof.evaluate`); do not infer a provider error
from either signal alone.
