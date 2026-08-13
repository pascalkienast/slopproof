#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ ${EUID:-$(id -u)} -eq 0 && $# -eq 3 ]] ||
  die "Invalid backup-boundary installation request"
release_id=$1
expected_sha256=$2
encoded_boundary=$3
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ &&
  "$expected_sha256" =~ ^[0-9a-f]{64}$ &&
  ${#encoded_boundary} -ge 1 && ${#encoded_boundary} -le 4096 &&
  "$encoded_boundary" =~ ^[A-Za-z0-9+/=]+$ ]] ||
  die "Invalid backup-boundary tuple"

readonly shared_root=/opt/slopproof/shared
readonly incoming="$shared_root/.backup-receipt-$release_id.incoming"
readonly target="$shared_root/backup-receipt-$release_id.verified.json"
[[ -d "$shared_root" && ! -L "$shared_root" &&
  $(realpath -- "$shared_root") == "$shared_root" &&
  -d "/opt/slopproof/releases/$release_id.incoming/source" &&
  ! -e "/opt/slopproof/releases/$release_id" ]] ||
  die "Backup-boundary release state is invalid"
[[ ! -e "$incoming" && ! -L "$incoming" &&
  ! -e "$target" && ! -L "$target" ]] ||
  die "Backup-boundary destination already exists"

cleanup() {
  local status=${1:-$?}
  exec 9>&- 2>/dev/null || true
  [[ -e "$incoming" || -L "$incoming" ]] && rm -f -- "$incoming"
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

# Bash noclobber gives the fixed root-only staging name exclusive creation.
# The value-free JSON is passed as a bounded base64 argument so stdin remains
# reserved for this independently trusted script.
set -o noclobber
exec 9>"$incoming" || die "Could not reserve backup-boundary staging file"
set +o noclobber
printf '%s' "$encoded_boundary" | base64 --decode >&9
exec 9>&-
chown root:root "$incoming"
chmod 0600 "$incoming"
[[ $(sha256sum "$incoming" | awk '{print $1}') == "$expected_sha256" ]] ||
  die "Backup-boundary checksum mismatch"
jq -e --arg release_id "$release_id" \
  'keys == ["backupTimestamp","ciphertextSha256","commit","imageDigest","releaseId","restoreCompletedAt","schema","status","verifiedAt","verifier"] and
   .schema == "slopproof.verified-backup-boundary.v1" and
   .releaseId == $release_id and .status == "passed" and
   .verifier == "scripts/production-backup/verify-receipt.mjs" and
   (.commit | test("^[0-9a-f]{40}$")) and
   (.imageDigest | test("^sha256:[0-9a-f]{64}$")) and
   (.ciphertextSha256 | test("^[0-9a-f]{64}$")) and
   (.backupTimestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
   (.restoreCompletedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
   (.verifiedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' \
  "$incoming" >/dev/null || die "Backup-boundary schema mismatch"

# A hard link is a no-replace publication primitive on this one filesystem.
ln -- "$incoming" "$target"
sync -f "$target"
rm -f -- "$incoming"
sync -f "$shared_root"
[[ -f "$target" && ! -L "$target" &&
  $(stat -c '%U:%G %a %h' "$target") == 'root:root 600 1' &&
  $(sha256sum "$target" | awk '{print $1}') == "$expected_sha256" ]] ||
  die "Published backup-boundary identity mismatch"
trap - EXIT HUP INT TERM
printf '%s\n' "Installed one value-free backup verification boundary."
