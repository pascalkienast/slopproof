# Ubuntu development handoff

This document freezes the Mac source boundary and defines the only approved
route to continue the SlopProof release on Ubuntu. It intentionally contains no
secret values, OAuth codes, cookies, presigned URLs, private evidence, or pilot
repository contents.

## A. Canonical source boundary

Handoff recorded at `2026-08-13T12:44:22Z`.

- Mac repository: `/Users/pascalkienast/Desktop/Projekte/SlopProof`
- Branch: `main`
- Canonical implementation HEAD:
  `79b2bf52344d8de3b332fd5e70c4219ac7e523f6`.
- The final handoff HEAD is the one documentation-only commit whose first
  parent is that implementation HEAD. A Git commit cannot contain its own SHA,
  so obtain the final full SHA with `git rev-parse HEAD` and bind the transfer
  to it as shown below. The closing report records that value independently.
- The implementation tree was clean before this document was added. The final
  handoff tree must also be clean after its documentation commit.
- No Git remote is configured. Do not create one or push as part of this
  handoff.
- No SlopProof Buildx, Docker export, Trivy, or image-inspect client from the
  failed Mac build remained after the final process check.

Relevant commits, newest first:

| Commit                                     | Purpose                                                                                                                           | Deployment state                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `79b2bf52344d8de3b332fd5e70c4219ac7e523f6` | Require the full 40-character source commit in the runtime image tag.                                                             | Local only; not deployed.             |
| `c2feb75a5ca9b8bdbf709bcc1eead03235ef4afb` | Accept the minimal authenticated-user identity returned by restricted GitHub App tokens and emit value-free OAuth failure stages. | Local only; not deployed.             |
| `5e70c5ec897f3ec9a7a428c93322d44786b812ca` | Honor `repository_selection=selected` instead of activating unrelated public account repositories from an installation event.     | Local only; not deployed.             |
| `5f4dc61f8345b5400885a2689c83d57c79f6e6f2` | Preserve trusted Caddy OAuth headers.                                                                                             | Currently deployed production commit. |

Final handoff verification actually run on the Mac:

```text
pnpm vitest run \
  apps/web/lib/github-oauth-client.test.ts \
  apps/web/lib/github-oauth-production.test.ts \
  apps/web/lib/github-oauth-runtime.test.ts \
  apps/web/lib/github-oauth-routes.test.ts \
  packages/github/src/webhook.test.ts

5 test files, 31 tests: passed
```

The command emitted the known engine warning because the Mac shell uses Node
`23.9.0` while the repository requires Node `>=24 <25`. Earlier in the same
session, after the two implementation fixes, `pnpm typecheck` passed; the full
unit suite passed `673/673`; boundary and secret audits passed. After the final
runtime-tag correction, `pnpm test:production-deployment` passed `13/13`, Bash
syntax passed, and `git diff --check` passed. These earlier results are useful
evidence but are not a substitute for a full final-HEAD run on Ubuntu with the
required Node version.

The handoff close also scanned all 198 added lines between deployed commit
`5f4dc61f8345b5400885a2689c83d57c79f6e6f2` and implementation HEAD for
credential material, presigned URLs, cookie values, private evidence artifacts,
and local absolute paths. No match was found.

Not run during the final Mac close:

- no Docker image build, export, runtime-image test, or image scan;
- no database integration test (`TEST_DATABASE_URL` was absent);
- no deployment, migration, Caddy mutation, rollback, or live OAuth retry;
- no smartphone flow.

The last implementation-HEAD Mac image build/export was aborted and was **not**
deployed. There is no successfully verified image archive or release bundle to
carry forward. Ubuntu must build a new image from the final clean handoff HEAD.

## B. Mac build failure and machine state

- Before targeted cleanup, the Mac had approximately `2.2 GiB` free.
- After removal of only superseded `/private/tmp` release bundles and image
  archives, it had approximately `4.9 GiB` free.
- The Buildx OCI export stopped making progress and was terminated.
- Docker Desktop logged `no space left on device`, EXT4 write I/O errors, and an
  aborted journal inside its Linux VM.
- Restarting Docker Desktop did not restore a responsive Docker Engine.
- Docker was not reset or repaired. `Docker.raw` was not changed, pruned, or
  deleted.
- No further Mac cleanup is a prerequisite for this handoff. Do not resume the
  build on this Mac.

## C. Read-only production snapshot

Read-only verification at handoff found:

- active link: `/opt/slopproof/current` ->
  `/opt/slopproof/releases/20260813T103748Z/source`;
- active release ID: `20260813T103748Z`;
- deployed source commit:
  `5f4dc61f8345b5400885a2689c83d57c79f6e6f2`;
- deployed application image ID:
  `sha256:b58e0a8d3f99aed309e9b93a87eeebc9ba3d7915a51134726d1e24d1bdb4edc9`;
- `caddy.service`: loaded, enabled, active/running;
- `slopproof-compose.service`: loaded, enabled, active/exited after successful
  one-shot orchestration;
- `web`, `worker`, `github-control`, and PostgreSQL containers: running and
  healthy; only Web is published, on `127.0.0.1:3000`;
- SlopProof root, liveness, and readiness: HTTP `200`;
- Replikator health, `paskie.me`, and `wunderbluete.club`: HTTP `200`.

The new local fixes are not deployed. The healthy active release must remain
unchanged until the Ubuntu-built replacement has passed every release gate.

### Non-active failed attempt on the VM

The failed Mac release attempt left a protected but non-active boundary:

- `/opt/slopproof/releases/20260813T115124Z.incoming` (`root:root`, mode `0700`);
- `/etc/slopproof/secrets/20260813T115124Z` with exact ACL-based service access;
- source commit `c2feb75a5ca9b8bdbf709bcc1eead03235ef4afb`;
- image-stage receipt schema `slopproof.image-stage.v2`;
- staged application ID
  `sha256:297062d73f8ca860b0c1ed94399d2c5662282204327be9b626f809ada5431663`;
- staged PostgreSQL ID
  `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`.

It was never made current and does not contain implementation HEAD `79b2bf5...`
or its documentation-only handoff descendant. Do not reuse its release ID,
source, image receipt, backup boundary, or secret set for the Ubuntu rollout.
Inspect it read-only and handle it later as a separately approved stale-incoming
cleanup; it is not part of this handoff transfer.

## D. Observed bugs and UX findings

### 1. Restricted GitHub identity response

- Category: `bug`
- Observed: after **Open contributor proof** and **Authorize with GitHub**, the
  callback rendered `{"error":"temporarily_unavailable"}`.
- Expected: the authenticated PR author is redirected to the private
  contributor page.
- Reproduction: open the public revision from the GitHub Check, select
  contributor proof, authorize with GitHub, and observe
  `/api/auth/github/callback`.
- Investigation: production client credentials, author binding, active
  repository binding, and the session-authorization query were independently
  valid. The provider client unnecessarily required the complete GitHub
  profile even though authentication consumes only numeric `id` and `login`.
- Affected files/routes:
  `apps/web/lib/github-oauth-client.ts`,
  `apps/web/lib/github-oauth-production.ts`,
  `/api/auth/github/callback`.
- Status: `fixed locally`, `tested locally`, `not deployed`; the inferred root
  cause still requires a live OAuth confirmation after deployment.
- Commit/test: `c2feb75a5ca9b8bdbf709bcc1eead03235ef4afb`;
  `apps/web/lib/github-oauth-client.test.ts` includes the restricted minimal
  identity regression. The production wiring now logs only a fixed stage enum,
  never provider payloads or credentials.

Being both PR author and repository maintainer is not rejected by the
contributor path. Contributor authorization checks exact current revision,
open PR, active installation/repository, and
`pull_request.author_id == authenticated GitHub user id`. It does not require
the user to lack maintainer permissions. Maintainer reauthorization is a
separate purpose and route. The combined role must nevertheless be exercised
in the live pilot because the callback fix has not yet been deployed.

### 2. Selected-repository installation ingestion

- Category: `bug`
- Observed: an installation event can include publicly readable account
  repositories even when the GitHub App installation is limited to selected
  repositories.
- Expected: only selected installation repositories become active.
- Reproduction: parse an `installation` delivery with
  `repository_selection=selected` and additional repository entries.
- Affected files:
  `packages/github/src/schemas.ts`, `packages/github/src/ingest.ts`.
- Status: `fixed locally`, `tested locally`, `not deployed`.
- Commit/test: `5e70c5ec897f3ec9a7a428c93322d44786b812ca`;
  `packages/github/src/webhook.test.ts` was included in the final `31/31` run;
  fresh-PostgreSQL integration coverage exists but was not rerun during this
  Mac close.

### 3. Runtime image tag contract mismatch

- Category: `ops`
- Observed: release creation correctly emitted a full-commit image tag, while
  `verify-runtime-release.sh` accepted only a seven-character tag. Image-stage
  stopped fail-closed with `Runtime release manifest identity mismatch` before
  any service or traffic mutation.
- Expected: creation and runtime verification require the same full 40-character
  source commit.
- Affected files:
  `scripts/production-deploy/verify-runtime-release.sh`,
  `scripts/lib/production-deployment.test.mjs`.
- Status: `fixed locally`, `tested locally`, `not deployed`.
- Commit/test: `79b2bf52344d8de3b332fd5e70c4219ac7e523f6`;
  production deployment contracts `13/13` passed.

### 4. Practice discoverability

- Category: `ux`
- Observed: the public revision page exposes **Open contributor proof** and a
  protected maintainer link, but not a visible **Practice your understanding**
  action. Practice becomes visible only on the authenticated contributor page.
- Expected: optional practice remains prominent without weakening the private
  author boundary or the primary proof flow.
- Reproduction: open a public revision from the GitHub Check and look for a
  practice action before contributor authentication.
- Affected pages:
  `apps/web/app/revisions/[revisionId]/page.tsx`,
  `apps/web/app/revisions/[revisionId]/contribute/page.tsx`.
- Status: `open`; no UX change was implemented in this handoff.

### 5. GitHub PR link discoverability

- Category: `ux`
- Observed: the Check Run detail links correctly to SlopProof, but the PR
  conversation contains no SlopProof comment with direct practice/proof links.
- Expected: a carefully permissioned, idempotent SlopProof PR comment can make
  the entry points easier to find.
- Reproduction: open the pilot PR conversation, compare it with the Check tab,
  and observe that only the Check provides the SlopProof link.
- Affected area: GitHub control/check publication and future PR-comment
  integration; no implementation file was changed for this request.
- Status: `open`. Do not expand GitHub App permissions or post comments without
  a separate design, permission, idempotency, privacy, and audit review.

### 6. Raw OAuth failure presentation

- Category: `ux`
- Observed: callback failure is a bare JSON error page.
- Expected: a value-free branded recovery page with a safe retry route, while
  retaining generic external errors.
- Affected route: `/api/auth/github/callback`.
- Status: `open`; the local commit adds only safe operational stage telemetry,
  not a presentation change.

## E. Mandatory Ubuntu continuation plan

### 1. Keep the Mac authoritative until the hash comparison

Do not commit, amend, or otherwise mutate the Mac repository after this
document's final commit. Record on the Mac:

```bash
cd /Users/pascalkienast/Desktop/Projekte/SlopProof
git status --short
git rev-parse HEAD
git rev-parse HEAD^
git rev-parse 'HEAD^{tree}'
git fsck --full
```

Status must be empty. `HEAD^` must be
`79b2bf52344d8de3b332fd5e70c4219ac7e523f6`, and the only path changed by the
final commit must be this handoff document:

```bash
test "$(git rev-parse HEAD^)" = 79b2bf52344d8de3b332fd5e70c4219ac7e523f6
test "$(git diff --name-only HEAD^ HEAD)" = docs/operations/ubuntu-development-handoff.md
export FINAL_HANDOFF_HEAD="$(git rev-parse HEAD)"
export FINAL_HANDOFF_TREE="$(git rev-parse 'HEAD^{tree}')"
```

### 2. Transfer a secret-free closure snapshot to the large Ubuntu disk

The snapshot must include `.git` but must not include ignored dependencies,
build outputs, local keys, runtime secrets, backups, or evidence. The tracked
`.env.example` is a value-free schema template and is expected; no populated
`.env` file is allowed.

Set these placeholders only after verifying the Ubuntu host and mount:

```bash
export MAC_REPO=/Users/pascalkienast/Desktop/Projekte/SlopProof
export UBUNTU_HOST='<ubuntu-user>@<ubuntu-host>'
export UBUNTU_DATA_ROOT='/mnt/<verified-large-data-mount>/slopproof-handoff'
export FINAL_HANDOFF_HEAD="$(git -C "$MAC_REPO" rev-parse HEAD)"
export FINAL_HANDOFF_TREE="$(git -C "$MAC_REPO" rev-parse 'HEAD^{tree}')"
export SNAPSHOT_ID="$FINAL_HANDOFF_HEAD-20260813T124422Z"
export SNAPSHOT_PATH="$UBUNTU_DATA_ROOT/$SNAPSHOT_ID.incoming"
```

Read-only remote preflight:

```bash
ssh "$UBUNTU_HOST" "set -eu; findmnt -T '$UBUNTU_DATA_ROOT'; df -h '$UBUNTU_DATA_ROOT'; test ! -e '$SNAPSHOT_PATH'; test ! -L '$SNAPSHOT_PATH'"
```

Create a transfer list that contains only tracked files plus the complete Git
database. This list deliberately omits every ignored worktree artifact:

```bash
cd "$MAC_REPO"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
{ git ls-files -z --cached; printf '.git/\0'; } > /private/tmp/slopproof-handoff-files.zlist
ssh "$UBUNTU_HOST" "install -d -m 0700 '$SNAPSHOT_PATH'"
```

The large disk is an archival/transport boundary, so do not trust its NTFS/FUSE
mode or ownership projection. Compare content with checksums while explicitly
not preserving those projected attributes:

```bash
rsync -aHcRvn --from0 \
  --files-from=/private/tmp/slopproof-handoff-files.zlist \
  --no-owner --no-group --no-perms --itemize-changes \
  "$MAC_REPO/" "$UBUNTU_HOST:$SNAPSHOT_PATH/"

rsync -aHcRv --from0 \
  --files-from=/private/tmp/slopproof-handoff-files.zlist \
  --no-owner --no-group --no-perms --itemize-changes \
  "$MAC_REPO/" "$UBUNTU_HOST:$SNAPSHOT_PATH/"

rsync -aHcRvn --from0 \
  --files-from=/private/tmp/slopproof-handoff-files.zlist \
  --no-owner --no-group --no-perms --itemize-changes \
  "$MAC_REPO/" "$UBUNTU_HOST:$SNAPSHOT_PATH/"
```

The last dry run must emit no file changes. Then verify the Git identity from
the snapshot:

```bash
ssh "$UBUNTU_HOST" "set -eu; test \"\$(git -C '$SNAPSHOT_PATH' rev-parse HEAD)\" = '$FINAL_HANDOFF_HEAD'; test \"\$(git -C '$SNAPSHOT_PATH' rev-parse 'HEAD^{tree}')\" = '$FINAL_HANDOFF_TREE'; test -z \"\$(git -C '$SNAPSHOT_PATH' status --porcelain=v1 --untracked-files=all)\"; git -C '$SNAPSHOT_PATH' fsck --full"
```

Do not transfer these Mac paths with the source snapshot:

- `/Users/pascalkienast/.secrets/slopproof.env`
- `/Users/pascalkienast/.secrets/slopproof-backup-v1/`
- `/Users/pascalkienast/Documents/SlopProof-Backups/`
- `/Users/pascalkienast/.ssh/mylocalapp/id_coolify_mgmt`
- `infra/docker/secrets/*.pem`
- any `node_modules`, `.next`, `dist`, `output`, `test-results`, image archive,
  SBOM, scan report, recording, transcript, frame, or evidence artifact.

If Ubuntu later needs release credentials, provision them through a separate
approved secret channel into owner-private paths. Expected names only:

- `~/.secrets/slopproof.env` (mode `0600`);
- `~/.ssh/mylocalapp/id_coolify_mgmt` (mode `0600`);
- optional offline backup recipient paths under
  `~/.secrets/slopproof-backup-v1/`.

The source build needs the public variable name `S3_PUBLIC_ENDPOINT`. Runtime
release tooling also names `SLOPPROOF_SECRET_DIR`, `SLOPPROOF_DATA_DIR`,
`SLOPPROOF_IMAGE`, and `SLOPPROOF_POSTGRES_IMAGE`. Never copy or print their
values into the snapshot or this document.

### 3. Preserve any existing Ubuntu copy before synchronization

Never rsync into an existing Ubuntu worktree. Inspect it first:

```bash
export UBUNTU_EXISTING='/path/to/existing/SlopProof'
ssh "$UBUNTU_HOST" "set -eu; if test -d '$UBUNTU_EXISTING/.git'; then git -C '$UBUNTU_EXISTING' status --short; git -C '$UBUNTU_EXISTING' rev-parse HEAD; git -C '$UBUNTU_EXISTING' rev-parse 'HEAD^{tree}'; fi"
```

If it exists, make a reversible archive on the large data disk before any
change. A tar archive is intentional because it preserves Linux metadata inside
one file even when the large disk is NTFS/FUSE:

```bash
export PRE_SYNC_ID="$(date -u +%Y%m%dT%H%M%SZ)"
ssh "$UBUNTU_HOST" "set -eu; test -d '$UBUNTU_EXISTING'; tar -C \"$(dirname "$UBUNTU_EXISTING")\" -cpf '$UBUNTU_DATA_ROOT/pre-sync-$PRE_SYNC_ID.tar' \"$(basename "$UBUNTU_EXISTING")\"; sha256sum '$UBUNTU_DATA_ROOT/pre-sync-$PRE_SYNC_ID.tar' > '$UBUNTU_DATA_ROOT/pre-sync-$PRE_SYNC_ID.tar.sha256'"
```

Do not overwrite that worktree. Continue from the fresh snapshot and a fresh
native copy.

### 4. Do not build until Ubuntu storage is corrected

The Ubuntu system disk was observed with only about `4.6 GiB` free and Docker
using `/var/lib/docker` on that disk. Before any install or build:

```bash
ssh "$UBUNTU_HOST" 'df -h / /var/lib/docker; findmnt -T /var/lib/docker; docker info --format "{{.DockerRootDir}}"'
```

Free at least `20-30 GiB`, or relocate Docker to a sufficiently sized **native
Linux filesystem** and verify the effective Docker root afterward. Do not use
the large NTFS/FUSE data disk as Docker root or as the active permissions-
sensitive worktree.

### 5. Create a native Ubuntu worktree

After storage is safe, clone from the transport snapshot onto ext4/XFS (or
another suitable native Linux filesystem):

```bash
export UBUNTU_NATIVE_ROOT='/path/on/native-linux-filesystem'
export UBUNTU_WORKTREE="$UBUNTU_NATIVE_ROOT/SlopProof-$FINAL_HANDOFF_HEAD.incoming"
ssh "$UBUNTU_HOST" "set -eu; test ! -e '$UBUNTU_WORKTREE'; git clone --no-local '$SNAPSHOT_PATH' '$UBUNTU_WORKTREE'; git -C '$UBUNTU_WORKTREE' checkout main; test \"\$(git -C '$UBUNTU_WORKTREE' rev-parse HEAD)\" = '$FINAL_HANDOFF_HEAD'; test \"\$(git -C '$UBUNTU_WORKTREE' rev-parse 'HEAD^{tree}')\" = '$FINAL_HANDOFF_TREE'; test -z \"\$(git -C '$UBUNTU_WORKTREE' status --porcelain=v1 --untracked-files=all)\"; git -C '$UBUNTU_WORKTREE' fsck --full"
```

Compare the Ubuntu tree hash with the Mac and snapshot tree hashes before
declaring Ubuntu the new source boundary.

### 6. Build and verify natively on Ubuntu

Use Node 24 and the repository's pinned dependencies. First run the focused and
global non-Docker gates, including the fresh-PostgreSQL integration suites.
Then build a new image from final HEAD with a **new** release ID and the exact
full-commit tag:

```bash
cd "$UBUNTU_WORKTREE"
export SOURCE_COMMIT="$FINAL_HANDOFF_HEAD"
export IMAGE_TAG="slopproof-app:$SOURCE_COMMIT-gate9-amd64"

docker buildx build \
  --platform linux/amd64 \
  --provenance=mode=max \
  --load \
  --build-arg S3_PUBLIC_ENDPOINT="$S3_PUBLIC_ENDPOINT" \
  --tag "$IMAGE_TAG" .

SLOPPROOF_IMAGE="$IMAGE_TAG" pnpm test:production-image
```

Generate a fresh archive, Trivy `0.73.0` HIGH/CRITICAL report, SPDX 2.3 SBOM,
and release bundle using the checked-in production tooling. Run
`prepare-release.mjs verify` with external expected image ID, full tag, full
source commit, and all three artifact hashes. Do not use Mac release ID
`20260813T115124Z` or any of its staged artifacts.

### 7. Deploy reversibly; Production never builds the app

Follow `docs/operations/production-deployment.md` and
`docs/operations/database-backup-restore.md`. Transfer the independently
verified application archive and release bundle by checksum. The Production VM
must continue to use `--no-build --pull never`; it neither builds nor pulls the
application.

Use a fresh protected secret set, run read-only preflight, stage the exact app
and PostgreSQL identities, perform the authenticated encrypted backup/restore
rehearsal, transfer its verified boundary, run migrations, start the candidate,
perform value-free pre-finalize/cohost smokes, and only then finalize the new
immutable release. Keep release `20260813T103748Z` as the healthy rollback
boundary until completion.

### 8. Required live acceptance after Ubuntu rollout

1. Verify root, liveness, readiness, worker/control health, Caddy, and every
   existing cohost.
2. Create or update a small pilot PR in the selected installation repository.
3. Follow the GitHub Check link to SlopProof.
4. Exercise contributor OAuth as the exact PR author who is also a maintainer.
5. Confirm redirect to the private contributor page and confirm that both
   **Practice your understanding** and **Prove your understanding** are usable.
6. Exercise protected maintainer reauthorization separately.
7. Repeat the contributor path on a smartphone, including camera/microphone
   permission handling and the final SHA-bound Check result.
8. If OAuth still fails, use only the fixed value-free stages
   `token_exchange`, `user_fetch`, `session_persist`, or `session_revoke`; do
   not log codes, tokens, cookies, user payloads, or repository content.

Until all steps pass, the current healthy Production release stays unchanged.
