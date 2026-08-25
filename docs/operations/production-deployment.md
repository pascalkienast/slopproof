# Production deployment and rollback

Stand: 2026-08-13

This runbook is an operator procedure, not permission to change a live host.
Gate 9 requires an explicit backup and validation before Caddy or the active
release symlink is changed.

The executable procedure is `scripts/production-deploy/deploy.sh`; it exposes
small, fail-closed phases rather than one opaque deploy. Do not skip or reorder
them. Every wait is bounded to at most 900 seconds. The initial Caddy phase is
deliberately named `initial-caddy-cutover`. Subsequent releases use the
separate managed path below and do not mutate Caddy unless an explicit
credential or configuration rotation is reviewed.

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
  files are created root-owned mode 0600, then receive a narrowly scoped Linux
  ACL read grant for container uid 1000. Linux mirrors the named-ACL mask into
  the numeric group mode bits, so `stat` may report 0640 (and 0710 on the
  traversable secret directory) even though `group::---`, `other::---` and the
  exact numeric named ACLs remain the authoritative access boundary.
  `wrapping-public.pem` is deliberately
  public key material and remains mode 0644. `postgres-password` separately
  grants read to uid 70. Never relax private files to world-readable.
- Caddy keeps exact `GET|HEAD /`, `/landing.js`, and the bounded
  `/product-flow/*` screenshot path on the landing root. Named app paths are
  proxied to loopback. Camera and microphone are allowed only on `/m` and
  `/m/*`. `LANDING_ROOT` at `/var/www/slopproof/landing` is a host static
  directory. Publish `landing/index.html`, `landing/landing.js`, and the five
  production screenshots with `node scripts/prepare-landing.mjs`. Sources are
  `slopproof-brand-ui-concept-v3.html`, root `landing.js`, and
  `docs/assets/product-flow/`. Production Caddy does not serve
  `apps/web/app/page.tsx` at `/`.

## Preflight

0. Before the first release transfer, stream the trusted bootstrap from the
   clean checkout while Docker has zero containers:

   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/mylocalapp/id_coolify_mgmt root@mobileup \
     /usr/bin/bash -s < scripts/production-deploy/bootstrap-host.sh
   ```

   It accepts only Ubuntu 24.04/amd64 and the audited Hetzner Ubuntu plus Caddy
   signed apt sources, installs the exact audited Ubuntu `nodejs` and `jq`
   package versions without recommends, and bounds both apt operations. It
   refuses a Docker/containerd restart if any Docker container exists. It also
   validates OpenSSH, gives `ssh.service` the same zero-core boundary and uses
   a normal bounded restart that preserves established sessions. Before
   atomically installing root-owned mode-0644 `LimitCORE=0` drop-ins, it keeps
   byte-exact prior drop-ins or explicit absence markers under the printed
   root-only `/opt/slopproof/shared/host-bootstrap/<UTC>` state directory. A
   failed bootstrap restores that boundary. It does not change Caddy,
   Replikator or host-wide Apport policy; effective service and process core
   limits make Apport irrelevant to Docker, containerd and the SSH transport
   carrying the plaintext dump stream.

   From a new local SSH process, require an independent reconnect before any
   release transfer or database dump:

   ```bash
   ssh -o BatchMode=yes -o IdentitiesOnly=yes \
     -i ~/.ssh/mylocalapp/id_coolify_mgmt root@mobileup \
     'test "$(systemctl is-active ssh.service)" = active && test "$(systemctl show ssh.service --property=LimitCORE --value)" = 0 && test "$(systemctl show ssh.service --property=LimitCORESoft --value)" = 0'
   ```

1. Run `deploy.sh preflight` read-only on mobileup. It verifies the exact
   audited bootstrap Caddy/unit identities (or a subsequently managed Caddy
   boundary), x86-64, the pinned host `nodejs`/`jq` packages, effective
   Docker/containerd/SSH hard and soft `LimitCORE=0`, Docker/Caddy health,
   disk/RAM, active services and that no SlopProof port is publicly bound.
   Every deploy phase also lowers its own hard and soft core limit to zero. Do
   not alter Replikator.
2. From a clean local commit, create a release bundle outside the repository
   with `prepare-release.mjs create`. It archives only allowlisted tracked
   regular files and excludes `.git`, `.env*` (including `.env.example`),
   `node_modules`, all caches/build/test/report outputs, bootstrap material and
   PEM/key/backup files. Its source manifest binds every path/mode/size/SHA-256
   to the commit and tree. A separate Docker archive is bound to its
   linux/amd64 tag, image ID and SHA-256 plus a zero-HIGH/CRITICAL Trivy report,
   SPDX report and pinned PostgreSQL digest.
3. Compile secrets into one new local mode-0700 directory. Transfer with
   `transfer-release.sh`: it uses checksum-rsync only into the exact new
   `<release>.incoming` and `.incoming-<release>` paths. It never uses
   `--delete` or targets `/opt/slopproof`, `/etc/slopproof`, or another broad
   parent. `deploy.sh install` verifies the manifest again, moves the exact
   nine compiler outputs into an immutable secret set, derives the raw Caddy
   credential without printing it, and verifies root ownership plus the
   minimum uid-1000/uid-70 read/traverse ACLs.
4. `deploy.sh image-stage` loads only the manifest-bound application archive,
   verifies its exact ID/tag/linux-amd64 platform, pulls only the digest-pinned
   PostgreSQL reference from `compose.production.yaml`, verifies its RepoDigest
   and platform, then durably writes a secret-free v2 staging receipt bound to
   the release-manifest hash and both exact local image IDs. Every later start,
   reload and reboot revalidates the receipt, mutable tags/references and
   platform, passes the immutable application image ID to Compose, and proves
   every created service container uses the expected ID. Compose is always
   invoked with `--no-build --pull never`.
5. `deploy.sh postgres-only` starts only unpublished PostgreSQL and proves the
   other four services remain absent. Before migration, stream the real dump
   over SSH directly into local CMS AES-256-GCM as documented in
   [database-backup-restore.md](database-backup-restore.md); no plaintext dump
   may touch either host. Complete the separate-database restore rehearsal and
   run `scripts/production-backup/verify-receipt.mjs` locally. Copy only a
   value-free `slopproof.verified-backup-boundary.v1` result (release ID,
   commit, image ID, ciphertext SHA-256, verifier path, status and UTC time) to
   `/opt/slopproof/shared/backup-receipt-<release>.verified.json` mode 0600.
   `deploy.sh migrate-start` refuses any other path/tuple, then runs migration,
   starts Worker/GitHub Control/Web internally and requires Compose plus custom
   readiness within 240 seconds.

Do not run a host build on the 3.73-GiB VM. The scanned amd64 archive is the
production artifact. No plaintext database backup is permitted on the VM.

### Initial Caddy cutover

The bootstrap Caddyfile is pinned as a full SHA-256 and exact prefix/site-block
SHA-256. Run `deploy.sh initial-caddy-cutover <release-id>`; the phase itself
extracts those audited byte ranges into its protected backup and proves their
reconstruction before mutation, so no ad-hoc operator file is a trust input.
The renderer proves the prefix plus old
block reconstruct the live file, preserves every non-SlopProof byte, installs
exactly one Unix admin socket and `persist_config off`, and renders only public
site/root variables. The proxy authenticator remains the literal runtime
`{file./run/credentials/caddy.service/oauth-proxy-authenticator}` placeholder.

The systemd drop-in copies the raw value with `LoadCredential` into a
service-private directory, removes the stock `--environ`, makes the admin
socket live only in a mode-0700 runtime directory and reloads only through the
explicit Unix address. The candidate is validated before any mutation. Every
changed Caddy/drop-in/symlink has a protected backup and an EXIT trap restores
and restarts the old service on failure. The active admin JSON is fetched over
the Unix socket and must contain the placeholder but not match the credential
file. A landing-only CSP keeps the exact R2 endpoint; app routes retain their
application CSP.

Before changing boot-visible state, the phase fsyncs the complete protected
backup, rendered candidate, adapted JSON and rollback receipt. It then publishes
and syncs the otherwise-harmless secret symlink first, followed by the systemd
drop-in and Caddyfile with a directory sync after each rename. Therefore a
power loss can leave only the old configuration or a new configuration whose
credential source is already durable; it cannot strand every cohost behind a
drop-in with a missing credential.

The cutover smoke proves landing, protected OAuth start with real Fetch
Metadata, callback rejection, invalid webhook-signature rejection,
value-free live/ready health, app pages and the unchanged exact cohosts
`https://paskie.me`, `https://wunderbluete.club` and
`https://replikator.paskie.me/api/health`.
All smoke response bodies and OAuth headers are held only in an owner-private
directory under the verified `/run` tmpfs, with core dumps disabled and
signal-safe cleanup; OAuth state and sealed flow cookies never touch the VM's
unencrypted root filesystem or diagnostics.

On the first cutover only, the database can contain zero active repositories
because GitHub could not deliver the existing installation event while the
public webhook path still served the bootstrap 503 boundary. The deploy phase
checks that exact aggregate before the smoke and then permits only the
value-free `503 {"error":"temporarily_unavailable"}` OAuth result. A protected
proxy rejection remains 400 and still fails the cutover. After GitHub's
authoritative installation delivery creates the binding, the final smoke
requires the normal GitHub authorization redirect; zero-repository bootstrap
is never accepted by `finalize`.

Before changing Caddy, the cutover phase publishes the complete rollback
boundary in the incoming release. This keeps rollback executable even if
finalize fails before the incoming directory is renamed. Only after all smoke
checks pass may `deploy.sh finalize` atomically move the
incoming directory to `/opt/slopproof/releases/<UTC>`, update `current`, write
the nonsecret release environment, install/enable the Compose unit and repeat
the smoke. The unit mounts secret files through Compose; no raw secret file is
an `EnvironmentFile`.

### Managed release upgrade

For a release after the first finalized deployment, run
`deploy.sh managed-prepare <release-id>` before the fresh backup rehearsal. It
accepts only a timestamped finalized `current` release, an unchanged complete
migration-file fingerprint and an identical Caddy proxy authenticator. It
snapshots the exact current symlinks, release environment and Compose unit into
a root-only rollback boundary, records the current Caddy hash, and fsyncs that
boundary before migration is allowed.

After the release-bound backup/restore receipt is verified, run
`migrate-start` and immediately `managed-finalize`. Finalization rechecks the
schema, Caddy and credential boundaries, verifies the candidate containers,
then atomically publishes the release, current/secret symlinks, release
environment and unit. A final service restart and external smoke must pass.
Caddy is not restarted or rewritten.

The OAuth smoke is repository-bound when a current open revision exists. This
keeps the check valid after Production grows beyond one active repository. If
multiple repositories are active but none has a current open revision, the
generic maintainer start must fail with the exact detail-free ambiguity
response; every other OAuth failure still fails the deployment. Automatic
rollback runs in a fresh deployment shell so a failed rollback smoke cannot be
masked by Bash conditional `errexit` semantics.

Any finalization failure invokes `managed-rollback`. That phase again proves
the unchanged migration fingerprint and Caddy hash, restores the previous
runtime boundary, restarts the previous exact image and smokes it. A changed
migration set or proxy credential is deliberately rejected: it needs a
separately designed database or Caddy transition, not this no-schema-change
path.

### Rollback boundary

`deploy.sh rollback` stops the candidate without `down` or volume deletion,
requires every project container to be `exited` or `created`, and proves that
the exact PostgreSQL container, bind-mount tuple and data-directory
device/inode/owner/mode remain unchanged. It then restores the exact
Caddy/drop-in/secret/current/release-unit boundary, validates and restarts
Caddy, and never downgrades the database or deletes R2. This first Gate-9
deployment may point back only to the exact audited
`bootstrap-YYYYMMDD-HHMM`; in that case it keeps the SlopProof unit disabled
and externally re-smokes the landing and every cohost. A later managed release
is automatically reversible only when `managed-prepare` proves the complete
migration set unchanged. Otherwise it is never started against a
forward-migrated shared database without an explicit schema-compatibility
attestation or a separately restored database cutover. Database rollback means
restoring the encrypted pre-migration backup into a separate database and a
planned connection cutover—never `migrate down` and never overwrite the only
copy.

The operator must retain the release manifest, image-stage receipt, encrypted
backup receipt/local verifier evidence, rollback boundary and smoke result.
None may contain secret values, row data, request/evidence identifiers or
provider payloads.

## Caddy transition

1. Copy the existing Caddyfile and landing directory metadata into a
   timestamped, root-owned backup directory.
2. Render `infra/caddy/Caddyfile.production` into the existing site config with
   only public site/root variables and the literal runtime file placeholder for
   the `LoadCredential` proxy authenticator. Never put the value in Caddy's
   environment or adapted JSON.
3. Run `caddy validate --config <candidate>` and keep the old process running on
   failure.
4. Perform the planned initial restart atomically. Verify the landing root, one static Next asset, live and
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
