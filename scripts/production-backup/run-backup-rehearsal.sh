#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

readonly BACKUP_ROOT='/Users/pascalkienast/Documents/SlopProof-Backups'
readonly KEY_ROOT='/Users/pascalkienast/.secrets/slopproof-backup-v1'
readonly RECIPIENT_CERT="$KEY_ROOT/recipient-cert.pem"
readonly RECIPIENT_KEY="$KEY_ROOT/recipient-private.pem"
readonly SSH_IDENTITY='/Users/pascalkienast/.ssh/mylocalapp/id_coolify_mgmt'
readonly REMOTE='root@157.180.84.237'
readonly MAX_FILE_BLOCKS_1_GIB=1048576
readonly MIN_FREE_BLOCKS_2_GIB=2097152
SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
readonly SCRIPT_ROOT

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_directory() {
  local path=$1 label=$2 actual
  [[ "$path" == /* && -d "$path" && ! -L "$path" ]] || die "$label is unsafe"
  actual=$(realpath "$path")
  [[ "$actual" == "$path" ]] || die "$label is not canonical"
  [[ $(stat -f '%Su:%Lp' "$path") == "$(id -un):700" ]] ||
    die "$label must be owner-controlled mode 0700"
}

require_file() {
  local path=$1 mode=$2 label=$3
  [[ "$path" == /* && -f "$path" && ! -L "$path" ]] || die "$label is unsafe"
  [[ $(stat -f '%Su:%Lp%l' "$path") == "$(id -un):${mode}1" ]] ||
    die "$label metadata is unsafe"
}

require_encrypted_private_key() {
  local path=$1 key_header=''
  IFS= read -r key_header < "$path" || die "Backup private key is not encrypted"
  [[ "$key_header" == '-----BEGIN ENCRYPTED PRIVATE KEY-----' ]] ||
    die "Backup private key is not encrypted"
  key_header=''
  unset key_header
}

require_absent() {
  local path=$1 label=$2
  [[ ! -e "$path" && ! -L "$path" ]] || die "$label already exists"
}

utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

remote_compose() {
  local release_id=$1
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' 300 \
    ssh "${ssh_options[@]}" "$REMOTE" \
    "/opt/slopproof/releases/${release_id}.incoming/source/scripts/production-deploy/deploy.sh" \
    backup-compose "$release_id" "$@"
}

remote_restore() {
  local release_id=$1
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' 300 \
    ssh "${ssh_options[@]}" "$REMOTE" \
    "/opt/slopproof/releases/${release_id}.incoming/source/scripts/production-deploy/deploy.sh" \
    "$@"
}

validate_restore_name() {
  [[ "$1" =~ ^slopproof_restore_[0-9]{8}_[0-9]{6}$ ]] ||
    die "Invalid restore database name"
}

[[ $# -eq 14 && $1 == --release-id && $3 == --commit &&
  $5 == --image-digest && $7 == --recipient-certificate &&
  $9 == --recipient-key && ${11} == --backup-root && ${13} == --identity ]] ||
  die "Invalid backup workflow arguments"

release_id=$2
commit=$4
image_digest=$6
recipient_certificate=$8
recipient_key=${10}
backup_root=${12}
identity=${14}
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "Invalid release ID"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "Invalid release commit"
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Invalid image digest"
[[ $(git -C "$SCRIPT_ROOT" rev-parse --show-toplevel) == "$SCRIPT_ROOT" ]] ||
  die "Backup workflow repository identity is invalid"
[[ $(git -C "$SCRIPT_ROOT" rev-parse HEAD) == "$commit" ]] ||
  die "Backup workflow commit does not match the release"
[[ -z $(git -C "$SCRIPT_ROOT" status --porcelain=v1 --untracked-files=all -- \
  scripts/production-backup) ]] || die "Backup workflow source is not clean"
[[ "$backup_root" == "$BACKUP_ROOT" ]] || die "Backup root is not canonical"
[[ "$recipient_certificate" == "$RECIPIENT_CERT" ]] || die "Recipient certificate is not canonical"
[[ "$recipient_key" == "$RECIPIENT_KEY" ]] || die "Recipient key is not canonical"
[[ "$identity" == "$SSH_IDENTITY" ]] || die "SSH identity is not canonical"
[[ $- != *x* ]] || die "Shell tracing must be disabled"

require_directory "$backup_root" "Backup root"
require_directory "$KEY_ROOT" "Backup key root"
require_file "$recipient_certificate" 644 "Recipient certificate"
require_file "$recipient_key" 600 "Recipient private key"
require_encrypted_private_key "$recipient_key"
require_file "$identity" 600 "SSH identity"

release_directory="$backup_root/$release_id"
require_absent "$release_directory" "Backup release directory"
mkdir -m 0700 "$release_directory"
require_directory "$release_directory" "Backup release directory"
[[ -f "$SCRIPT_ROOT/scripts/production-backup/database-audit.sql" &&
  ! -L "$SCRIPT_ROOT/scripts/production-backup/database-audit.sql" ]] ||
  die "Backup workflow source is unsafe"
[[ $(df -Pk "$release_directory" | awk 'NR == 2 {print $4}') -ge $MIN_FREE_BLOCKS_2_GIB ]] ||
  die "Backup destination does not have the required free space"
ulimit -f "$MAX_FILE_BLOCKS_1_GIB"
ulimit -c 0

cms_partial="$release_directory/$release_id.cms.partial"
cms_path="$release_directory/$release_id.cms"
receipt_path="$release_directory/$release_id.receipt.json"
source_audit="$release_directory/.source-audit.json"
restore_audit="$release_directory/.restore-audit.json"
drop_proof="$release_directory/.drop-proof.json"
for path in "$cms_partial" "$cms_path" "$receipt_path" "$source_audit" "$restore_audit" "$drop_proof"; do
  require_absent "$path" "Backup workflow artifact"
done

ssh_options=(
  -i "$identity"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o StrictHostKeyChecking=yes
)

restore_database=''
restore_lifecycle_begun=false
cleanup_restore_failed=false
cleanup() {
  local status=${1:-$?}
  trap - EXIT HUP INT TERM
  if [[ "$restore_lifecycle_begun" == true && -n "$restore_database" ]]; then
    if ! remote_restore "$release_id" restore-stop "$release_id" "$restore_database" \
      >/dev/null 2>&1; then
      cleanup_restore_failed=true
    fi
    if ! remote_restore "$release_id" restore-absent "$release_id" "$restore_database" \
      >/dev/null 2>&1; then
      cleanup_restore_failed=true
    fi
  fi
  [[ -e "$cms_partial" || -L "$cms_partial" ]] && rm -f -- "$cms_partial"
  if [[ "$cleanup_restore_failed" == true ]]; then
    printf '%s\n' "Restore-only cleanup failed; production is locked until the stale container is removed." >&2
    exit 1
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

remote_compose "$release_id" exec -T postgres \
  psql --username=slopproof --dbname=slopproof --no-psqlrc --quiet \
  --tuples-only --no-align --set=ON_ERROR_STOP=1 --file=- \
  < "$SCRIPT_ROOT/scripts/production-backup/database-audit.sql" 2>/dev/null |
  node "$SCRIPT_ROOT/scripts/production-backup/validate-database-audit.mjs" \
    --output "$source_audit"

backup_timestamp=$(utc_now)
# Reserve the partial name exclusively. OpenSSL writes the already-open file
# descriptor, so it never resolves or truncates a path after this point.
set -o noclobber
if ! exec 9>"$cms_partial"; then
  set +o noclobber
  die "Backup workflow artifact already exists"
fi
set +o noclobber
if ! perl -e 'alarm shift; exec @ARGV or exit 127' 1800 \
  ssh "${ssh_options[@]}" "$REMOTE" \
  "/opt/slopproof/releases/${release_id}.incoming/source/scripts/production-deploy/deploy.sh" \
  backup-compose "$release_id" exec -T postgres \
  pg_dump --username=slopproof --dbname=slopproof --format=custom \
  --no-owner --no-acl 2>/dev/null |
  openssl cms -encrypt -binary -stream -outform DER -aes-256-gcm \
    -recip "$recipient_certificate" \
    -keyopt rsa_padding_mode:oaep \
    -keyopt rsa_oaep_md:sha256 \
    -keyopt rsa_mgf1_md:sha256 \
    >&9 2>/dev/null; then
  die "Encrypted database backup failed"
fi
exec 9>&-
chmod 0600 "$cms_partial"
node "$SCRIPT_ROOT/scripts/production-backup/cms-artifact.mjs" finalize \
  --partial "$cms_partial" --final "$cms_path" --release-id "$release_id"

restore_database="slopproof_restore_$(date -u +%Y%m%d_%H%M%S)"
validate_restore_name "$restore_database"
restore_lifecycle_begun=true
remote_restore "$release_id" restore-start "$release_id" "$restore_database" \
  >/dev/null 2>&1 || die "Restore-only PostgreSQL failed to start"
restore_started_at=$(utc_now)
if ! perl -e 'alarm shift; exec @ARGV or exit 127' 1800 \
  "$SCRIPT_ROOT/scripts/production-backup/decrypt-cms-stream.sh" \
    --ciphertext "$cms_path" \
    --recipient-certificate "$recipient_certificate" \
    --recipient-key "$recipient_key" |
  perl -e 'alarm shift; exec @ARGV or exit 127' 1800 \
    ssh "${ssh_options[@]}" "$REMOTE" \
    "/opt/slopproof/releases/${release_id}.incoming/source/scripts/production-deploy/deploy.sh" \
    restore-exec "$release_id" "$restore_database" \
    pg_restore --username=slopproof --no-password --exit-on-error --single-transaction \
    --no-owner --no-acl --dbname="$restore_database" 2>/dev/null; then
  die "Authenticated restore rehearsal failed"
fi

remote_restore "$release_id" restore-exec "$release_id" "$restore_database" \
  psql --username=slopproof --no-password --dbname="$restore_database" --no-psqlrc --quiet \
  --tuples-only --no-align --set=ON_ERROR_STOP=1 --file=- \
  < "$SCRIPT_ROOT/scripts/production-backup/database-audit.sql" 2>/dev/null |
  node "$SCRIPT_ROOT/scripts/production-backup/validate-database-audit.mjs" \
    --output "$restore_audit"

remote_restore "$release_id" restore-stop "$release_id" "$restore_database" \
  >/dev/null 2>&1 || die "Restore-only PostgreSQL removal failed"
remote_restore "$release_id" restore-absent "$release_id" "$restore_database" \
  >/dev/null 2>&1 || die "Restore-only PostgreSQL absence was not verified"
restore_lifecycle_begun=false
printf '{"schema":"slopproof.database-drop-proof.v1","databaseName":"%s","databasePresent":false}\n' \
  "$restore_database" | node "$SCRIPT_ROOT/scripts/production-backup/validate-drop-proof.mjs" \
  --expected-database "$restore_database" --output "$drop_proof"
restore_completed_at=$(utc_now)

node "$SCRIPT_ROOT/scripts/production-backup/write-receipt.mjs" \
  --release-id "$release_id" --commit "$commit" \
  --image-digest "$image_digest" --timestamp "$backup_timestamp" \
  --ciphertext "$cms_path" --recipient-certificate "$recipient_certificate" \
  --source-audit "$source_audit" --restore-audit "$restore_audit" \
  --drop-proof "$drop_proof" \
  --restore-database "$restore_database" \
  --restore-started-at "$restore_started_at" \
  --restore-completed-at "$restore_completed_at" \
  --output "$receipt_path"

rm -f -- "$source_audit" "$restore_audit" "$drop_proof"
node "$SCRIPT_ROOT/scripts/production-backup/sync-publication.mjs" \
  --backup-root "$backup_root" \
  --release-directory "$release_directory" \
  --release-id "$release_id"
trap - EXIT HUP INT TERM
printf '%s\n' "Authenticated database backup and restore rehearsal passed."
