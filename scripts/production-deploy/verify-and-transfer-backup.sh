#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

readonly REMOTE='root@157.180.84.237'
readonly SHARED_ROOT='/opt/slopproof/shared'

die() { printf '%s\n' "$1" >&2; exit 1; }

[[ $# -eq 22 && $1 == --bundle && $3 == --trusted-checkout && $5 == --receipt && $7 == --recipient-certificate && $9 == --identity && ${11} == --expected-image-id && ${13} == --expected-image-tag && ${15} == --expected-image-source-commit && ${17} == --expected-archive-sha256 && ${19} == --expected-scan-sha256 && ${21} == --expected-sbom-sha256 ]] ||
  die "Usage: verify-and-transfer-backup.sh --bundle ABS --trusted-checkout ABS --receipt ABS --recipient-certificate ABS --identity ABS --expected-image-id SHA256 --expected-image-tag TAG --expected-image-source-commit SHA --expected-archive-sha256 HEX --expected-scan-sha256 HEX --expected-sbom-sha256 HEX"
bundle=$2
trusted_checkout=$4
receipt=$6
certificate=$8
identity=${10}
expected_image_id=${12}
expected_image_tag=${14}
expected_image_source_commit=${16}
expected_archive_sha256=${18}
expected_scan_sha256=${20}
expected_sbom_sha256=${22}
for path in "$bundle" "$trusted_checkout" "$receipt" "$certificate" "$identity"; do
  [[ "$path" == /* ]] || die "Every path must be absolute"
done

trusted_verifier="$trusted_checkout/scripts/production-backup/verify-receipt.mjs"
trusted_release_verifier="$trusted_checkout/scripts/production-deploy/prepare-release.mjs"
trusted_remote_installer="$trusted_checkout/scripts/production-deploy/install-backup-boundary-remote.sh"
[[ -f "$trusted_verifier" && ! -L "$trusted_verifier" &&
  -f "$trusted_release_verifier" && ! -L "$trusted_release_verifier" &&
  -f "$trusted_remote_installer" && ! -L "$trusted_remote_installer" ]] ||
  die "Trusted checkout verifiers are absent"
[[ -z $(git -C "$trusted_checkout" status --porcelain=v1 --untracked-files=all) ]] || die "Trusted checkout is not clean"
trusted_commit=$(git -C "$trusted_checkout" rev-parse --verify HEAD^{commit})
node "$trusted_release_verifier" verify --bundle "$bundle" \
  --repository "$trusted_checkout" \
  --expected-image-id "$expected_image_id" \
  --expected-image-tag "$expected_image_tag" \
  --expected-image-source-commit "$expected_image_source_commit" \
  --expected-archive-sha256 "$expected_archive_sha256" \
  --expected-scan-sha256 "$expected_scan_sha256" \
  --expected-sbom-sha256 "$expected_sbom_sha256"
manifest="$bundle/source/.slopproof-release.json"
release_id=$(jq -er '.releaseId' "$manifest")
commit=$(jq -er '.commit' "$manifest")
image_digest=$(jq -er '.image.id' "$manifest")
ciphertext=$(jq -er '.ciphertext.absolutePath' "$receipt")
[[ -f "$ciphertext" && ! -L "$ciphertext" ]] || die "Receipt ciphertext is absent"
receipt_sha256=$(shasum -a 256 "$receipt" | awk '{print $1}')
ciphertext_sha256=$(shasum -a 256 "$ciphertext" | awk '{print $1}')

[[ $(jq -er '.commit' "$manifest") == "$trusted_commit" ]] || die "Bundle does not match the trusted checkout commit"
node "$trusted_verifier" \
  --receipt "$receipt" --recipient-certificate "$certificate" \
  --release-id "$release_id" --commit "$commit" \
  --image-digest "$image_digest" --ciphertext-sha256 "$ciphertext_sha256"
[[ $(shasum -a 256 "$receipt" | awk '{print $1}') == "$receipt_sha256" &&
  $(shasum -a 256 "$ciphertext" | awk '{print $1}') == "$ciphertext_sha256" ]] ||
  die "Backup evidence changed during verification"
backup_timestamp=$(jq -er '.timestamp' "$receipt")
restore_completed_at=$(jq -er '.restoreRehearsal.completedAt' "$receipt")
parse_utc_epoch() {
  node -e '
    const milliseconds = Date.parse(process.argv[1]);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== process.argv[1].replace("Z", ".000Z")) process.exit(1);
    process.stdout.write(String(Math.floor(milliseconds / 1000)));
  ' "$1"
}
now_epoch=$(date -u +%s)
backup_epoch=$(parse_utc_epoch "$backup_timestamp") || die "Backup timestamp is invalid"
restore_epoch=$(parse_utc_epoch "$restore_completed_at") || die "Restore completion timestamp is invalid"
backup_age=$((now_epoch - backup_epoch))
restore_age=$((now_epoch - restore_epoch))
[[ "$backup_age" -ge 0 && "$backup_age" -le 900 &&
  "$restore_age" -ge 0 && "$restore_age" -le 900 ]] ||
  die "Backup or restore evidence is too old for migration"

temporary_root=${TMPDIR:-/tmp}
[[ "$temporary_root" == /* && -d "$temporary_root" && ! -L "$temporary_root" ]] ||
  die "Temporary directory boundary is invalid"
boundary=$(mktemp "$temporary_root/slopproof-backup-boundary.XXXXXXXX")
[[ -f "$boundary" && ! -L "$boundary" ]] || die "Unsafe temporary boundary"
trap 'rm -f -- "$boundary"' EXIT
jq -n --arg releaseId "$release_id" --arg commit "$commit" \
  --arg imageDigest "$image_digest" --arg ciphertextSha256 "$ciphertext_sha256" \
  --arg backupTimestamp "$backup_timestamp" --arg restoreCompletedAt "$restore_completed_at" \
  --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schema:"slopproof.verified-backup-boundary.v1",releaseId:$releaseId,commit:$commit,imageDigest:$imageDigest,ciphertextSha256:$ciphertextSha256,backupTimestamp:$backupTimestamp,restoreCompletedAt:$restoreCompletedAt,verifier:"scripts/production-backup/verify-receipt.mjs",status:"passed",verifiedAt:$verifiedAt}' \
  > "$boundary"
chmod 0600 "$boundary"
boundary_sha256=$(shasum -a 256 "$boundary" | awk '{print $1}')
boundary_base64=$(/usr/bin/base64 < "$boundary" | tr -d '\n')
[[ ${#boundary_base64} -ge 1 && ${#boundary_base64} -le 4096 &&
  "$boundary_base64" =~ ^[A-Za-z0-9+/=]+$ ]] ||
  die "Backup boundary encoding is invalid"
ssh_options=(-i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes)
perl -e 'alarm shift; exec @ARGV or exit 127' 120 \
  ssh "${ssh_options[@]}" "$REMOTE" /usr/bin/bash -s -- \
  "$release_id" "$boundary_sha256" "$boundary_base64" \
  < "$trusted_remote_installer"
printf '%s\n' "Verified and transferred one value-free backup boundary."
