# Production configuration and provider capability checks

Stand: 2026-08-12

This runbook describes configuration preparation only. It does not authorize a
deployment, a paid provider call, a GitHub App installation or a cloud-account
change.

## Process boundaries

Production uses `DEPLOYMENT_PROFILE=production`. The configuration loaders fail
closed if the runtime still selects demo mode, a fake adapter, an HTTP public
URL, a loopback public storage endpoint, a placeholder secret or incomplete
provider material.

The compiler creates one fail-closed set of nine artifacts in a new mode-0700
directory:

- `web.env`: OAuth, webhook, session, storage runtime and worker-capability
  configuration; no model keys or private wrapping key;
- `worker.env`: model, transcription, storage runtime and private wrapping-key
  paths; no OAuth, webhook or GitHub App private key;
- `github-control.env`: GitHub App ID and private-key path; no storage or model
  secrets;
- `proxy.env`: only the derived OAuth proxy authenticator;
- `migrate.env`: database access only;
- `github-app.pem` and `wrapping-private.pem`: unchanged copies with mode 0600;
- `wrapping-public.pem`: unchanged copy with mode 0644;
- `postgres-password`: a mode-0600 password-only file derived from and bound
  to the canonical process `DATABASE_URL` values.

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
  header_up X-SlopProof-Client-IP {http.request.remote.host}
  header_up X-SlopProof-Proxy-Authenticator {file./run/credentials/caddy.service/oauth-proxy-authenticator}
}
```

`header_up` set semantics replace all client-supplied values. Do not add a
separate delete for either field: Caddy applies that deletion independently and
would also remove the trusted replacement. The authenticator remains a runtime
systemd-credential file placeholder and is never expanded into Caddy's adapted
configuration.

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

The compiler validates every process value against the strict single-quoted
runtime grammar before writing anything. It then installs one fail-closed set
of nine artifacts:

- five mode-0600 process files: `web.env`, `worker.env`,
  `github-control.env`, `proxy.env` and `migrate.env`;
- `github-app.pem` and `wrapping-private.pem`, both mode 0600;
- the intentionally public `wrapping-public.pem`, mode 0644;
- `postgres-password`, mode 0600, derived by strict parse and percent-decoding
  from the canonical
  `postgres://slopproof:<password>@postgres:5432/slopproof` URL.

The command reports counts only and never prints values. It requires a new,
empty directory and cannot overwrite or rotate existing production material.
Predictable conflicts are checked before the first write; each write is
same-directory atomic, and an unexpected mid-set failure triggers bounded
cleanup of only the exact files created by that invocation. It rejects
symlinks, unsafe modes, a GitHub RSA key below 2048 bits, a wrapping keypair
other than matching RSA-3072 material, or unexpected `/run/secrets/*`
destinations. New deployments supply bucket-scoped credentials through
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The original hosted deployment's
`CLOUDFLARE_R2_AK` plus `CLOUDFLARE_R2_API` compiler input remains available as
a backward-compatible source; new deployments should not adopt that alias.

Production accepts provider-neutral S3 endpoints when both use HTTPS, have a
root path and contain no user info, explicit port, query or fragment. Control
and browser endpoints may differ. Region and bucket names use bounded S3-safe
syntax. Provider-specific CORS, lifecycle and path-style behavior still require
an operator test before accepting evidence.

On the deployment host, keep the artifacts root-owned. Grant uid 1000 a
read-only ACL only for each service's process file and required PEMs; grant uid
70 a read-only ACL only for `postgres-password`. The compiler binds the
password file to every process `DATABASE_URL`, so operators must not copy or
print a password separately.

The GitHub App key reader accepts only the runtime-enforceable projection of
the resulting private-file shapes. A root-owned `0600` key may be exposed to
container uid 1000 with one named, read-only ACL; the ACL mask appears as mode
`0640` inside the container. The reader first opens with `O_NOFOLLOW`, then
requires a regular bounded file, `root:root` ownership, an unprivileged process
outside group 0, no special, execute, write-group or world bits, and that exact
read-mask bit. It therefore does not broadly accept ordinary group-readable
private keys. Locally, a mode-`0600` key owned by the effective process uid
remains valid.

POSIX stat metadata cannot enumerate named ACL entries. The host preflight must
therefore additionally verify, without reading file contents, that each uid
1000 private file's `getfacl -cp` entries are exactly `user::rw-`,
`user:1000:r--`, `group::---`, `mask::r--`, `other::---`, with no additional
named users or groups. Compose drops all capabilities, and uid 1000 is not a
member of group 0; a successfully opened root-owned `0640` mount then proves
that the named ACL is the process's access path.

Before installing the result, validate presence and modes by filename only.
Never run `cat`, `head`, `env`, `set`, `printenv` or a shell trace in the loaded
environment. Gate 7 must mount only the process-specific result and the exact
key files. It must not place values in Compose YAML, image layers or build
arguments.

## Generation and judge providers

Production generation and the multimodal judge may be compiled as either:

- `hetzner` only, using `GENERATION_*` / `JUDGE_*` against one inference URL;
- `openrouter` primary plus a separate Hetzner transport fallback.

`JUDGE_FALLBACK_MODEL` remains the same-URL vision model for the primary
judge client. It is not the Hetzner hop. The hop uses
`GENERATION_FALLBACK_*` and `JUDGE_TRANSPORT_FALLBACK_*` so the compiler
cannot point one Hetzner client at OpenRouter and lose a real fallback.
Hetzner is used only after timeout, 5xx, network, unavailable, or
rate-limit failures. Invalid model output stays on the provider that
produced it. Persisted provider/model metadata names the provider that
answered. Transcription stays OpenRouter Whisper.

The canonical OpenRouter configuration uses MiMo for Learning, Practice, Proof
questions and both judge slots. Semantic generation keeps a bounded
16,000-token completion budget; the judge keeps 6,000. Both paths disable model
reasoning, exclude reasoning deltas, require an endpoint that supports every
requested parameter, and request denied data collection plus
zero-data-retention routing. Larger output budgets are not availability
controls: reasoning-capable endpoints can otherwise consume the budget without
producing bounded JSON. Semantic generation may make one content-free repair
attempt. Truncation, malformed output, oversized responses, stream failure,
idle timeout and absolute deadline remain distinct safe failure classes.

Before frames are loaded or a judge provider is called, the Worker requires at
least one non-empty question-bound transcript segment for every stored proof
question. Missing question evidence is projected deterministically to
`review_required`; patch anchors are never treated as evidence that the
contributor explained or understood the change.

## Provider capability checks

The following scripts make real, potentially billable requests and therefore
refuse to run unless the operator explicitly sets `LIVE_SMOKE=1`:

```bash
LIVE_SMOKE=1 node scripts/live-smoke-hetzner-text-json.mjs
LIVE_SMOKE=1 node scripts/live-smoke-hetzner-vision.mjs
LIVE_SMOKE=1 node scripts/live-smoke-openrouter-stt.mjs
LIVE_SMOKE=1 node scripts/live-smoke-openrouter-mimo.mjs
LIVE_SMOKE=1 pnpm smoke:openrouter-semantic
```

They use only the canonical provider variables already loaded in the shell.
Each check has bounded fixtures, request and overall deadlines, bounded response
bodies, at most three transport attempts, and retry only for rate limits,
server failures, network failures or timeouts. Hetzner checks disable tools and
request `store=false`; the OpenRouter MiMo check uses the streamed generation
wire (`stream=true`, `Accept: text/event-stream`, `response_format.json_schema`)
and `store=false`, and does not hop to Hetzner; OpenRouter STT receives a
one-second in-memory WAV and also gets `store=false`. Output is limited to a
provider name and a safe pass/failure class; model responses and provider error
bodies are never logged.

Contract tests are non-networked:

```bash
pnpm test:live-smoke-contracts
```

The compact capability scripts prove only that the configured endpoint can
satisfy their small transport/schema fixtures. The semantic MiMo smoke is the
stronger pre-deploy gate: it uses the production context builder and generation
service with a 90–180 KiB, 30-anchor synthetic patch; requires three consecutive
first-attempt Learning, Proof-question and Practice-feedback successes; forbids
a Hetzner hop; and never prints generated content. It still does not prove
production semantic quality, provider privacy terms, zero-data-retention
enforcement or the complete video-proof pipeline.

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

GitHub Control exposes only a value-free `GET /healthz` response on its
container-only `0.0.0.0:4002` listener. Production Web accepts only the exact
`http://github-control:4002/healthz` destination and includes its exact,
bounded JSON response in public readiness. Compose additionally marks GitHub
Control unhealthy from a loopback probe and gates Web startup on that health;
no GitHub Control port is published on the host.

These local contracts do not prove that the real GitHub App is installed on a
suitable repository. Gate 10 performs that read-only discovery and the live PR
smoke; it must not create a repository or install the App without explicit
operator approval.

## Rotation rule

Do not regenerate or overwrite the existing one-time secrets or RSA keypair as
part of ordinary deployment. Rotation requires a separately planned,
versioned, atomic transition with old-key read compatibility until all evidence
encrypted under the old wrapping key has expired or been deleted.
