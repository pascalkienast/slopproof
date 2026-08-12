# Production configuration and provider capability checks

Stand: 2026-08-12

This runbook describes configuration preparation only. It does not authorize a
deployment, a paid provider call, a GitHub App installation or a Cloudflare
management operation.

## Process boundaries

Production uses `DEPLOYMENT_PROFILE=production`. The configuration loaders fail
closed if the runtime still selects demo mode, a fake adapter, an HTTP public
URL, a loopback public storage endpoint, a placeholder secret or incomplete
provider material.

The compiler creates four mode-0600 environment files and three validated key
files in a new mode-0700 directory:

- `web.env`: OAuth, webhook, session, storage runtime and worker-capability
  configuration; no model keys or private wrapping key;
- `worker.env`: model, transcription, storage runtime and private wrapping-key
  paths; no OAuth, webhook or GitHub App private key;
- `github-control.env`: GitHub App ID and private-key path; no storage or model
  secrets;
- `migrate.env`: database access only.
- `github-app.pem` and `wrapping-private.pem`: unchanged copies with mode 0600;
- `wrapping-public.pem`: unchanged copy with mode 0644.

The web receives only the public RSA wrapping-key mount, the media worker only
the private wrapping-key mount, and GitHub Control only the GitHub App PEM. The
general Mac secret file is input to the local compiler and must never be copied
as a whole to a host or container.

## Compile without exposing values

Create an empty directory with mode 0700, load the existing canonical Mac
environment and compile into that directory. The directory must be outside the
repository; the compiler rejects repository-contained targets:

```bash
install -d -m 0700 /absolute/new-output-directory
source "$HOME/.secrets/slopproof.env"
pnpm production:env -- /absolute/new-output-directory
```

The command reports only the number of files. It never prints values and
requires a new, empty directory; it cannot overwrite or rotate existing
production material. It rejects symlinks, unsafe modes, a GitHub RSA key below
2048 bits, a wrapping keypair other than matching RSA-3072 material, or
unexpected `/run/secrets/*` destinations. The R2 S3 access ID is mapped from the existing
bucket-scoped source and the S3 secret is derived locally as specified by the
deployment contract. The historical `CLOUDFLARE_R2_SEC_ACCESSKEY` is never
consumed.

Before installing the result, validate presence and modes by filename only.
Never run `cat`, `head`, `env`, `set`, `printenv` or a shell trace in the loaded
environment. Gate 7 must mount only the process-specific result and the exact
key files. It must not place values in Compose YAML, image layers or build
arguments.

## Provider capability checks

The following scripts make real, potentially billable requests and therefore
refuse to run unless the operator explicitly sets `LIVE_SMOKE=1`:

```bash
LIVE_SMOKE=1 node scripts/live-smoke-hetzner-text-json.mjs
LIVE_SMOKE=1 node scripts/live-smoke-hetzner-vision.mjs
LIVE_SMOKE=1 node scripts/live-smoke-openrouter-stt.mjs
```

They use only the canonical provider variables already loaded in the shell.
Each check has bounded fixtures, request and overall deadlines, bounded response
bodies, at most three transport attempts, and retry only for rate limits,
server failures, network failures or timeouts. Hetzner checks disable tools and
request `store=false`; OpenRouter receives a one-second in-memory WAV and also
gets `store=false`. Output is limited to a provider name and a safe pass/failure
class; model responses and provider error bodies are never logged.

Contract tests are non-networked:

```bash
pnpm test:live-smoke-contracts
```

The capability result proves only that the configured endpoint can satisfy the
small transport/schema fixture. It does not prove production semantic quality,
privacy terms, zero-data-retention enforcement or the complete proof pipeline.

## Rotation rule

Do not regenerate or overwrite the existing one-time secrets or RSA keypair as
part of ordinary deployment. Rotation requires a separately planned,
versioned, atomic transition with old-key read compatibility until all evidence
encrypted under the old wrapping key has expired or been deleted.
