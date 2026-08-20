# Self-hosting SlopProof

SlopProof is pre-1.0. Production operation requires a GitHub App, PostgreSQL,
private S3-compatible storage, model providers, HTTPS and a retention process.
The repository does not provide an unattended installer.

## 1. Create the GitHub App

Use these URLs, replacing the origin with `APP_BASE_URL`:

- Homepage: `https://slopproof.example.com`
- Callback: `https://slopproof.example.com/api/auth/github/callback`
- Webhook: `https://slopproof.example.com/api/github/webhooks`

Grant these repository permissions:

- Checks: read and write
- Contents: read-only
- Metadata: read-only
- Pull requests: read and write

Subscribe to `pull_request`, `installation` and `installation_repositories`.
Install the App only on selected repositories during initial testing. SlopProof
mints repository-scoped installation tokens with the same reduced permission
set and never stores those tokens. Pull-request write access is used only to
create or update one App-owned timeline comment containing the current public
SlopProof link. Existing installations must approve this permission increase
before comment synchronization can succeed.

The webhook secret, OAuth client secret and App private key belong in the
operator's secret store. The App key must be a bounded RSA private-key file; do
not paste it into an environment variable.

## 2. Prepare storage

Create one private bucket and bucket-scoped S3 credentials. The control and
browser endpoints must use HTTPS, contain no user info, query, fragment, port or
path, and must not resolve to loopback. They may use different hostnames when
the S3 provider signs browser uploads through a separate origin.

Allow browser `PUT` only from `APP_BASE_URL`, allow `content-type`, expose
`ETag`, and keep the presign maximum at five minutes. Configure a lifecycle
backstop that removes evidence and provider-frame prefixes after the operator's
maximum retention and aborts stale multipart uploads. SlopProof's database
deadline and deletion jobs remain authoritative.

The Cloudflare-specific reference is in
[r2-cors-lifecycle.md](r2-cors-lifecycle.md).

## 3. Generate wrapping keys

The local key adapter needs RSA-3072 material:

```bash
install -d -m 0700 /operator/secrets
openssl genpkey -algorithm RSA \
  -pkeyopt rsa_keygen_bits:3072 \
  -out /operator/secrets/wrapping-private.pem
openssl pkey \
  -in /operator/secrets/wrapping-private.pem \
  -pubout \
  -out /operator/secrets/wrapping-public.pem
chmod 0600 /operator/secrets/wrapping-private.pem
chmod 0644 /operator/secrets/wrapping-public.pem
```

Copy the GitHub App PEM into the same protected source directory with mode
`0600`.

## 4. Compile process secrets

Use [.env.production.example](../../.env.production.example) as an inventory.
Load the real values from an operator-owned secret store, create a new empty
mode-`0700` output directory outside the repository, then run:

```bash
install -d -m 0700 /operator/compiled-secrets
pnpm production:env -- /operator/compiled-secrets
```

The compiler writes separate files for Web, Worker, GitHub Control, migration
and the reverse-proxy authenticator. It also validates the runtime files through
the process-specific configuration loaders. It never overwrites a target.

New deployments should use `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
Legacy `CLOUDFLARE_R2_AK` and `CLOUDFLARE_R2_API` input remains supported for
the original hosted deployment.

## 5. Build and start

The public storage endpoint is part of the browser Content Security Policy and
must be fixed at image build time:

```bash
docker build \
  --build-arg S3_PUBLIC_ENDPOINT=https://uploads.example.com \
  --tag slopproof:local .

SLOPPROOF_IMAGE=slopproof:local \
SLOPPROOF_SECRET_DIR=/operator/compiled-secrets \
SLOPPROOF_DATA_DIR=/operator/data \
S3_PUBLIC_ENDPOINT=https://uploads.example.com \
docker compose -f compose.production.yaml up -d
```

Create `/operator/data/postgres` with ownership compatible with container uid
70 before starting. Review the CPU, memory, PID and tmpfs limits in
`compose.production.yaml`; the checked-in values target the maintainer's small
cohosted machine.

Place a reverse proxy in front of `127.0.0.1:3000`. It must terminate HTTPS,
set the OAuth proxy-authenticator headers described in
[production-configuration.md](production-configuration.md), reject direct Web
access and preserve the camera/microphone policy for the mobile route.

Serve exact `GET|HEAD /` from the static `landing/` payload (`index.html` and
`landing.js`). That directory is the marketing page. Do not point `/` at the
Next.js app shell in `apps/web/app/page.tsx`.

During a live proof the recording tab must stay in the foreground. Switching
away (another app, second screen, lock, or a different tab) aborts the take as
`visibility_lost`. That is the help/no-help guarantee: notes on a second screen
cannot be read while the take is running.

## 6. Verify before inviting contributors

1. Confirm `/api/health/live` and `/api/health/ready` return `200`.
2. Deliver a signed synthetic webhook and verify that replay stays idempotent.
3. Open a disposable pull request in a selected repository.
4. Complete Practice, phone handoff, recording, processing and maintainer
   review with synthetic content. Confirm that hiding the proof tab aborts the
   take.
5. Push a new commit and confirm that the old attempt becomes invalid.
6. Run retention and verify object deletion, key shredding and multipart abort.
7. Rehearse an encrypted database backup and restore into a separate database.

Do not make the SlopProof check required until this flow succeeds. The
[dogfooding runbook](../maintainers/dogfooding.md) describes the required-check
and break-glass sequence.
