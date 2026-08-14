<p align="center">
  <img src="slopproof-mark.svg" width="112" alt="SlopProof mark">
</p>

# SlopProof

**Prove you know what you ship.**

SlopProof is a self-hosted GitHub App for pull-request accountability. It asks
the contributor to explain the current patch before a maintainer merges it.
SlopProof does not attempt to detect AI-generated code or infer how a patch was
written.

[![CI](https://github.com/pascalkienast/slopproof/actions/workflows/ci.yml/badge.svg)](https://github.com/pascalkienast/slopproof/actions/workflows/ci.yml)
[![Supply chain](https://github.com/pascalkienast/slopproof/actions/workflows/supply-chain.yml/badge.svg)](https://github.com/pascalkienast/slopproof/actions/workflows/supply-chain.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-663399.svg)](LICENSE)

> SlopProof is pre-1.0 software. The complete hosted flow has been exercised
> against a real pull request, including Practice, encrypted mobile recording,
> provider processing, maintainer review, check completion, retention, backup
> and restart. Configuration and migration contracts may still change before
> the first stable release.

## How it works

1. A GitHub App receives a pull-request event and binds a check to the exact
   head SHA.
2. The contributor may open **Practice** to study patch-bound learning goals
   and private coaching. Practice is optional and never affects the proof.
3. **Proof** hands the session to a phone by QR code. The contributor answers a
   risk-adjusted set of patch questions in one continuous recording.
4. The browser encrypts each recording chunk before upload. The object store
   receives ciphertext only.
5. A worker produces a bounded transcript and frame selection. A multimodal
   model compares those artifacts with the patch and rubric.
6. A repository maintainer makes the decision. The model cannot turn the
   GitHub check green by itself.
7. A new push invalidates the attempt. Evidence expires after at most 24 hours
   and may be deleted as soon as the maintainer accepts it.

The MVP does not execute pull-request code. It does not perform face
recognition, gaze tracking, room scanning, identity verification or persistent
contributor scoring.

## Local demo

The reference demo needs Docker with Compose:

```bash
docker compose up --build
```

Open <http://localhost:3000/demo>. The stack creates three synthetic pull
requests and uses local fake adapters for GitHub, generation, transcription and
multimodal evaluation. Demo ports bind to `127.0.0.1` by default. Do not expose
`DEMO_MODE=true` to a network.

For development without the application containers, install Node.js 24 and
pnpm 10.8:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:keys
pnpm verify
```

PostgreSQL integration tests also require `TEST_DATABASE_URL`. Playwright needs
a migrated and seeded database; the CI workflow records the complete order.

## Production shape

A production deployment needs:

- a GitHub App with the permissions and webhook events listed in the
  [self-hosting guide](docs/operations/self-hosting.md);
- PostgreSQL 18 with `pg-boss` in the same database;
- private S3-compatible object storage with browser CORS and a lifecycle
  backstop;
- an HTTPS reverse proxy;
- a transcription provider and a multimodal model provider;
- a local RSA wrapping key pair or a compatible KMS adapter;
- separate Web, Worker, GitHub Control and migration processes.

`DEPLOYMENT_PROFILE=production` rejects demo adapters, loopback/public HTTP
endpoints, placeholder secrets and incomplete provider configuration. The
checked-in production automation under `scripts/production-*` documents the
maintainer's current hardened deployment. It is a reference profile, not a
portable one-command installer.

## Security and privacy

SlopProof handles video evidence and repository content. Read these documents
before operating it for other people:

- [Threat model](docs/security/threat-model.md)
- [Provider data flow](docs/privacy/provider-data-flow.md)
- [Recording cryptography](docs/recording-crypto-v1.md)
- [Production configuration](docs/operations/production-configuration.md)
- [Incident response](docs/security/incident-response.md)
- [Security reporting](SECURITY.md)

Provider terms, lawful basis, retention notices and data-processing agreements
remain the operator's responsibility. The technical controls in this repository
do not prove a third party's retention or training policy.

## Repository map

- `apps/web`: contributor, mobile and maintainer interfaces plus HTTP routes;
- `apps/worker`: queues, private media processing, providers and retention;
- `apps/github-control`: installation-token and GitHub reconciliation process;
- `packages/domain`, `packages/db`, `packages/policy`: state machine, database
  constraints and manual-review policy;
- `packages/media`, `packages/storage`: encrypted recording protocol and S3
  transport;
- `packages/analysis`, `packages/questions`, `packages/providers`: bounded patch
  analysis, planning and provider adapters;
- `docs`: security, privacy and operations material;
- `scripts`: verification, release, backup and deployment tooling.

The implementation record in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)
contains gate-by-gate evidence. Earlier product and interface explorations remain
in the numbered design documents and `archive/` for provenance.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security
reports belong in GitHub's private vulnerability-reporting flow, not in public
issues. General support routes are listed in [SUPPORT.md](SUPPORT.md).

The project is maintained by [Pascal Kienast](https://github.com/pascalkienast).

## License

Copyright © 2026 Pascal Kienast and contributors. SlopProof is licensed under
the [GNU Affero General Public License, version 3 or later](LICENSE). If you run
a modified SlopProof service over a network, the license requires you to offer
its corresponding source code to the users of that service.
