# Production threat model

Stand: 2026-08-24

## Security objectives

1. A public check reveals state and current-SHA binding, never Evidence,
   transcript, answers, frames, provider reasoning or private identity data.
2. Only the PR author can create/use the bound contributor flow; only a freshly
   authorized repository maintainer can access private review or decide.
3. A push, close, repository removal, installation suspension or retention
   expiry prevents further private processing and remote effects.
4. Browser media is authenticated ciphertext before persistent storage.
   Plaintext exists only in bounded memory in the device or Worker.
5. Models are untrusted assistants. They cannot alter SHA, policy, question
   budget, anchor set or public outcome, and V1 always ends in maintainer review.

## Assets and trust boundaries

- GitHub identity, installation binding, webhook secret and App key;
- session, CSRF, OAuth state/PKCE and one-use action capabilities;
- repository policy, immutable revision/source/context, questions and anchors;
- browser data-encryption key, wrapping keys, ciphertext objects and retention
  deadline;
- decrypted audio/frames/transcript and encrypted semantic/judge sidecars;
- PostgreSQL, pg-boss, backups, logs and deployment secrets;
- external boundaries: GitHub, Cloudflare R2, Hetzner inference, OpenRouter
  inference/STT, host Caddy, Docker and the operator workstation.

## Principal threats and controls

| Threat                           | Primary controls                                                                                                                                                         | Residual risk                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Forged webhook or OAuth callback | Raw-body HMAC, exact event schemas, PKCE/state, one-time DB state, proxy-authenticated client IP                                                                         | GitHub/operator credential compromise                                                 |
| Stale SHA or lifecycle race      | Current revision locks, PR/repo/install active fences before and after private effects, durable invalidation                                                             | External event delay before next authoritative read                                   |
| Replay/crash duplicates          | Immutable hashes, exact replay comparison, transactional pg-boss upsert/heal, sweepers                                                                                   | Provider may have accepted a request before a network ambiguity; outcome stays manual |
| Evidence disclosure from storage | Browser AEAD, worker-only RSA unwrap, strict object keys/AAD/hash, R2 private bucket                                                                                     | Worker host/private key compromise                                                    |
| Prompt injection/model overreach | Untrusted wrappers, strict IDs/anchors/codes, bounded provider material, no tools, one repair, complete per-question transcript preflight, deterministic/manual fallback | Provider sees the minimal material required for its task                              |
| Biometric/person/tool inference  | Provider input excludes identity metadata; structured output has no free person-analysis field; forbidden semantics fail closed                                          | Visual frames inherently depict the contributor and surroundings                      |
| DoS and cost exhaustion          | Body/media/provider byte caps, duration/question caps, durable HMAC quotas, deadlines, retries, CPU/RAM/PID limits                                                       | Distributed traffic and upstream provider outage still require operator response      |
| Log/metric leakage               | Allowlisted value-free fields, Pino redaction, Caddy query/header/IP filters, no payload metrics                                                                         | Operator debug changes can reintroduce leakage and require review                     |
| Supply-chain compromise          | Frozen lockfile, boundary/secret audit, SBOM, dependency review, image vulnerability scan, non-root/read-only runtime                                                    | CI/action and base-image trust; actions are commit-pinned                             |
| Database/backup theft            | Provider/evidence payload encryption, protected DB network and encrypted backup handling                                                                                 | Repository metadata and access patterns remain sensitive                              |

## Explicit non-goals

- Detecting whether code was written with AI.
- Biometric identification, gaze tracking, disability/accent inference or room
  surveillance.
- Executing untrusted PR code.
- Claiming third-party zero-data retention that has not been contractually and
  operationally verified.
- Protecting evidence after the Worker host and active private keys are both
  fully compromised.

Every new provider field, metric label, public route or runtime secret must be
reviewed against this model. A test-green implementation is not proof of live
provider privacy, real GitHub interoperability or host hardening.
