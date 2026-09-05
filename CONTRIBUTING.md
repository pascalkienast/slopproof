# Contributing to UnderstandProof

UnderstandProof accepts bug fixes, tests, documentation and focused feature work.
Open an issue before starting a change that alters the recording protocol,
retention, provider data flow, GitHub permissions, repository policy or public
API.

## Development setup

Install Node.js 24, pnpm 10.8, Docker and Docker Compose.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:keys
docker compose up -d postgres storage
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The full local demo can also run as one Compose stack:

```bash
docker compose up --build
```

Do not use real provider, GitHub or storage credentials in fixtures, screenshots,
issues or pull requests.

## Before opening a pull request

Run the checks that match the change. `pnpm verify` covers the main unit,
contract, build, supply-boundary and secret gates. Database or user-flow changes
also need:

```bash
TEST_DATABASE_URL=postgres://... pnpm test:integration
pnpm test:e2e
pnpm format:check
pnpm audit:history-secrets
```

The CI workflow uses a clean database and installs Chromium for Playwright.

## Pull-request rules

- Keep the patch narrow. Explain the behavior, failure mode and tests.
- Add a migration for every schema change. Do not edit an applied migration.
- Validate external input with Zod and preserve idempotency at every queue or
  webhook boundary.
- Keep evidence, transcripts, answers, provider payloads and private rationale
  out of public checks and logs.
- Treat patch text, model output and GitHub data as untrusted input.
- Do not add PR-code execution, biometric analysis or contributor scoring under
  a generic feature flag. Those changes require a separate threat model.
- Update the threat model and provider data-flow document when a trust boundary
  changes.
- Do not weaken retention or authorization tests to make a feature pass.

By submitting a contribution, you confirm that you have the right to license it
under `Apache-2.0`, the repository's license.

## Review

Maintainers may ask for a smaller patch, a failure-injection test, database race
coverage or a privacy review. A green model-generated result is not a substitute
for maintainer review.

Please follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in all project spaces.
