<p align="center">
  <img src="slopproof-mark.svg" width="112" alt="SlopProof mark">
</p>

# SlopProof

**Prove you know what you ship.**

SlopProof is a self-hosted GitHub App. Before a pull request merges, the
author explains the current patch on live video. It does not try to detect
AI-generated code or guess how the patch was written.

[![CI](https://github.com/pascalkienast/slopproof/actions/workflows/ci.yml/badge.svg)](https://github.com/pascalkienast/slopproof/actions/workflows/ci.yml)
[![Supply chain](https://github.com/pascalkienast/slopproof/actions/workflows/supply-chain.yml/badge.svg)](https://github.com/pascalkienast/slopproof/actions/workflows/supply-chain.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or-later-663399.svg)](LICENSE)

The hosted app is [slopproof.paskie.me](https://slopproof.paskie.me). `GET /`
is the static marketing page. `/demo`, `/revisions`, `/m`, and `/review` are
the product.

## How it works

1. The GitHub App receives a pull-request event and binds a check to that head
   SHA.
2. **Practice** is optional. You can study patch-bound learning goals and
   private coaching. Practice never counts as the proof.
3. **Proof** opens on a phone through a one-time QR link. You answer a
   risk-adjusted set of patch questions in one continuous recording. The
   recording tab has to stay in the foreground. Switch to another app, a
   second screen, the lock screen, or another tab, and the take aborts as
   `visibility_lost`. That is the help/no-help guarantee. You cannot read
   notes on a second screen while the take runs.
4. The browser encrypts each recording chunk before upload. The object store
   gets ciphertext only.
5. A worker builds a bounded transcript and a few frames. A multimodal model
   compares those with the patch and rubric.
6. A maintainer can review the take and the model finding.
7. A new push invalidates the attempt. Evidence lasts at most 24 hours, and
   may be deleted as soon as a maintainer accepts it.

SlopProof does not run pull-request code. It does not do face recognition,
gaze tracking, room scanning, identity verification, or persistent contributor
scoring.

## Product tour

These are captures from the hosted production flow. They are not the local
`/demo` route or concept artwork. Repository identifiers are public; private
video areas and the bound SHA are blurred where needed.

![Production contributor proof page with separate Practice and Proof choices](docs/assets/product-flow/contributor-proof.webp)

### Learn the patch

Practice maps the current diff and keeps its coaching prompts separate from the
immutable live questions.

![Production Practice page with the patch map beside the understanding coach](docs/assets/product-flow/practice.webp)

### Say it live

The phone shows one patch-bound question at a time. The recording is one
continuous take.

<p align="center">
  <img src="docs/assets/product-flow/one-take.webp" width="360" alt="Production mobile one-take proof with a patch reference and live question">
  <img src="docs/assets/product-flow/privacy-check.webp" width="288" alt="Production camera and privacy preflight with the camera viewport blurred">
</p>

### Review the evidence

If the model cannot support a pass, the required check waits. An authorized
maintainer can open the short-lived evidence and decide what happens next.

<p align="center">
  <img src="docs/assets/product-flow/review-evidence.webp" width="360" alt="Production maintainer review with the evidence video blurred">
</p>

## See it

- Live landing: [slopproof.paskie.me](https://slopproof.paskie.me)
- Local demo: <http://localhost:3000/demo> after `docker compose up --build`
- Production screenshot provenance and privacy notes:
  [docs/assets/](docs/assets/README.md)

## Local demo

The reference demo needs Docker with Compose:

```bash
docker compose up --build
```

Open <http://localhost:3000/demo>. The stack creates three synthetic pull
requests and uses local fake adapters for GitHub, generation, transcription,
and multimodal evaluation. Demo ports bind to `127.0.0.1` by default. Do not
expose `DEMO_MODE=true` to a network.

For development without the application containers, install Node.js 24 and
pnpm 10.8:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:keys
pnpm verify
```

PostgreSQL integration tests also need `TEST_DATABASE_URL`. Playwright needs a
migrated and seeded database. The CI workflow records the order.

## Production shape

A production deployment needs:

- a GitHub App with the permissions and webhook events listed in the
  [self-hosting guide](docs/operations/self-hosting.md);
- PostgreSQL 18 with `pg-boss` in the same database;
- private S3-compatible object storage with browser CORS and a lifecycle
  backstop;
- an HTTPS reverse proxy that serves the static `landing/` payload at `/`;
- a transcription provider and a multimodal model provider;
- a local RSA wrapping key pair or a compatible KMS adapter;
- separate Web, Worker, GitHub Control, and migration processes.

`DEPLOYMENT_PROFILE=production` rejects demo adapters, loopback or public HTTP
endpoints, placeholder secrets, and incomplete provider configuration. The
checked-in automation under `scripts/production-*` is the maintainer's current
hardened profile. There is no one-command installer.

SlopProof is pre-1.0. The hosted flow has run against a real pull request:
Practice, encrypted phone recording, provider processing, maintainer review,
check completion, retention, backup, and restart. Config and migrations can
still change before a stable release.

## Security and privacy

SlopProof handles video evidence and repository content. Read these before you
run it for other people:

- [Threat model](docs/security/threat-model.md)
- [Provider data flow](docs/privacy/provider-data-flow.md)
- [Recording cryptography](docs/recording-crypto-v1.md)
- [Production configuration](docs/operations/production-configuration.md)
- [Incident response](docs/security/incident-response.md)
- [Security reporting](SECURITY.md)

Provider terms, lawful basis, retention notices, and data-processing agreements
stay with the operator. The controls in this repository do not prove a third
party's retention or training policy.

## Repository map

- `landing/`: static marketing page at `GET /` (`index.html` plus `landing.js`)
- `apps/web`: contributor, mobile, and maintainer interfaces plus HTTP routes
- `apps/worker`: queues, private media processing, providers, and retention
- `apps/github-control`: installation-token and GitHub reconciliation process
- `packages/domain`, `packages/db`, `packages/policy`: state machine, database
  constraints, and review policy
- `packages/media`, `packages/storage`: encrypted recording protocol and S3
  transport
- `packages/analysis`, `packages/questions`, `packages/providers`: bounded patch
  analysis, planning, and provider adapters
- `docs`: security, privacy, and operations
- `scripts`: verification, release, backup, and deployment tooling

[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) records what is
implemented. Older product and interface notes stay in the numbered design
documents and `archive/`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security
reports go through GitHub's private vulnerability-reporting flow, not public
issues. Support routes are in [SUPPORT.md](SUPPORT.md).

The project is maintained by [Pascal Kienast](https://github.com/pascalkienast).

## License

Copyright © 2026 Pascal Kienast and contributors. SlopProof is licensed under
the [GNU Affero General Public License, version 3 or later](LICENSE). If you
run a modified SlopProof service over a network, the license requires you to
offer its corresponding source code to the users of that service.
