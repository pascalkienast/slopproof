# PostgreSQL backup and restore

Stand: 2026-08-13

Backups contain private repository metadata, encrypted evidence artifacts and
wrapped keys. Treat them as confidential even though media and provider payloads
are ciphertext.

## Backup

The Mobileup root filesystem is not encrypted. A dump must therefore never be
redirected to a VM path. The Mac receives `pg_dump` on SSH stdout and sends it
directly into authenticated CMS encryption. Here, `plaintextOnVm=false` and
`plaintextOnMac=false` mean the workflow creates **no persistent plaintext
file** during ordinary execution; the database, `pg_dump`, SSH, OpenSSL and
`pg_restore` necessarily handle bounded plaintext in memory. This assertion is
not proof against host-daemon crash dumps. The workflow sets the Mac core limit
to zero and Compose sets every service core limit to zero, but the receipt must
not be accepted until deployment preflight separately proves persistent core
dumps are disabled for the Docker daemon/host boundary. On the observed VM,
unlimited Docker service core limits plus enabled Apport make that precondition
currently unmet.

### One-time backup recipient

Create one RSA-3072 recipient only on the Mac. This key is offline relative to
the runtime: it is not a canonical production variable, must never enter the
repository, VM, container, image, CI, shell arguments or environment, and must
not reuse the recording wrapping key. Keep its private PEM encrypted with a
unique password-manager-held passphrase. Omitting `-passout` makes OpenSSL read
that passphrase interactively with terminal echo disabled.

```bash
set -o errexit -o nounset -o pipefail
umask 077
SLOPPROOF_BACKUP_KEY_DIR="/Users/pascalkienast/.secrets/slopproof-backup-v1"
test -d "/Users/pascalkienast/.secrets"
test ! -L "/Users/pascalkienast/.secrets"
test "$(realpath "/Users/pascalkienast/.secrets")" = "/Users/pascalkienast/.secrets"
test "$(stat -f '%Su:%Lp' "/Users/pascalkienast/.secrets")" = "$(id -un):700"
test ! -e "${SLOPPROOF_BACKUP_KEY_DIR}"
test ! -L "${SLOPPROOF_BACKUP_KEY_DIR}"
test ! -e "${SLOPPROOF_BACKUP_KEY_DIR}/recipient-private.pem"
test ! -e "${SLOPPROOF_BACKUP_KEY_DIR}/recipient-cert.pem"
mkdir -m 0700 "${SLOPPROOF_BACKUP_KEY_DIR}"
openssl req -new -x509 -newkey rsa:3072 -cipher aes-256-cbc \
  -keyout "${SLOPPROOF_BACKUP_KEY_DIR}/recipient-private.pem" \
  -out "${SLOPPROOF_BACKUP_KEY_DIR}/recipient-cert.pem" \
  -days 3650 -sha256 -subj "/CN=SlopProof Offline Database Backup v1" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,keyEncipherment"
chmod 0600 "${SLOPPROOF_BACKUP_KEY_DIR}/recipient-private.pem"
chmod 0644 "${SLOPPROOF_BACKUP_KEY_DIR}/recipient-cert.pem"
openssl pkey -in "${SLOPPROOF_BACKUP_KEY_DIR}/recipient-private.pem" \
  -check -noout
```

Create the canonical backup root once. This setup deliberately fails if the
target already exists or if either exact path is a symlink; later workflow runs
require the resulting root to remain canonical, owner-owned and mode 0700.

```bash
set -o errexit -o nounset -o pipefail
umask 077
SLOPPROOF_BACKUP_PARENT="/Users/pascalkienast/Documents"
SLOPPROOF_BACKUP_ROOT="${SLOPPROOF_BACKUP_PARENT}/SlopProof-Backups"
test -d "${SLOPPROOF_BACKUP_PARENT}"
test ! -L "${SLOPPROOF_BACKUP_PARENT}"
test "$(realpath "${SLOPPROOF_BACKUP_PARENT}")" = "${SLOPPROOF_BACKUP_PARENT}"
test "$(stat -f '%Su:%Lp' "${SLOPPROOF_BACKUP_PARENT}")" = "$(id -un):700"
test ! -e "${SLOPPROOF_BACKUP_ROOT}"
test ! -L "${SLOPPROOF_BACKUP_ROOT}"
mkdir -m 0700 "${SLOPPROOF_BACKUP_ROOT}"
test "$(realpath "${SLOPPROOF_BACKUP_ROOT}")" = "${SLOPPROOF_BACKUP_ROOT}"
test "$(stat -f '%Su:%Lp' "${SLOPPROOF_BACKUP_ROOT}")" = "$(id -un):700"
```

Back up the encrypted private key independently before declaring this the
recovery recipient. Losing it makes every CMS artifact unrecoverable. A
certificate fingerprint is public metadata; the private-key hash, password and
PEM content are prohibited metadata.

Before each release migration, run the checked-in workflow from a clean checkout
at the exact release commit. It is intentionally a **candidate-only** workflow:
the verified source must still exist at
`/opt/slopproof/releases/<id>.incoming/source`. It will not select a finalized or
current release. Every Compose invocation goes through that release's checked-in
`deploy.sh backup-compose` allowlist, which supplies only public driver values
and the exact protected secret path. `/etc/slopproof/slopproof.env` deliberately
does not exist.

The workflow verifies canonical, non-symlink, owner-controlled backup and key
directories; refuses existing or dangling artifact paths; requires a clean
`scripts/production-backup` tree at the release commit; bounds every SSH call;
and caps the CMS artifact at 1 GiB. On this macOS Bash, `ulimit -f` is in
1024-byte units, so the exact 1 GiB ceiling is `1048576`. It also requires at
least 2 GiB free before starting and disables local Mac core dumps before any
database stream is handled. Compose independently sets the PostgreSQL service's
soft and hard core limits to zero; that does not replace the host-level
precondition above.

```bash
scripts/production-backup/run-backup-rehearsal.sh \
  --release-id "${SLOPPROOF_RELEASE_ID}" \
  --commit "${SLOPPROOF_RELEASE_COMMIT}" \
  --image-digest "${SLOPPROOF_IMAGE_DIGEST}" \
  --recipient-certificate /Users/pascalkienast/.secrets/slopproof-backup-v1/recipient-cert.pem \
  --recipient-key /Users/pascalkienast/.secrets/slopproof-backup-v1/recipient-private.pem \
  --backup-root /Users/pascalkienast/Documents/SlopProof-Backups \
  --identity /Users/pascalkienast/.ssh/mylocalapp/id_coolify_mgmt
```

On success, the workflow retains only these artifacts, both mode 0600, in the
exact mode-0700 directory `<backup-root>/<release-id>/`:

- `<release-id>.cms`
- `<release-id>.receipt.json`

It creates `<release-id>.cms.partial` exclusively, streams OpenSSL output into
the already-open descriptor, checks size, parses the CMS structure and exact
algorithm profile from a bounded full ASN.1 traversal whose primitive dumps are
limited to one byte, binds and `fsync`s that partial inode, then publishes the
final name by same-directory hard link, verifies the inode/link count, removes
the partial and `fsync`s the directory. A separate no-output OpenSSL pass
validates the complete CMS structure. Receipt publication uses the same
no-overwrite pattern.
Any surviving partial makes later verification fail closed.
An interrupted or failed run can also leave private intermediate audit files in
that release directory; treat the whole directory as quarantined and investigate
or remove that exact failed release directory before a fresh, new release-ID run.

The fixed encryption command was locally round-tripped with OpenSSL 3.6.3. Its
CMS type is AuthEnvelopedData, content cipher AES-256-GCM, and recipient
transport RSA-OAEP with SHA-256 for OAEP and MGF1. `-stream` makes the outer
encoding BER-indefinite even though `-outform DER` selects the binary CMS
format. Verification requires exactly one RecipientInfo and rejects every
unexpected ASN.1 object identifier. AES-GCM authentication is not proven until
the restore pipeline reaches
a successful `pg_restore`; a SHA-256 alone is only an identity check.

### Receipt

The local receipt path is exactly
`<backup-root>/<release-id>/<release-id>.receipt.json`, mode 0600. It is
secret-free and may be copied into deployment evidence, but its local
`ciphertext.absolutePath` remains authoritative. The exact field set is:

```json
{
  "schema": "slopproof.encrypted-backup-receipt.v1",
  "releaseId": "20260813T000000Z",
  "commit": "0000000000000000000000000000000000000000",
  "imageDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "timestamp": "2026-08-13T00:00:00Z",
  "transport": "ssh-pg-dump-to-local-openssl-cms",
  "cipher": "CMS-AuthEnvelopedData/RSA-OAEP-SHA256/AES-256-GCM/BER-stream",
  "ciphertext": {
    "absolutePath": "/Users/pascalkienast/Documents/SlopProof-Backups/20260813T000000Z/20260813T000000Z.cms",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "bytes": 1
  },
  "recipient": {
    "certificateSha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "source": {
    "postgresVersion": "18.4",
    "migrationCount": 0,
    "tableCount": 0,
    "constraintCount": 0,
    "triggerCount": 0,
    "retentionInvariantViolations": 0
  },
  "plaintextOnVm": false,
  "plaintextOnMac": false,
  "restoreRehearsal": {
    "databaseName": "slopproof_restore_20260813_000001",
    "startedAt": "2026-08-13T00:00:01Z",
    "completedAt": "2026-08-13T00:00:02Z",
    "ciphertextSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "status": "passed",
    "migrationCount": 0,
    "tableCount": 0,
    "constraintCount": 0,
    "triggerCount": 0,
    "retentionInvariantViolations": 0,
    "dropped": true
  }
}
```

The workflow, rather than an operator, generates all count and rehearsal fields.
`database-audit.sql` runs in a repeatable-read, read-only transaction and emits
one allowlisted JSON object. Counts are scoped identically on source and rehearsal: applied rows in
`_slopproof_migrations` (zero when absent), ordinary/partitioned tables,
constraints and non-internal triggers in `public` and `pgboss`. The retention
audit checks the stored database constraints for every present retained
evidence/semantic table and cross-table deadline bindings, and records only the
violation count. It does not claim that an already-due row has been physically
removed from R2.
Never record row content, repository identity or head SHA from a database row,
author, object key, request path or evidence identifier. The required release
commit remains part of the receipt tuple. On a first empty production volume the
pre-migration counts can legitimately be zero; that is still the real rollback
boundary.

After the rehearsal below is green and the disposable database is confirmed
absent, verify the receipt before migration. The expected values must come from
the immutable release manifest, image inspection and a fresh ciphertext hash,
not from the receipt itself:

```bash
node scripts/production-backup/verify-receipt.mjs \
  --receipt "/Users/pascalkienast/Documents/SlopProof-Backups/${SLOPPROOF_RELEASE_ID}/${SLOPPROOF_RELEASE_ID}.receipt.json" \
  --recipient-certificate /Users/pascalkienast/.secrets/slopproof-backup-v1/recipient-cert.pem \
  --release-id "${SLOPPROOF_RELEASE_ID}" \
  --commit "${SLOPPROOF_RELEASE_COMMIT}" \
  --image-digest "${SLOPPROOF_IMAGE_DIGEST}" \
  --ciphertext-sha256 "${SLOPPROOF_CIPHERTEXT_SHA256}"
```

Verification fails closed on extra/missing fields, tuple mismatch, certificate
or artifact mismatch, unsafe path/mode/symlink, more than 1 GiB, unordered
timestamps, any retention violation, unequal source/restore counts, a failed
restore, or an undropped rehearsal database.

The only permitted publication of the value-free migration boundary is the
trusted wrapper below. It re-verifies the clean checkout, release bundle,
external image/scan/SBOM tuple, certificate, receipt and current ciphertext;
then it streams the independently trusted no-clobber installer over bounded SSH.
Do not copy the receipt or construct the boundary with `scp`, `rsync`, or an
ad-hoc remote command.

```bash
scripts/production-deploy/verify-and-transfer-backup.sh \
  --bundle "${SLOPPROOF_RELEASE_BUNDLE}" \
  --trusted-checkout "$(pwd -P)" \
  --receipt "/Users/pascalkienast/Documents/SlopProof-Backups/${SLOPPROOF_RELEASE_ID}/${SLOPPROOF_RELEASE_ID}.receipt.json" \
  --recipient-certificate /Users/pascalkienast/.secrets/slopproof-backup-v1/recipient-cert.pem \
  --identity /Users/pascalkienast/.ssh/mylocalapp/id_coolify_mgmt \
  --expected-image-id "${SLOPPROOF_IMAGE_DIGEST}" \
  --expected-image-tag "${SLOPPROOF_IMAGE_TAG}" \
  --expected-image-source-commit "${SLOPPROOF_IMAGE_SOURCE_COMMIT}" \
  --expected-archive-sha256 "${SLOPPROOF_ARCHIVE_SHA256}" \
  --expected-scan-sha256 "${SLOPPROOF_TRIVY_SHA256}" \
  --expected-sbom-sha256 "${SLOPPROOF_SBOM_SHA256}"
```

Only after that command reports success may the exact incoming release invoke
`deploy.sh migrate-start` with
`/opt/slopproof/shared/backup-receipt-${SLOPPROOF_RELEASE_ID}.verified.json`.

The receipt is not digitally signed and provides no non-repudiation. It is
process evidence within the trust boundary of the exact clean checkout and the
owner-private Mac account: anyone controlling that account and backup directory
can fabricate a receipt. CMS authentication protects ciphertext integrity and
recipient confidentiality; it does not independently attest that the rehearsal
ran. Preserve terminal evidence and the release manifest separately when a
stronger audit trail is required.

## Restore rehearsal

A successful `pg_dump` exit alone is not recoverability evidence. The executable
workflow starts the one fixed host-wide `slopproof-restore-global` container
whose exact labels bind the release and database. The fixed Docker name is an
atomic semaphore: concurrent release workflows cannot both create a restore
container even if they race after the global absence check. The PostgreSQL 18.4
restore target is named
`slopproof_restore_YYYYMMDD_HHMMSS`, streams authenticated CMS decryption
directly into its `pg_restore`, runs the identical scalar audit, then stops and
removes the exact container with its tmpfs state. A separate absence phase
requires both the exact container name and every container carrying the release
label to be absent. Only that process-generated absence proof lets
`write-receipt.mjs` set
`status=passed` and `dropped=true`. The workflow first requires the exact
global absence of every `com.slopproof.restore.release` container, not only the
current release, so at most one 1-GiB tmpfs rehearsal can consume the no-swap
Mobileup budget. A stale container after disconnect or failed cleanup locks all
later rehearsals until the operator inspects and removes that exact container;
the workflow reports cleanup failure rather than silently continuing. It then
requires the exact
`BEGIN ENCRYPTED PRIVATE KEY` PKCS#8 label, refuses shell tracing, prints a fixed
prompt to `/dev/tty`, and reads the passphrase silently with the Bash `read`
builtin. A Bash-builtin `printf` feeds it to OpenSSL's `-passin stdin`; it is
overwritten with an empty value and unset on success, failure or signal, and it
never enters argv, environment, history or a passphrase file. This limits
exposure but is not a cryptographic memory-zeroization guarantee for Bash.

The rehearsal never restores into production PostgreSQL or
`/var/lib/slopproof-production`. Its pinned container has no network, no Docker log driver,
no host bind or volume, a read-only root, all capabilities dropped,
`no-new-privileges`, soft and hard core limits of zero, and exact bounded tmpfs
mounts for PGDATA/WAL (768 MiB), `/tmp` (64 MiB), and the PostgreSQL run
directory (16 MiB). The container is capped at 0.5 CPU, 1 GiB RAM with no swap,
192 processes, and 64 MiB shared memory. This deliberate short-lived ceiling is
included in the 3.73 GiB Mobileup host budget: with the 640 MiB production
PostgreSQL ceiling, their combined configured ceilings are 1,664 MiB during the
rehearsal. That leaves 2,155 MiB of the observed physical RAM outside these two
cgroup limits for the host and cohosted services before application startup.
Server and session logging disable statement, duration and parameter logging;
Docker's `none` log driver prevents startup or server stderr from being
persisted by the container runtime. The launcher re-inspects all isolation and
resource settings before accepting restore input and verifies both effective
core limits inside the running container.

Routine stdout/stderr contains fixed, value-free phase success/failure messages
only. Hashes, fingerprint, PostgreSQL version and scalar counts exist in the
mode-0600 receipt but are not printed by the workflow. Raw SSH, Compose and
OpenSSL diagnostics are suppressed. Never enable shell tracing or log
environment, argv, `docker inspect`, SQL rows, dump/list output, request data,
repository coordinates or evidence identifiers.

An optional VM copy may contain only the mode-0600 CMS artifact and receipt
under the exact `/var/lib/slopproof-production/backups/<release-id>/` directory. Transfer
with checksum verification and no `--delete`, then compare its SHA-256 and byte
count to the receipt. Never copy the private key or a decrypted stream back.

## Disaster restore

- Stop new Web intake and all effect workers first.
- Preserve the failed database read-only for investigation.
- Restore into a new database/volume, validate, then atomically change the
  protected process files and recreate services.
- Reconcile queue/check/outbox state before accepting traffic. Idempotent jobs
  may replay; external provider and GitHub effects must use their persisted
  recovery paths.
- Run retention immediately. A restore never extends `delete_after`.

## Verified rehearsal

On 2026-08-13, Gate 7 exercised this procedure against two newly created,
explicitly named disposable local PostgreSQL 18.4 databases after migrations
0000–0015. `pg_dump --format=custom --no-owner --no-acl`, `pg_restore --list`
and `pg_restore --exit-on-error --single-transaction` all succeeded. The dump
SHA-256 was
`0b2f7ac997fbf620485e9e86a25fef1ab1b024607892ed392b6857d3acda3aa8`.
Source and restore both reported 16 migration rows, 43 public/pg-boss tables,
621 constraints and 80 triggers; migration idempotence on the restored target
also passed. The dump and both disposable databases were then deleted and
their absence was confirmed. This empty-fixture rehearsal proves the schema
and procedure, not recovery of live production evidence; production still
requires a scheduled encrypted backup and restore rehearsal after deployment.
