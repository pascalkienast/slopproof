# Project status

UnderstandProof is a working pre-1.0 GitHub App. The hosted service has completed the
full flow against real pull requests, from the GitHub check and optional
Practice through encrypted phone recording, evaluation, review, retention,
backup, and restart.

## Direction

The brand stands for **Proof of Understanding**, independent of who created
an output. The longer-term vision includes texts and other media. The current
implementation supports GitHub pull requests only; this rename does not add
new media inputs or change the evaluation policy.

## Available now

- Every attempt binds to one repository, pull request, author, and exact head
  SHA. A new push invalidates the previous attempt.
- Practice is optional, private, and excluded from Proof evaluation.
- Proof uses one uninterrupted phone recording with patch-bound questions.
- The browser encrypts recording chunks before persistent upload. Private
  evidence never appears in the public GitHub check.
- The worker builds a bounded transcript and frame set for multimodal review.
  A schema-valid result may pass; uncertain or inconsistent evidence routes to
  maintainer review. Retry, expiry, and provider failure stay fail-closed.
- Repository policy limits evidence retention to 24 hours and may delete it
  sooner after completion.

## Reference deployment

The checked-in production profile uses Node.js, TypeScript, PostgreSQL,
pg-boss, private S3-compatible storage, Docker Compose, and Caddy. Web, Worker,
GitHub Control, and database migration run as separate processes with
file-backed secrets.

The repository includes a hardened reference deployment and backup workflow.
Self-hosters still need their own GitHub App, storage, model providers, HTTPS,
retention process, legal basis, and incident procedures.

## Pre-1.0 limits

- Configuration and database migrations may change between commits.
- The reference production topology is single-host and does not provide high
  availability or multi-region recovery.
- Provider outages and invalid model output can require retry or maintainer
  review instead of producing a pass.
- The hosted service has not yet carried sustained public contributor traffic.

Read the [self-hosting guide](operations/self-hosting.md),
[threat model](security/threat-model.md), and
[provider data flow](privacy/provider-data-flow.md) before operating UnderstandProof
for other people.
