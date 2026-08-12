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

The compiler creates five mode-0600 environment files and three validated key
files in a new mode-0700 directory:

- `web.env`: OAuth, webhook, session, storage runtime and worker-capability
  configuration; no model keys or private wrapping key;
- `worker.env`: model, transcription, storage runtime and private wrapping-key
  paths; no OAuth, webhook or GitHub App private key;
- `github-control.env`: GitHub App ID and private-key path; no storage or model
  secrets;
- `proxy.env`: only the derived OAuth proxy authenticator;
- `migrate.env`: database access only;
- `github-app.pem` and `wrapping-private.pem`: unchanged copies with mode 0600;
- `wrapping-public.pem`: unchanged copy with mode 0644.

The web receives only the public RSA wrapping-key mount, the media worker only
the private wrapping-key mount, and GitHub Control only the GitHub App PEM. The
general Mac secret file is input to the local compiler and must never be copied
as a whole to a host or container.

The compiler also derives `OAUTH_TRUSTED_PROXY_SECRET` with a domain-separated
HMAC from the existing `WORKER_INTERNAL_SECRET`; it does not require another
operator-managed secret. The generated `proxy.env` carries only that derived
value. Install it in stock Caddy and install the same value through `web.env` in
the web process. Caddy must overwrite the private headers; it must never pass a
client-supplied value through:

```caddyfile
reverse_proxy 127.0.0.1:3000 {
  header_up -X-SlopProof-Client-IP
  header_up -X-SlopProof-Proxy-Authenticator
  header_up X-SlopProof-Client-IP {remote_host}
  header_up X-SlopProof-Proxy-Authenticator {$OAUTH_TRUSTED_PROXY_SECRET}
}
```

The web compares the authenticator in constant time and derives only a keyed
hash of the canonical transport address for rate-limit storage. It never trusts
`Forwarded` or `X-Forwarded-For`. A direct request without the proxy
authenticator fails closed in production. Bind the web listener to loopback (or
an equivalently private proxy-only network); the static authenticator proves the
proxy boundary, not the identity of an arbitrary public client.

Production OAuth start additionally requires same-origin Fetch Metadata. Before
creating OAuth state, PostgreSQL atomically enforces four starts per client and
600 starts globally per rolling five minutes. Stored client keys are HMACs, not
raw addresses. Rows expire after ten minutes and each request deletes at most
500 expired rows.

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

## GitHub control boundary

GitHub network effects run only in the dedicated `github-control` process. It
receives the App ID and private-key file, but no provider, storage, OAuth-client
or media-decryption secret. The web process verifies bounded raw webhook bodies
and writes delivery plus pg-boss outbox state atomically; it never calls GitHub
inside the request transaction. The media worker writes only desired public
Check intents into PostgreSQL and has no GitHub credential.

Before accepting work, GitHub Control validates the local private-key file. App
JWTs and repository-scoped installation tokens are short-lived and memory-only.
PR reads are capped and double-checked for stable head, base, state and identity;
no clone or checkout occurs. Check writes re-read current head, base and PR state
immediately before the single remote write. Ambiguous writes are recovered by a
bounded lookup on exact check name, revision external ID and head SHA.

Webhook deliveries, Check intents, PR refreshes and installation recovery use
database leases plus durable retry deadlines. GitHub `Retry-After` is respected;
secondary-limit responses without that header wait at least 60 seconds. App and
repository lifecycle events never reactivate access on event data alone. A
fresh repository-scoped read and exact database fence must win before a binding
can become active again.

These local contracts do not prove that the real GitHub App is installed on a
suitable repository. Gate 10 performs that read-only discovery and the live PR
smoke; it must not create a repository or install the App without explicit
operator approval.

## Rotation rule

Do not regenerate or overwrite the existing one-time secrets or RSA keypair as
part of ordinary deployment. Rotation requires a separately planned,
versioned, atomic transition with old-key read compatibility until all evidence
encrypted under the old wrapping key has expired or been deleted.
