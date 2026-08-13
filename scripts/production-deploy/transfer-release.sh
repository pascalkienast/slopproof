#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

readonly REMOTE='root@157.180.84.237'
readonly RELEASES_ROOT='/opt/slopproof/releases'
readonly SECRET_ROOT='/etc/slopproof/secrets'

die() { printf '%s\n' "$1" >&2; exit 1; }
bounded() { local seconds=$1; shift; perl -e 'alarm shift; exec @ARGV or exit 127' "$seconds" "$@"; }

[[ $# -eq 20 && $1 == --bundle && $3 == --compiled-secrets && $5 == --identity &&
  $7 == --trusted-checkout && $9 == --expected-image-id &&
  ${11} == --expected-image-tag && ${13} == --expected-image-source-commit &&
  ${15} == --expected-archive-sha256 && ${17} == --expected-scan-sha256 &&
  ${19} == --expected-sbom-sha256 ]] ||
  die "Usage: transfer-release.sh --bundle ABS --compiled-secrets ABS --identity ABS --trusted-checkout ABS --expected-image-id SHA256 --expected-image-tag TAG --expected-image-source-commit SHA --expected-archive-sha256 HEX --expected-scan-sha256 HEX --expected-sbom-sha256 HEX"

bundle=$2
compiled_secrets=$4
identity=$6
trusted_checkout=$8
expected_image_id=${10}
expected_image_tag=${12}
expected_image_source_commit=${14}
expected_archive_sha256=${16}
expected_scan_sha256=${18}
expected_sbom_sha256=${20}
for path in "$bundle" "$compiled_secrets" "$identity" "$trusted_checkout"; do
  [[ "$path" == /* ]] || die "All local paths must be absolute"
done
[[ -d "$bundle/source" && -d "$bundle/artifacts" && ! -L "$bundle" ]] || die "Release bundle is not a safe directory"
[[ -d "$compiled_secrets" && ! -L "$compiled_secrets" ]] || die "Compiled secret set is not a safe directory"
[[ $(realpath "$compiled_secrets") == "$compiled_secrets" &&
  $(stat -f '%u:%Lp' "$compiled_secrets") == "$(id -u):700" ]] ||
  die "Compiled secret set must be a canonical owner-controlled mode-0700 directory"
[[ -f "$identity" && ! -L "$identity" && $(stat -f '%Lp' "$identity") == 600 ]] || die "SSH identity must be a mode-0600 regular file"
[[ -f "$trusted_checkout/scripts/production-deploy/prepare-release.mjs" &&
  -f "$trusted_checkout/scripts/production-deploy/verify-install-remote.sh" &&
  -z $(git -C "$trusted_checkout" status --porcelain=v1 --untracked-files=all) ]] || die "Trusted checkout is not clean and complete"

release_manifest_sha256=$(shasum -a 256 "$bundle/source/.slopproof-release.json" | awk '{print $1}')
source_manifest_sha256=$(shasum -a 256 "$bundle/source/.slopproof-source-manifest.json" | awk '{print $1}')
verify_bundle() {
node "$trusted_checkout/scripts/production-deploy/prepare-release.mjs" verify \
  --bundle "$bundle" --repository "$trusted_checkout" \
  --expected-image-id "$expected_image_id" --expected-image-tag "$expected_image_tag" \
  --expected-image-source-commit "$expected_image_source_commit" \
  --expected-archive-sha256 "$expected_archive_sha256" \
  --expected-scan-sha256 "$expected_scan_sha256" \
  --expected-sbom-sha256 "$expected_sbom_sha256"
[[ $(shasum -a 256 "$bundle/source/.slopproof-release.json" | awk '{print $1}') == "$release_manifest_sha256" &&
  $(shasum -a 256 "$bundle/source/.slopproof-source-manifest.json" | awk '{print $1}') == "$source_manifest_sha256" ]] || die "Release bundle changed during verification"
}
verify_bundle
release_id=$(jq -er '.releaseId' "$bundle/source/.slopproof-release.json")
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "Invalid release ID"

incoming="$RELEASES_ROOT/$release_id.incoming"
secret_incoming="$SECRET_ROOT/.incoming-$release_id"
ssh_options=(-i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes)
rsync_ssh="ssh -i $identity -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes"

for target in "$incoming" "$RELEASES_ROOT/$release_id" "$secret_incoming" "$SECRET_ROOT/$release_id"; do
  bounded 60 ssh "${ssh_options[@]}" "$REMOTE" /usr/bin/test ! -e "$target"
  bounded 60 ssh "${ssh_options[@]}" "$REMOTE" /usr/bin/test ! -L "$target"
done
bounded 60 ssh "${ssh_options[@]}" "$REMOTE" /usr/bin/install -d -o root -g root -m 0700 \
  "$incoming" "$incoming/source" "$incoming/artifacts" "$secret_incoming"

# Every path is fixed and whitespace-free. The macOS OpenRSYNC-compatible
# option set below deliberately avoids unsupported modern-only flags. Remote
# rsync runs as root into a new root-owned directory; --no-owner/--no-group
# prevents preserving the local uid.
for pair in \
  "$bundle/source/|$REMOTE:$incoming/source/" \
  "$bundle/artifacts/|$REMOTE:$incoming/artifacts/" \
  "$compiled_secrets/|$REMOTE:$secret_incoming/"; do
  source_path=${pair%%|*}
  target_path=${pair#*|}
  bounded 900 /usr/bin/rsync --archive --checksum --no-owner --no-group --timeout=120 \
    --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= -e "$rsync_ssh" "$source_path" "$target_path"
done

# Detect a same-user mutation between the initial trust decision and transfer.
# The streamed root wrapper is not allowed to run until the complete local
# bundle has passed the independent Git/image verification a second time.
verify_bundle

# The trusted wrapper arrives over stdin, checks immutable manifest hashes,
# verifies the complete remote bundle, and only then invokes bundle code via
# /usr/bin/bash (transferred files intentionally start mode 0600).
bounded 180 ssh "${ssh_options[@]}" "$REMOTE" /usr/bin/bash -s -- \
  "$release_id" "$incoming" "$secret_incoming" \
  "$release_manifest_sha256" "$source_manifest_sha256" \
  < "$trusted_checkout/scripts/production-deploy/verify-install-remote.sh"

printf 'Transferred and installed release %s by checksum.\n' "$release_id"
