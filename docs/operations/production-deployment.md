# Production deployment and rollback

Stand: 2026-08-13

This runbook is an operator procedure, not permission to change a live host.
Gate 8 requires an explicit backup and validation before Caddy or the active
release symlink is changed.

## Invariants

- `compose.production.yaml` is the only production topology. The local
  `compose.yaml` remains the internet-free demo profile.
- Web binds only `127.0.0.1:3000`; Worker, GitHub Control and PostgreSQL have no
  host port.
- Production uses Cloudflare R2. No local object-store or seed service exists.
- Migration must complete successfully before long-running services start.
- Every process reads exactly one protected `SLOPPROOF_ENV_FILE`; Compose never
  receives secret values through `environment` or `env_file`.
- The host keeps process files and PEMs outside the release directory. Private
  files remain root-owned mode 0600 and receive a narrowly scoped Linux ACL
  read grant for container uid 1000. `wrapping-public.pem` is deliberately
  public key material and remains mode 0644. `postgres-password` separately
  grants read to uid 70. Never relax private files to world-readable.
- Caddy keeps only exact `GET|HEAD /` on the landing root. Named app paths are
  proxied to loopback. Camera and microphone are allowed only on `/m` and
  `/m/*`.

## Preflight

1. Create a new release directory and verify its commit SHA. Do not reuse or
   overwrite the current release.
2. Compile process-scoped files into `/etc/slopproof/secrets` as documented in
   [production-configuration.md](production-configuration.md). Keep each
   process file and private PEM root-owned mode 0600 and grant read-only ACL
   access to uid 1000. Keep the public wrapping key root-owned mode 0644. Keep
   `postgres-password` root-owned mode 0600 with a read-only ACL for uid 70;
   its value must exactly match the password in every process `DATABASE_URL`.
   Verify filenames, owner, ACL and modes without printing content.
3. Create `/var/lib/slopproof/postgres` before Compose starts. It must be owned
   by uid/gid 70:70, mode 0700 and unreadable by unrelated host users; Compose
   intentionally has `create_host_path: false`.
4. Validate without interpolation or secret rendering:

   ```bash
   docker compose -f compose.production.yaml config --no-interpolate --quiet
   docker compose -f compose.production.yaml build
   ```

5. Start only PostgreSQL and migration, then require a successful migration
   exit. Never run the demo seed in production.
6. Start GitHub Control, Worker and Web. Require `healthy` for Web and the
   internal services before changing Caddy. Web startup is gated on the
   container-only GitHub Control health listener, and public readiness also
   probes that listener continuously; a later GitHub Control failure therefore
   turns readiness red even though its port is never published on the host.
7. From the host, require value-free health responses:

   ```bash
   curl --fail --silent --show-error http://127.0.0.1:3000/api/health/live
   curl --fail --silent --show-error http://127.0.0.1:3000/api/health/ready
   ```

8. Confirm the rendered container configuration contains file paths but no
   secret values. Do not use `docker inspect` output as an artifact because
   runtime metadata can still be sensitive.

## Caddy transition

1. Copy the existing Caddyfile and landing directory metadata into a
   timestamped, root-owned backup directory.
2. Render `infra/caddy/Caddyfile.production` into the existing site config with
   only `SLOPPROOF_SITE`, `LANDING_ROOT` and the derived proxy authenticator in
   Caddy's protected environment.
3. Run `caddy validate --config <candidate>` and keep the old process running on
   failure.
4. Reload atomically. Verify the landing root, one static Next asset, live and
   ready health, an app page, OAuth start rejection without a valid proxy
   authenticator, and `/m/handoff` response headers.
5. Confirm Caddy access logs omit the complete request URI (app paths contain
   private revision/attempt identifiers), client IPs, browser fingerprint
   headers, cookies, authorization, webhook signatures and proxy
   authenticators.

The template follows stock Caddy request matchers, response headers, reverse
proxy header rewriting and access-log filters documented by Caddy:
<https://caddyserver.com/docs/caddyfile/matchers>,
<https://caddyserver.com/docs/caddyfile/directives/header>, and
<https://caddyserver.com/docs/caddyfile/directives/log>.

## Graceful update

1. Create and build a new immutable release.
2. Run migration once. Migrations must be backward-compatible with the still
   running release until cutover.
3. Replace long-running containers with Compose; respect each service's stop
   grace period. Never kill FFmpeg or retention mid-transaction unless the
   normal grace period has expired.
4. Switch the release symlink only after readiness is green.
5. Observe value-free health and bounded operational metrics. Do not tail
   evidence, provider bodies or request headers.

## Rollback

- Application rollback: point the release symlink to the previous verified
  release, use its matching Compose file, and recreate long-running services.
- Caddy rollback: restore the exact backup, validate it, then reload.
- Database rollback is **not** `migrate down`. Restore a pre-deployment backup
  into a separate database, validate it, then perform a planned cutover. Never
  destructively restore over the only copy.
- Secret rollback uses the previous protected secret set only if it has not
  been revoked. Key compatibility rules are in [key-rotation.md](key-rotation.md).
- Record commit, image digest, migration list, readiness result, operator,
  timestamp and rollback reason without request or evidence identifiers.

## Reboot proof

After a scheduled reboot, verify Docker and Caddy start, migration remains a
completed one-shot, services become healthy in dependency order, the landing
root remains static, app paths reach loopback Web, and no demo/store/seed
container exists. A reboot test is incomplete until one retention audit and one
GitHub check reconciliation cycle also succeed.
