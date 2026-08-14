# Implementation status

Last updated: 2026-08-14

SlopProof is a working pre-1.0 system. The hosted deployment at
<https://slopproof.paskie.me> has completed the full GitHub flow against a real
pull request:

1. GitHub App installation, webhook ingestion and SHA-bound Check creation;
2. GitHub OAuth for contributor and maintainer access;
3. generated patch-bound Practice and private coaching;
4. QR handoff to a physical phone;
5. browser encryption, multipart object upload and worker-only decryption;
6. per-question transcription, bounded frame selection and multimodal review;
7. maintainer approval and a successful GitHub Check on the current head SHA;
8. early evidence deletion and retention processing;
9. encrypted database backup, isolated restore rehearsal, deployment finalize
   and a real service restart.

The production release verified on 2026-08-14 passed its full release gate.
The current open-source-readiness branch passes 690 unit/contract tests, 106
PostgreSQL integration tests and five Playwright product flows, plus strict TypeScript,
ESLint, format, package-boundary and secret audits, a production-image contract,
0 HIGH/CRITICAL findings in the release Trivy policy and an SPDX SBOM containing
362 packages.

## Open-source readiness

The `release/open-source-readiness` branch now contains the public README,
self-hosting guide, contributor and security policies, issue forms, pull-request
template, governance, support, CODEOWNERS, Dependabot configuration and a
dogfooding runbook. CI actions and service images are immutable-pinned. The CI
golden path starts PostgreSQL, private S3-compatible test storage, Worker and
GitHub Control before exercising the signed-webhook browser flow.

The working tree and reachable history passed generic and exact-value secret
audits with the hosted operator environment loaded. Documentation links,
workflow syntax, dependency advisories, production dependency licenses and
large historical blobs were also reviewed. No GitHub repository or public
remote has been created from this branch. The remaining legal gate is the
project license; publication remains a separate maintainer action after that
choice.

## Current guarantees

- Every attempt binds to one installation, repository, pull request, author and
  exact head SHA.
- A push invalidates prior evidence and decisions.
- Practice remains private, optional and excluded from Proof evaluation.
- Recording chunks leave the browser as authenticated ciphertext.
- The Worker holds the private wrapping key; Web receives the public key only.
- Provider calls use bounded material, strict schemas, byte limits and absolute
  deadlines.
- Provider output cannot complete the Check. A maintainer decides.
- Public Check output contains no evidence, transcript, answer, frame, score or
  private rationale.
- Evidence retention cannot exceed 24 hours and successful approval may trigger
  immediate deletion.
- SlopProof never executes pull-request code in the current architecture.

## Deployment state

The hosted deployment uses PostgreSQL 18, private Cloudflare R2, Hetzner model
adapters, OpenRouter transcription, Docker Compose and Caddy. It runs separate
Web, Worker, GitHub Control and migration processes with file-backed,
process-scoped secrets.

The checked-in hardened release, backup and Caddy scripts describe that specific
operator profile. The core production configuration now accepts provider-neutral
secure S3 endpoints and canonical S3 credentials, but operators must adapt host,
reverse-proxy, resource and backup automation to their environment.

## Pre-1.0 limitations

- The database schema and deployment compiler may still change between commits.
- The only decision mode is maintainer review. Calibrated auto-pass is not
  implemented.
- Production generation and judge adapters currently target Hetzner-compatible
  APIs; transcription targets the OpenRouter adapter.
- No high-availability topology or multi-region retention proof is provided.
- The hosted service has not yet carried sustained public contributor traffic.
- Public repository dogfooding and the first tagged release remain to be
  completed.

See the [threat model](docs/security/threat-model.md),
[provider data flow](docs/privacy/provider-data-flow.md) and
[self-hosting guide](docs/operations/self-hosting.md) before operating the
service for other people.
