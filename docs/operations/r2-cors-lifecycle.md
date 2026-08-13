# Cloudflare R2 browser CORS and lifecycle backstop

Stand: 2026-08-13

The private production bucket is `slopproof-eu` in the EU jurisdiction. The
application is authoritative for deleting Evidence within 24 hours and sooner
after a clean maintainer pass. R2 lifecycle is only an eventual backstop; it
must never be used to extend an application deadline.

## Committed policy

- [r2-cors.production.json](../../infra/cloudflare/r2-cors.production.json)
  allows only browser `PUT` from exactly `https://slopproof.paskie.me`, accepts
  only `content-type`, exposes only `ETag`, and caches preflight for five
  minutes.
- [r2-lifecycle.production.json](../../infra/cloudflare/r2-lifecycle.production.json)
  expires recording ciphertext under `evidence/v1/` and encrypted review
  frames under `provider-frame/` after 48 hours. It aborts incomplete recording
  multipart uploads after one day.

The 48-hour provider backstop deliberately leaves time for the application's
24-hour physical deletion and for R2's eventual lifecycle processing. The
bucket must have no public development URL or custom domain. Browser GET,
HEAD, POST and DELETE are not allowed; those operations remain authenticated
server/worker capabilities.

## Management boundary

Do not use the bucket-scoped S3 runtime credential for this operation. CORS,
lifecycle and public-domain state require a separate, short-lived Cloudflare
management token with only the necessary R2 write capability. That token must
stay on the operator machine, must never reach the VM or repository, and must
be revoked after verification.

Gate 8 used the already authenticated Cloudflare Dashboard session as the
separate management boundary. The exact committed CORS policy and both
lifecycle rules were applied on 2026-08-13, read back from the bucket settings,
and followed by the real browser smoke below. Public Development URL remained
disabled, no custom domain was added, and the bucket was empty after cleanup.
The temporary landing-page CSP was backed up at
`/etc/caddy/Caddyfile.bak-slopproof-r2-smoke-20260813-041644`, changed only to
allow the exact EU R2 endpoint in `connect-src`, validated, reloaded and smoked
alongside the unchanged Replikator, paskie.me and Wunderblüte sites.
For future replay through a short-lived management token, first list the
current configuration. Both Wrangler `set` commands replace the complete
corresponding configuration, so stop on any unexpected existing rule or
domain.

```bash
export WRANGLER_LOG=none
export WRANGLER_LOG_SANITIZE=true
export WRANGLER_SEND_METRICS=false
export WRANGLER_SEND_ERROR_REPORTS=false

pnpm dlx wrangler@4.115.0 r2 bucket info slopproof-eu --jurisdiction eu --json
pnpm dlx wrangler@4.115.0 r2 bucket cors list slopproof-eu --jurisdiction eu
pnpm dlx wrangler@4.115.0 r2 bucket lifecycle list slopproof-eu --jurisdiction eu
pnpm dlx wrangler@4.115.0 r2 bucket dev-url get slopproof-eu --jurisdiction eu
pnpm dlx wrangler@4.115.0 r2 bucket domain list slopproof-eu --jurisdiction eu
```

After confirming that replacement is safe:

```bash
pnpm dlx wrangler@4.115.0 r2 bucket cors set slopproof-eu \
  --jurisdiction eu \
  --file infra/cloudflare/r2-cors.production.json --force
pnpm dlx wrangler@4.115.0 r2 bucket lifecycle set slopproof-eu \
  --jurisdiction eu \
  --file infra/cloudflare/r2-lifecycle.production.json --force
```

Repeat every read command, confirm development URL is disabled and custom
domains are empty, then unset and revoke the management token. Never print the
token, rendered request authorization, presigned URLs, object keys or ETags.

## Opt-in browser multipart smoke

Run this only after the committed CORS and lifecycle policies have been applied
and read back. It deliberately refuses unless the opt-in value is exactly
`production-slopproof-eu`, the bucket is exactly `slopproof-eu`, the region is
exactly `auto`, both S3 endpoints are the authorized EU R2 endpoint, and a
private owner-only environment file supplies the six S3 runtime fields. Use a freshly compiled scoped
`web.env`; do not source it. The loader extracts only the six S3 fields, and
Chromium starts with an empty environment so neither the R2 credential nor
unrelated service credentials are inherited by the browser.

The environment file must be an absolute, non-symlink, regular file owned by
the effective user, mode `0600`, and no larger than 64 KiB. On the Mac, this
exact flow confines the canonical 61-secret environment to the compiler
subshell, points the smoke at only its scoped output, and removes every
temporary artifact on exit:

The production page must also emit one effective CSP whose `connect-src`
contains only `self` and the exact EU R2 endpoint. The smoke does not bypass
CSP: Gate 8 first failed locally in Chromium while the temporary landing page
still emitted `connect-src 'self'`; an equivalent value-free server request
proved R2 already accepted the signed request. The landing CSP was then backed
up, replaced with the exact endpoint, validated and reloaded before the passing
browser run. Gate 9 must preserve this constraint in both Caddy and the built
Next.js response.

```bash
(
  set -eu
  r2_smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/slopproof-r2-smoke.XXXXXX")"
  cleanup_r2_smoke() {
    trap - EXIT HUP INT TERM
    find "$r2_smoke_dir" -mindepth 1 -maxdepth 1 -type f -delete
    rmdir -- "$r2_smoke_dir"
  }
  trap cleanup_r2_smoke EXIT HUP INT TERM

  (
    set -a
    source "$HOME/.secrets/slopproof.env"
    set +a
    pnpm production:env -- "$r2_smoke_dir"
  )

  R2_BROWSER_SMOKE=production-slopproof-eu \
  R2_BROWSER_SMOKE_ENV_FILE="$r2_smoke_dir/web.env" \
  pnpm smoke:r2-browser
)
```

Do not move `pnpm smoke:r2-browser` into the compiler subshell. No secret or
signed material is present in the smoke command line. The smoke uses the
bucket-scoped server runtime credential for multipart create/complete,
authenticated HEAD/GET verification, and cleanup. A real headless Chromium
page first navigates to exactly `https://slopproof.paskie.me`, then uploads an
AES-GCM ciphertext fixture as one non-final target part of exactly 8 MiB
(strictly greater than S3's 5 MiB minimum) and one final part through presigned
`PUT` URLs. ETags remain in memory. The server-side read
must byte-match that ciphertext and must not contain its plaintext sentinel.

Two fresh disposable multipart sessions prove that an opaque wrong origin and
a one-second URL used only after a five-second wait are rejected. `ListParts`
must remain empty for both negative sessions. Every negative session is
aborted, and the positive object is deleted, in `finally` cleanup. A success
prints only `r2-browser: passed; temporary objects removed.`; failures print a
fixed error class only. Presigned URLs, object keys, upload IDs, ETags, hashes,
credentials and provider responses are never printed or placed in argv.

The contract tests do not contact R2 or the production origin:

```bash
pnpm test:r2-browser-smoke-contracts
```

Gate 8 executed this smoke after the Dashboard-applied policies were read back;
it passed and removed every temporary multipart session and object. Do not use
the runtime S3 credential to mutate the management-plane policies on a future
replay.

References: [Cloudflare CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/),
and [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/).
