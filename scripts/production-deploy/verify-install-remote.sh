#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# -eq 5 ]] || die "Invalid trusted install boundary"
release_id=$1
incoming=$2
secret_incoming=$3
release_manifest_sha256=$4
source_manifest_sha256=$5
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ &&
  "$incoming" == "/opt/slopproof/releases/$release_id.incoming" &&
  "$secret_incoming" == "/etc/slopproof/secrets/.incoming-$release_id" &&
  "$release_manifest_sha256" =~ ^[0-9a-f]{64}$ &&
  "$source_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] || die "Trusted install tuple mismatch"
[[ -d "$incoming/source" && ! -L "$incoming" && -d "$incoming/artifacts" &&
  -d "$secret_incoming" && ! -L "$secret_incoming" ]] || die "Trusted staging state mismatch"
chown -R root:root "$incoming" "$secret_incoming"
[[ $(sha256sum "$incoming/source/.slopproof-release.json" | awk '{print $1}') == "$release_manifest_sha256" &&
  $(sha256sum "$incoming/source/.slopproof-source-manifest.json" | awk '{print $1}') == "$source_manifest_sha256" ]] || die "Remote immutable manifest hash mismatch"
# Validate every source byte with this trusted wrapper before executing any
# transferred program. The source manifest itself is pinned by the caller.
expected_count=$(jq -er '.files | length' "$incoming/source/.slopproof-source-manifest.json")
actual_count=$(find "$incoming/source" -type f | wc -l | tr -d '[:space:]')
[[ "$actual_count" -eq $((expected_count + 2)) &&
  -z $(find "$incoming/source" \( -type l -o ! -type f ! -type d \) -print -quit) ]] || die "Remote source file set mismatch"
while IFS=$'\t' read -r relative expected_hash expected_size; do
  [[ "$relative" != /* && "$relative" != *'..'* && "$expected_hash" =~ ^[0-9a-f]{64}$ && "$expected_size" =~ ^[0-9]+$ ]] || die "Remote source manifest record mismatch"
  path="$incoming/source/$relative"
  [[ -f "$path" && ! -L "$path" && $(stat -c '%s' "$path") == "$expected_size" &&
    $(sha256sum "$path" | awk '{print $1}') == "$expected_hash" ]] || die "Remote source content mismatch"
done < <(jq -er '.files[] | [.path,.sha256,(.size|tostring)] | @tsv' "$incoming/source/.slopproof-source-manifest.json")
[[ -z $(find "$incoming/artifacts" \( -type l -o ! -type f ! -type d \) -print -quit) &&
  $(find "$incoming/artifacts" -type f | wc -l | tr -d '[:space:]') -eq 3 ]] || die "Remote artifact file set mismatch"
for record in 'slopproof-app-linux-amd64.tar archiveSha256' 'trivy-linux-amd64.json scanReportSha256' 'sbom-linux-amd64.spdx.json sbomReportSha256'; do
  name=${record%% *}; field=${record#* }
  expected_hash=$(jq -er --arg field "$field" '.image[$field]' "$incoming/source/.slopproof-release.json")
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ && $(sha256sum "$incoming/artifacts/$name" | awk '{print $1}') == "$expected_hash" ]] || die "Remote artifact content mismatch"
done
node "$incoming/source/scripts/production-deploy/prepare-release.mjs" verify --bundle "$incoming"
/usr/bin/bash "$incoming/source/scripts/production-deploy/deploy.sh" install "$release_id" "$secret_incoming"
