# Privacy and external provider data flow

Stand: 2026-08-13

This document describes implemented technical minimization. It is not a claim
that a third-party provider has contractually guaranteed zero-data retention.
Operators must verify current terms, region, subprocessors and account settings
before enabling production.

| Recipient         | Sent                                                                                                                                                                                                    | Explicitly not sent                                                                                                                                  | Persistence in SlopProof                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GitHub            | App/OAuth protocol data, repository/PR identity, bounded patch and exact tree metadata, public Check state                                                                                              | Evidence, transcript, frames, answers, provider reasoning                                                                                            | Installation/repository/PR/revision metadata and content-free check intent                          |
| Cloudflare R2     | Browser-encrypted recording objects and Worker-encrypted frame derivatives                                                                                                                              | Plaintext recording, transcript, model output, RSA private key                                                                                       | Private bucket until canonical `delete_after`; application deletion plus storage lifecycle backstop |
| OpenRouter STT    | One bounded per-question mono 16-kHz WAV after Worker-only decryption                                                                                                                                   | Full video, other answers, patch, repository, author identity, public object URL                                                                     | Only encrypted question-bound transcript is stored by SlopProof                                     |
| Hetzner inference | For generation: bounded untrusted patch context. For Judge: exact head SHA, stored questions/rubrics, bounded anchors, question-bound transcript, timing and at most four inline normalized JPEG frames | Full video, public Evidence URL, GitHub/OAuth identity, face/person metadata, room/accent/disability/tool-analysis fields, Practice answers in Proof | Learning/Practice/Judge artifacts are encrypted worker-only; the public Check has none              |

Provider calls disable tools and request `store=false` where the endpoint
supports it. Requests and responses have absolute deadlines and byte caps;
transport retry is limited to rate limit, server, network and timeout classes.
Raw provider bodies and errors are never logged.

## Retention and access

- Repository policy selects 1–24 hours; the default is 24 hours and successful
  maintainer approval accelerates deletion by default.
- The database stores one canonical `delete_after`. Every private pipeline stage
  rechecks it and current repository authorization before decrypting or calling
  a provider.
- Retention deletes R2 recording/frame objects, aborts orphan multiparts and
  shreds wrapped keys, manifests, intervals, transcripts, semantic artifacts,
  compatibility evaluations and authoritative multimodal sidecars.
- Maintainer review uses a short-lived one-use repository-bound capability and
  returns `Cache-Control: private, no-store`.
- Backups remain sensitive because encrypted content and repository metadata
  are linkable; see the backup runbook.

## Operator obligations

Document the lawful basis, privacy notice, geographic configuration, data
processing agreements, retention policy and subject-request process for the
actual deployment. Disable a provider if its account/terms cannot meet the
deployment's requirements; the product safely falls back to manual review for
Judge unavailability, but live transcription still needs an approved provider.
