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

[[ $# -ge 1 ]] || die "Expected images or containers"
mode=$1
shift
[[ "$mode" == images || "$mode" == containers ]] ||
  die "Expected images or containers"

source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
release_root=$(dirname "$source_root")
manifest="$source_root/.slopproof-release.json"
receipt="$release_root/.image-stage-receipt.json"
[[ -f "$manifest" && ! -L "$manifest" && -f "$receipt" && ! -L "$receipt" ]] ||
  die "Runtime release boundary is absent"
[[ $(stat -c '%U:%G %a' "$receipt") == 'root:root 600' ]] ||
  die "Image staging receipt identity mismatch"

release_id=$(jq -er '.releaseId' "$manifest")
app_tag=$(jq -er '.image.tag' "$manifest")
app_id=$(jq -er '.image.id' "$manifest")
postgres_reference=$(jq -er '.dependencies.postgresImage' "$manifest")
manifest_sha256=$(sha256sum "$manifest" | awk '{print $1}')
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ &&
  "$app_tag" =~ ^slopproof-app:[0-9a-f]{7}-gate9-amd64$ &&
  "$app_id" =~ ^sha256:[0-9a-f]{64}$ &&
  "$postgres_reference" =~ ^postgres:18[.]4-alpine3[.]24@sha256:[0-9a-f]{64}$ ]] ||
  die "Runtime release manifest identity mismatch"

jq -e \
  --arg releaseId "$release_id" \
  --arg manifestSha256 "$manifest_sha256" \
  --arg appTag "$app_tag" \
  --arg appId "$app_id" \
  --arg postgresImage "$postgres_reference" \
  'keys == ["appId","appPlatform","appTag","manifestSha256","postgresId","postgresImage","postgresPlatform","releaseId","schema","stagedAt"] and
   .schema == "slopproof.image-stage.v2" and
   .releaseId == $releaseId and .manifestSha256 == $manifestSha256 and
   .appTag == $appTag and .appId == $appId and .appPlatform == "linux/amd64" and
   .postgresImage == $postgresImage and .postgresPlatform == "linux/amd64" and
   (.postgresId | test("^sha256:[0-9a-f]{64}$")) and
   (.stagedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' \
  "$receipt" >/dev/null || die "Image staging receipt does not match the release"

postgres_id=$(jq -er '.postgresId' "$receipt")
[[ $(timeout --signal=TERM --kill-after=5s 30 docker image inspect \
  --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$app_id" 2>/dev/null) == "$app_id linux/amd64" &&
  $(timeout --signal=TERM --kill-after=5s 30 docker image inspect \
    --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$app_tag" 2>/dev/null) == "$app_id linux/amd64" &&
  $(timeout --signal=TERM --kill-after=5s 30 docker image inspect \
    --platform linux/amd64 --format '{{.Os}}/{{.Architecture}}' "$app_tag" 2>/dev/null) == 'linux/amd64' ]] ||
  die "Application image identity changed after staging"
[[ $(timeout --signal=TERM --kill-after=5s 30 docker image inspect \
  --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$postgres_id" 2>/dev/null) == "$postgres_id linux/amd64" &&
  $(timeout --signal=TERM --kill-after=5s 30 docker image inspect \
    --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$postgres_reference" 2>/dev/null) == "$postgres_id linux/amd64" &&
  $(timeout --signal=TERM --kill-after=5s 30 docker image inspect \
    --platform linux/amd64 --format '{{.Os}}/{{.Architecture}}' "$postgres_reference" 2>/dev/null) == 'linux/amd64' ]] ||
  die "PostgreSQL image identity changed after staging"
[[ ${SLOPPROOF_IMAGE:-} == "$app_id" ]] ||
  die "Runtime application image must be the immutable staged ID"
[[ ${SLOPPROOF_POSTGRES_IMAGE:-} == "$postgres_id" ]] ||
  die "Runtime PostgreSQL image must be the immutable staged ID"

if [[ "$mode" == containers ]]; then
  [[ $# -ge 1 ]] || die "Expected at least one service identity"
  for service in "$@"; do
    case "$service" in
      postgres) expected_image=$postgres_id ;;
      migrate | worker | github-control | web) expected_image=$app_id ;;
      *) die "Unexpected runtime service identity" ;;
    esac
    mapfile -t container_ids < <(
      timeout --signal=TERM --kill-after=5s 30 docker ps -aq \
        --filter label=com.docker.compose.project=slopproof-production \
        --filter "label=com.docker.compose.service=$service"
    )
    [[ ${#container_ids[@]} -eq 1 && ${container_ids[0]} =~ ^[0-9a-f]{12,64}$ ]] ||
      die "Runtime service container identity is ambiguous"
    [[ $(timeout --signal=TERM --kill-after=5s 30 docker inspect \
      --format '{{.Image}}' "${container_ids[0]}") == "$expected_image" ]] ||
      die "Runtime service uses an unexpected image"
  done
fi

printf '%s\n' "Runtime release identity verified."
