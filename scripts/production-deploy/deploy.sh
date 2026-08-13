#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
ulimit -S -c 0
ulimit -H -c 0
[[ $(ulimit -S -c) == 0 && $(ulimit -H -c) == 0 ]] || {
  printf '%s\n' "Deployment shell core limit is not zero" >&2
  exit 1
}

readonly APP_ROOT=/opt/slopproof
readonly RELEASES_ROOT=/opt/slopproof/releases
readonly CURRENT_LINK=/opt/slopproof/current
readonly SHARED_ROOT=/opt/slopproof/shared
readonly ETC_ROOT=/etc/slopproof
readonly SECRET_ROOT=/etc/slopproof/secrets
readonly DATA_ROOT=/var/lib/slopproof-production
readonly CADDYFILE=/etc/caddy/Caddyfile
readonly CADDY_DROPIN=/etc/systemd/system/caddy.service.d/10-slopproof-credential.conf
readonly COMPOSE_UNIT=/etc/systemd/system/slopproof-compose.service
readonly POSTGRES_IMAGE='postgres:18.4-alpine3.24@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15'
readonly CADDY_ADMIN='unix//run/caddy/admin.sock'
readonly EXPECTED_CADDY_SHA256='2076139705618438e75f7ea8506edbb887bf2d52f63788ac454762f041caa22e'
readonly EXPECTED_CADDY_PREFIX_SHA256='eeb3f758eb40815b974ee400059adaec9811d242e1f80899b299abfde9c2a423'
readonly EXPECTED_CADDY_BLOCK_SHA256='f0beaf417c95df6dac2f196bd38c01a73a9ae87ffff14b324eb7e2c012602d1c'
readonly EXPECTED_CADDY_UNIT_SHA256='6c271e030644bd36a0c8956885934f16c928f88202bc126f12cde519ef9693ff'
readonly EXPECTED_SLOPPROOF_UNIT_SHA256='264d6a7ac114ce82fc723a3dcf3839b0e0f72f415ab8932003d49decb0d4da4f'
readonly EXPECTED_NODEJS_PACKAGE='18.19.1+dfsg-6ubuntu5'
readonly EXPECTED_JQ_PACKAGE='1.7.1-3ubuntu0.24.04.2'

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "This phase must run as root on mobileup"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_effective_service_core_limit() {
  local unit=$1 hard soft pid
  systemctl is-active --quiet "$unit" || die "$unit is not active"
  hard=$(systemctl show "$unit" --property=LimitCORE --value)
  soft=$(systemctl show "$unit" --property=LimitCORESoft --value)
  [[ "$hard" == 0 && "$soft" == 0 ]] || die "$unit must have effective hard/soft LimitCORE=0"
  pid=$(systemctl show "$unit" --property=MainPID --value)
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/limits" ]] ||
    die "$unit has no verifiable main process"
  awk '$1 == "Max" && $2 == "core" && $3 == "file" && $4 == "size" && $5 == "0" && $6 == "0" { found=1 } END { exit(found ? 0 : 1) }' \
    "/proc/$pid/limits" || die "$unit main process can create a core dump"
}

require_bootstrapped_host() {
  local node_package jq_package node_runtime jq_runtime unit
  [[ $(command -v node) == /usr/bin/node && $(command -v jq) == /usr/bin/jq ]] ||
    die "Production host tools must resolve to the audited Ubuntu package paths"
  node_package=$(dpkg-query -W -f='${Version}' nodejs 2>/dev/null) ||
    die "Production nodejs package is absent"
  jq_package=$(dpkg-query -W -f='${Version}' jq 2>/dev/null) ||
    die "Production jq package is absent"
  [[ "$node_package" == "$EXPECTED_NODEJS_PACKAGE" ]] || die "Production nodejs package version mismatch"
  [[ "$jq_package" == "$EXPECTED_JQ_PACKAGE" ]] || die "Production jq package version mismatch"
  node_runtime=$(node --version)
  jq_runtime=$(jq --version)
  [[ "$node_runtime" =~ ^v([0-9]+)\. ]] || die "Unparseable Node.js runtime version"
  (( BASH_REMATCH[1] >= 18 )) || die "Node.js runtime must be at least 18"
  [[ "$jq_runtime" =~ ^jq-1\.7([.]|$) ]] || die "jq runtime must be 1.7.x"
  [[ $(command -v sshd) == /usr/sbin/sshd ]] || die "OpenSSH server must resolve to /usr/sbin/sshd"
  /usr/sbin/sshd -t || die "OpenSSH server configuration validation failed"
  for unit in containerd.service docker.service ssh.service; do
    require_effective_service_core_limit "$unit"
  done
}

require_release_id() {
  [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "Invalid release ID"
}

assert_production_data_root() {
  local parent=/var/lib mode
  [[ -d "$parent" && ! -L "$parent" && $(realpath -e -- "$parent") == "$parent" &&
    $(stat -c '%U:%G' "$parent") == 'root:root' ]] ||
    die "Production data parent identity mismatch"
  mode=$(stat -c '%a' "$parent")
  (( (8#$mode & 8#022) == 0 )) || die "Production data parent is group/world writable"
  if [[ -e "$DATA_ROOT" || -L "$DATA_ROOT" ]]; then
    [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" &&
      $(realpath -e -- "$DATA_ROOT") == "$DATA_ROOT" &&
      $(stat -c '%U:%G %a' "$DATA_ROOT") == 'root:root 700' ]] ||
      die "Production data root identity mismatch"
  fi
}

ensure_postgres_data_directory() {
  local postgres_directory="$DATA_ROOT/postgres"
  assert_production_data_root
  if [[ ! -e "$DATA_ROOT" && ! -L "$DATA_ROOT" ]]; then
    mkdir --mode=0700 -- "$DATA_ROOT" || die "Could not exclusively create production data root"
    chown root:root "$DATA_ROOT"
  fi
  assert_production_data_root
  if [[ ! -e "$postgres_directory" && ! -L "$postgres_directory" ]]; then
    mkdir --mode=0700 -- "$postgres_directory" || die "Could not exclusively create PostgreSQL data directory"
    chown 70:70 "$postgres_directory"
  fi
  [[ -d "$postgres_directory" && ! -L "$postgres_directory" &&
    $(realpath -e -- "$postgres_directory") == "$postgres_directory" &&
    $(stat -c '%u:%g %a' "$postgres_directory") == '70:70 700' ]] ||
    die "PostgreSQL data directory identity mismatch"
}

require_restore_database() {
  [[ "$1" =~ ^slopproof_restore_[0-9]{8}_[0-9]{6}$ ]] ||
    die "Invalid restore database name"
}

restore_container_name() {
  [[ $# -eq 1 ]] || die "Invalid restore-container name request"
  require_release_id "$1"
  # One fixed Docker name is the atomic, host-wide restore semaphore. Even when
  # two releases race after the global absence check, only one create can win.
  printf '%s' 'slopproof-restore-global'
}

release_incoming() {
  printf '%s/%s.incoming' "$RELEASES_ROOT" "$1"
}

release_source() {
  local incoming="$(release_incoming "$1")/source" final="$(release_final "$1")/source"
  if [[ -d "$incoming" && ! -L "$incoming" && ! -e "$final" ]]; then
    printf '%s' "$incoming"
  elif [[ -d "$final" && ! -L "$final" && ! -e "$incoming" ]]; then
    printf '%s' "$final"
  else
    die "Release source is absent or ambiguous"
  fi
}

release_artifacts() {
  local incoming="$(release_incoming "$1")/artifacts" final="$(release_final "$1")/artifacts"
  if [[ -d "$incoming" && ! -L "$incoming" && ! -e "$final" ]]; then
    printf '%s' "$incoming"
  elif [[ -d "$final" && ! -L "$final" && ! -e "$incoming" ]]; then
    printf '%s' "$final"
  else
    die "Release artifacts are absent or ambiguous"
  fi
}

release_bundle() {
  local incoming="$(release_incoming "$1")" final="$(release_final "$1")"
  if [[ -d "$incoming" && ! -L "$incoming" && ! -e "$final" ]]; then
    printf '%s' "$incoming"
  elif [[ -d "$final" && ! -L "$final" && ! -e "$incoming" ]]; then
    printf '%s' "$final"
  else
    die "Release bundle is absent or ambiguous"
  fi
}

release_final() {
  printf '%s/%s' "$RELEASES_ROOT" "$1"
}

assert_exact_directory() {
  local actual expected=$1
  [[ -d "$expected" && ! -L "$expected" ]] || die "Missing safe directory: $expected"
  actual=$(realpath -- "$expected")
  [[ "$actual" == "$expected" ]] || die "Directory identity mismatch: $expected"
}

compose() {
  local release_id=$1 app_id postgres_id
  shift
  app_id=$(jq -er '.image.id' "$(release_source "$release_id")/.slopproof-release.json")
  postgres_id=$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")
  SLOPPROOF_SECRET_DIR="$SECRET_ROOT/$release_id" \
    SLOPPROOF_DATA_DIR="$DATA_ROOT" \
    SLOPPROOF_IMAGE="$app_id" \
    SLOPPROOF_POSTGRES_IMAGE="$postgres_id" \
    S3_PUBLIC_ENDPOINT='https://bf2f734c49e05a3ed1cbad16f0049e6c.eu.r2.cloudflarestorage.com' \
    COMPOSE_PROJECT_NAME=slopproof-production \
    docker compose -f "$(release_source "$release_id")/compose.production.yaml" "$@"
}

wait_release_stack() {
  local release_id=$1 timeout_seconds=$2 source app_id postgres_id
  source=$(release_source "$release_id")
  app_id=$(jq -er '.image.id' "$source/.slopproof-release.json")
  postgres_id=$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")
  (
    cd "$source"
    SLOPPROOF_SECRET_DIR="$SECRET_ROOT/$release_id" \
      SLOPPROOF_DATA_DIR="$DATA_ROOT" \
      SLOPPROOF_IMAGE="$app_id" \
      SLOPPROOF_POSTGRES_IMAGE="$postgres_id" \
      S3_PUBLIC_ENDPOINT='https://bf2f734c49e05a3ed1cbad16f0049e6c.eu.r2.cloudflarestorage.com' \
      COMPOSE_PROJECT_NAME=slopproof-production \
      ./scripts/production-deploy/wait-ready.sh stack "$timeout_seconds"
  )
}

assert_staged_release_images() {
  local release_id=$1 source app_id postgres_id
  source=$(release_source "$release_id")
  app_id=$(jq -er '.image.id' "$source/.slopproof-release.json")
  postgres_id=$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")
  SLOPPROOF_IMAGE="$app_id" \
    SLOPPROOF_POSTGRES_IMAGE="$postgres_id" \
    "$source/scripts/production-deploy/verify-runtime-release.sh" images >/dev/null
}

assert_release_container_images() {
  local release_id=$1 source app_id postgres_id
  shift
  source=$(release_source "$release_id")
  app_id=$(jq -er '.image.id' "$source/.slopproof-release.json")
  postgres_id=$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")
  SLOPPROOF_IMAGE="$app_id" \
    SLOPPROOF_POSTGRES_IMAGE="$postgres_id" \
    "$source/scripts/production-deploy/verify-runtime-release.sh" containers "$@" >/dev/null
}

verify_release() {
  local release_id=$1 source
  source=$(release_source "$release_id")
  [[ -d "$source" && ! -L "$source" ]] || die "Missing incoming release source"
  node "$source/scripts/production-deploy/prepare-release.mjs" verify \
    --bundle "$(release_bundle "$release_id")"
}

verify_secret_set() {
  local release_id=$1 secret_directory="$SECRET_ROOT/$release_id" path actual expected
  assert_exact_directory "$secret_directory"
  [[ $(stat -c '%U:%G' "$secret_directory") == 'root:root' ]] ||
    die "Secret set must be root-owned"
  actual=$(getfacl -cpn "$secret_directory" | sed '/^$/d' | LC_ALL=C sort)
  expected=$(printf '%s\n' 'user::rwx' 'user:70:--x' 'user:1000:--x' 'group::---' 'mask::--x' 'other::---' | LC_ALL=C sort)
  [[ "$actual" == "$expected" ]] || die "Secret directory ACL mismatch"
  for path in web.env worker.env github-control.env migrate.env proxy.env \
    github-app.pem wrapping-private.pem postgres-password oauth-proxy-authenticator; do
    [[ -f "$secret_directory/$path" && ! -L "$secret_directory/$path" ]] ||
      die "Missing protected secret artifact: $path"
    [[ $(stat -c '%U:%G' "$secret_directory/$path") == 'root:root' ]] ||
      die "Private secret artifact owner mismatch: $path"
  done
  [[ -f "$secret_directory/wrapping-public.pem" && ! -L "$secret_directory/wrapping-public.pem" ]] ||
    die "Missing public wrapping key"
  [[ $(stat -c '%U:%G' "$secret_directory/wrapping-public.pem") == 'root:root' ]] ||
    die "Public wrapping key owner mismatch"
  for path in web.env worker.env github-control.env migrate.env github-app.pem wrapping-private.pem; do
    actual=$(getfacl -cpn "$secret_directory/$path" | sed '/^$/d' | LC_ALL=C sort)
    expected=$(printf '%s\n' 'user::rw-' 'user:1000:r--' 'group::---' 'mask::r--' 'other::---' | LC_ALL=C sort)
    [[ "$actual" == "$expected" ]] || die "Application secret ACL mismatch: $path"
  done
  actual=$(getfacl -cpn "$secret_directory/wrapping-public.pem" | sed '/^$/d' | LC_ALL=C sort)
  expected=$(printf '%s\n' 'user::rw-' 'user:1000:r--' 'group::r--' 'mask::r--' 'other::r--' | LC_ALL=C sort)
  [[ "$actual" == "$expected" ]] || die "Public wrapping key ACL mismatch"
  actual=$(getfacl -cpn "$secret_directory/postgres-password" | sed '/^$/d' | LC_ALL=C sort)
  expected=$(printf '%s\n' 'user::rw-' 'user:70:r--' 'group::---' 'mask::r--' 'other::---' | LC_ALL=C sort)
  [[ "$actual" == "$expected" ]] || die "PostgreSQL password ACL mismatch"
  for path in proxy.env oauth-proxy-authenticator; do
    actual=$(getfacl -cpn "$secret_directory/$path" | sed '/^$/d' | LC_ALL=C sort)
    expected=$(printf '%s\n' 'user::rw-' 'group::---' 'other::---' | LC_ALL=C sort)
    [[ "$actual" == "$expected" ]] || die "Caddy-only secret ACL mismatch: $path"
  done
}

phase_preflight() {
  require_root
  local live_caddy_hash compose_unit_hash expected_managed_unit
  for command in awk docker dpkg-query jq node sshd caddy rsync sha256sum systemctl curl findmnt realpath stat sync setfacl getfacl; do
    require_command "$command"
  done
  assert_exact_directory "$RELEASES_ROOT"
  assert_exact_directory "$SHARED_ROOT"
  assert_exact_directory "$SECRET_ROOT"
  assert_production_data_root
  [[ $(uname -m) == x86_64 ]] || die "Production host must be x86_64"
  docker version >/dev/null
  docker compose version >/dev/null
  caddy version >/dev/null
  systemctl is-active --quiet docker
  systemctl is-active --quiet caddy
  require_bootstrapped_host
  live_caddy_hash=$(sha256sum "$CADDYFILE" | awk '{print $1}')
  if [[ "$live_caddy_hash" != "$EXPECTED_CADDY_SHA256" ]]; then
    grep -Fxq '# BEGIN SLOPPROOF MANAGED SITE v1' "$CADDYFILE" ||
      die "Live Caddyfile is neither the audited initial state nor a managed release"
    grep -Fq '{file./run/credentials/caddy.service/oauth-proxy-authenticator}' "$CADDYFILE" ||
      die "Managed Caddyfile lost its runtime credential boundary"
    ! grep -Fq '{$OAUTH_TRUSTED_PROXY_SECRET}' "$CADDYFILE" ||
      die "Managed Caddyfile contains a parse-time secret"
    caddy validate --config "$CADDYFILE" --adapter caddyfile
  fi
  [[ $(sha256sum /lib/systemd/system/caddy.service | awk '{print $1}') == "$EXPECTED_CADDY_UNIT_SHA256" ]] ||
    die "Distribution Caddy unit changed since the read-only preflight"
  if [[ -e "$COMPOSE_UNIT" ]]; then
    compose_unit_hash=$(sha256sum "$COMPOSE_UNIT" | awk '{print $1}')
    expected_managed_unit=$(sha256sum "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)/infra/systemd/slopproof-compose.service" | awk '{print $1}')
    [[ "$compose_unit_hash" == "$EXPECTED_SLOPPROOF_UNIT_SHA256" || "$compose_unit_hash" == "$expected_managed_unit" ]] ||
      die "Existing SlopProof unit changed since the read-only preflight"
  fi
  ! docker ps --filter name=slopproof --format '{{.Ports}}' |
    grep -Eq '(^|, )(0\.0\.0\.0|\[::\]|::):[0-9]+->' ||
    die "A SlopProof container publishes a non-loopback host port"
  df -Pk "$APP_ROOT" /var/lib
  free -m
  systemctl --no-pager --plain --type=service --state=running
  printf '%s\n' "Read-only production preflight passed."
}

phase_prepare_remote() {
  require_root
  local release_id=${1:-}
  require_release_id "$release_id"
  local incoming
  incoming=$(release_incoming "$release_id")
  [[ ! -e "$incoming" && ! -e "$(release_final "$release_id")" ]] ||
    die "Release path already exists"
  install -d -o root -g root -m 0700 "$incoming" "$incoming/source" "$incoming/artifacts"
  printf '%s\n' "Prepared empty incoming release $release_id."
}

phase_install() {
  require_root
  local release_id=${1:-} compiled_secret_directory=${2:-}
  require_release_id "$release_id"
  [[ "$compiled_secret_directory" == /* ]] || die "Compiled secret path must be absolute"
  verify_release "$release_id"
  local secret_directory="$SECRET_ROOT/$release_id" source artifact_count
  [[ "$compiled_secret_directory" == "$SECRET_ROOT/.incoming-$release_id" ]] ||
    die "Compiled secrets must use the exact protected incoming path"
  assert_exact_directory "$compiled_secret_directory"
  [[ ! -e "$secret_directory" ]] || die "Secret release path already exists"
  artifact_count=$(find "$compiled_secret_directory" -mindepth 1 -maxdepth 1 -type f -links 1 | wc -l)
  [[ "$artifact_count" -eq 9 ]] || die "Compiled secret set must contain exactly nine files"
  [[ -z $(find "$compiled_secret_directory" -mindepth 1 -maxdepth 1 ! -type f -print -quit) ]] ||
    die "Compiled secret set contains a non-regular artifact"
  for source in web.env worker.env github-control.env proxy.env migrate.env \
    github-app.pem wrapping-private.pem wrapping-public.pem postgres-password; do
    [[ -f "$compiled_secret_directory/$source" && ! -L "$compiled_secret_directory/$source" ]] ||
      die "Compiled secret artifact missing: $source"
  done
  chown -R root:root "$compiled_secret_directory"
  chmod 0700 "$compiled_secret_directory"
  chmod 0600 "$compiled_secret_directory"/{web.env,worker.env,github-control.env,proxy.env,migrate.env,github-app.pem,wrapping-private.pem,postgres-password}
  chmod 0644 "$compiled_secret_directory/wrapping-public.pem"
  node "$(release_source "$release_id")/scripts/production-deploy/prepare-caddy-credential.mjs" \
    "$compiled_secret_directory/proxy.env" "$compiled_secret_directory/oauth-proxy-authenticator"
  setfacl -m u:1000:--x,u:70:--x "$compiled_secret_directory"
  setfacl -m u:1000:r-- \
    "$compiled_secret_directory"/{web.env,worker.env,github-control.env,migrate.env,github-app.pem,wrapping-private.pem,wrapping-public.pem}
  setfacl -m u:70:r-- "$compiled_secret_directory/postgres-password"
  mv -- "$compiled_secret_directory" "$secret_directory"
  verify_secret_set "$release_id"
  chown -R root:root "$(release_incoming "$release_id")"
  find "$(release_incoming "$release_id")" -type d -exec chmod 0700 {} +
  find "$(release_source "$release_id")" -type f -exec chmod 0600 {} +
  while IFS= read -r executable; do chmod 0700 "$(release_source "$release_id")/$executable"; done < <(
    jq -r '.files[] | select(.mode == "100755") | .path' \
      "$(release_source "$release_id")/.slopproof-source-manifest.json"
  )
  verify_release "$release_id"
  printf '%s\n' "Installed immutable release and protected secret set $release_id."
}

phase_image_stage() {
  require_root
  local release_id=${1:-} manifest archive app_tag app_id loaded postgres_id receipt manifest_sha256
  require_release_id "$release_id"
  verify_release "$release_id"
  manifest="$(release_source "$release_id")/.slopproof-release.json"
  archive="$(release_artifacts "$release_id")/$(jq -er '.image.archive' "$manifest")"
  app_tag=$(jq -er '.image.tag' "$manifest")
  app_id=$(jq -er '.image.id' "$manifest")
  manifest_sha256=$(sha256sum "$manifest" | awk '{print $1}')
  receipt="$(release_incoming "$release_id")/.image-stage-receipt.json"
  [[ ! -e "$receipt" && ! -L "$receipt" ]] || die "Image staging receipt already exists"
  loaded=$(timeout --signal=TERM --kill-after=10s 240 docker load --input "$archive")
  [[ "$loaded" == "Loaded image: $app_tag" || "$loaded" == *"Loaded image ID: $app_id"* ]] ||
    die "Docker did not load the expected application identity"
  [[ $(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$app_tag") == "$app_id linux/amd64" &&
    $(docker image inspect --platform linux/amd64 --format '{{.Os}}/{{.Architecture}}' "$app_tag") == 'linux/amd64' ]] ||
    die "Loaded application image identity mismatch"
  timeout --signal=TERM --kill-after=10s 240 docker pull --platform linux/amd64 "$POSTGRES_IMAGE" >/dev/null
  [[ $(docker image inspect --platform linux/amd64 --format '{{.Os}}/{{.Architecture}}' "$POSTGRES_IMAGE") == 'linux/amd64' ]] ||
    die "PostgreSQL platform mismatch"
  docker image inspect --format '{{json .RepoDigests}}' "$POSTGRES_IMAGE" |
    jq -e --arg digest "${POSTGRES_IMAGE#*@}" 'any(.[]; endswith("@" + $digest))' >/dev/null ||
    die "PostgreSQL RepoDigest mismatch"
  postgres_id=$(docker image inspect --format '{{.Id}}' "$POSTGRES_IMAGE")
  [[ "$postgres_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die "PostgreSQL image ID is invalid"
  set -o noclobber
  jq -n --arg releaseId "$release_id" --arg manifestSha256 "$manifest_sha256" \
    --arg appTag "$app_tag" --arg appId "$app_id" \
    --arg postgresImage "$POSTGRES_IMAGE" --arg postgresId "$postgres_id" \
    --arg stagedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schema:"slopproof.image-stage.v2",releaseId:$releaseId,manifestSha256:$manifestSha256,appTag:$appTag,appId:$appId,appPlatform:"linux/amd64",postgresImage:$postgresImage,postgresId:$postgresId,postgresPlatform:"linux/amd64",stagedAt:$stagedAt}' \
    > "$receipt"
  set +o noclobber
  chmod 0600 "$receipt"
  sync -f "$receipt"
  sync -f "$(release_incoming "$release_id")"
  assert_staged_release_images "$release_id"
  printf '%s\n' "Staged exact application and PostgreSQL images."
}

phase_postgres_only() {
  require_root
  local release_id=${1:-} container_id data_identity
  require_release_id "$release_id"
  verify_release "$release_id"
  verify_secret_set "$release_id"
  assert_staged_release_images "$release_id"
  ensure_postgres_data_directory
  data_identity=$(stat -Lc '%d:%i:%u:%g:%a' "$DATA_ROOT/postgres")
  compose "$release_id" config --no-interpolate --quiet
  compose "$release_id" config --quiet
  compose "$release_id" up -d --no-build --pull never postgres
  container_id=$(compose "$release_id" ps -q postgres)
  "$(release_source "$release_id")/scripts/production-deploy/wait-ready.sh" \
    container-health "$container_id" 180
  assert_release_container_images "$release_id" postgres
  [[ $(realpath -e -- "$DATA_ROOT/postgres") == "$DATA_ROOT/postgres" &&
    $(stat -Lc '%d:%i:%u:%g:%a' "$DATA_ROOT/postgres") == "$data_identity" ]] ||
    die "PostgreSQL data directory changed during startup"
  [[ -z $(compose "$release_id" ps -q web worker github-control 2>/dev/null) ]] ||
    die "Application services started before migration boundary"
  printf '%s\n' "PostgreSQL is healthy and remains unpublished."
}

phase_migrate_start() {
  require_root
  local release_id=${1:-} verified_backup_receipt=${2:-} container_id release_commit image_id
  local backup_timestamp restore_completed_at verified_at now_epoch backup_epoch restore_epoch verified_epoch
  require_release_id "$release_id"
  verify_release "$release_id"
  verify_secret_set "$release_id"
  assert_staged_release_images "$release_id"
  [[ "$verified_backup_receipt" == "$SHARED_ROOT/backup-receipt-$release_id.verified.json" ]] ||
    die "Expected the exact local-verifier output receipt path"
  [[ -f "$verified_backup_receipt" && ! -L "$verified_backup_receipt" ]] ||
    die "Verified backup receipt is absent"
  [[ $(stat -c '%U:%G %a' "$verified_backup_receipt") == 'root:root 600' ]] ||
    die "Verified backup receipt must be root:root mode 0600"
  release_commit=$(jq -er '.commit' "$(release_source "$release_id")/.slopproof-release.json")
  image_id=$(jq -er '.image.id' "$(release_source "$release_id")/.slopproof-release.json")
  jq -e --arg release_id "$release_id" --arg commit "$release_commit" --arg image_id "$image_id" \
    'keys == ["backupTimestamp","ciphertextSha256","commit","imageDigest","releaseId","restoreCompletedAt","schema","status","verifiedAt","verifier"] and
     .schema == "slopproof.verified-backup-boundary.v1" and
     .releaseId == $release_id and .commit == $commit and .imageDigest == $image_id and
     .verifier == "scripts/production-backup/verify-receipt.mjs" and
     .status == "passed" and (.ciphertextSha256 | test("^[0-9a-f]{64}$")) and
     (.backupTimestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
     (.restoreCompletedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
     (.verifiedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' \
    "$verified_backup_receipt" >/dev/null || die "Backup verification boundary mismatch"
  backup_timestamp=$(jq -er '.backupTimestamp' "$verified_backup_receipt")
  restore_completed_at=$(jq -er '.restoreCompletedAt' "$verified_backup_receipt")
  verified_at=$(jq -er '.verifiedAt' "$verified_backup_receipt")
  now_epoch=$(date -u +%s)
  backup_epoch=$(date -u -d "$backup_timestamp" +%s) || die "Backup timestamp is invalid"
  restore_epoch=$(date -u -d "$restore_completed_at" +%s) || die "Restore completion timestamp is invalid"
  verified_epoch=$(date -u -d "$verified_at" +%s) || die "Backup verification timestamp is invalid"
  [[ "$backup_epoch" -le "$restore_epoch" && "$restore_epoch" -le "$verified_epoch" &&
    $((now_epoch - backup_epoch)) -ge 0 && $((now_epoch - backup_epoch)) -le 900 &&
    $((now_epoch - restore_epoch)) -ge 0 && $((now_epoch - restore_epoch)) -le 900 &&
    $((now_epoch - verified_epoch)) -ge 0 && $((now_epoch - verified_epoch)) -le 900 ]] ||
    die "Backup, restore, or verification evidence is stale"
  compose "$release_id" up -d --no-build --pull never migrate
  container_id=$(compose "$release_id" ps -a -q migrate)
  "$(release_source "$release_id")/scripts/production-deploy/wait-ready.sh" \
    container-exit-zero "$container_id" 180
  assert_release_container_images "$release_id" postgres migrate
  assert_staged_release_images "$release_id"
  compose "$release_id" up -d --no-build --pull never worker github-control web \
    --wait --wait-timeout 240
  assert_release_container_images "$release_id" postgres migrate worker github-control web
  wait_release_stack "$release_id" 240
  printf '%s\n' "Migration and internal application readiness passed."
}

phase_backup_compose() {
  require_root
  local release_id=${1:-}
  shift
  require_release_id "$release_id"
  require_bootstrapped_host
  # This phase is a byte-transparent transport for psql/pg_dump stdout.
  # Keep release verification fail-closed without mixing its status line into
  # the database stream consumed by the local validator or CMS encryptor.
  verify_release "$release_id" >/dev/null
  verify_secret_set "$release_id"
  assert_staged_release_images "$release_id"
  [[ $# -ge 4 && $1 == exec && $2 == -T && $3 == postgres ]] ||
    die "backup-compose permits only noninteractive PostgreSQL exec"
  case "$4" in
    pg_dump)
      [[ $# -eq 9 && $5 == --username=slopproof && $6 == --dbname=slopproof &&
        $7 == --format=custom && $8 == --no-owner && $9 == --no-acl ]] ||
        die "Invalid production pg_dump arguments"
      ;;
    psql)
      [[ $# -eq 12 && $5 == --username=slopproof && $6 == --dbname=slopproof &&
        $7 == --no-psqlrc && $8 == --quiet && $9 == --tuples-only &&
        ${10} == --no-align && ${11} == --set=ON_ERROR_STOP=1 && ${12} == --file=- ]] ||
        die "Invalid production audit psql arguments"
      ;;
    *) die "backup-compose command is not allowlisted" ;;
  esac
  local container_id
  container_id=$(compose "$release_id" ps -q postgres)
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || die "PostgreSQL container is absent"
  [[ $(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container_id") == 'running healthy' ]] ||
    die "PostgreSQL is not healthy"
  assert_release_container_images "$release_id" postgres
  compose "$release_id" "$@"
}

assert_restore_container() {
  local release_id=$1 restore_database=$2 postgres_image_id=$3 container_name
  container_name=$(restore_container_name "$release_id")
  if ! timeout --signal=TERM --kill-after=5s 30 docker inspect "$container_name" 2>/dev/null |
    jq -e --arg name "/$container_name" --arg release_id "$release_id" \
      --arg restore_database "$restore_database" --arg image_id "$postgres_image_id" '
      length == 1 and
      .[0].Name == $name and
      .[0].Image == $image_id and
      .[0].Config.Image == $image_id and
      .[0].Config.User == "70:70" and
      .[0].Config.Labels["com.slopproof.restore.release"] == $release_id and
      .[0].Config.Labels["com.slopproof.restore.database"] == $restore_database and
      (.[0].Config.Labels["com.slopproof.restore.owner"] |
        test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) and
      .[0].HostConfig.NetworkMode == "none" and
      .[0].HostConfig.LogConfig.Type == "none" and
      .[0].LogPath == "" and
      .[0].HostConfig.ReadonlyRootfs == true and
      .[0].HostConfig.Privileged == false and
      .[0].HostConfig.PublishAllPorts == false and
      .[0].HostConfig.PortBindings == {} and
      .[0].HostConfig.RestartPolicy.Name == "no" and
      .[0].HostConfig.Memory == 1073741824 and
      .[0].HostConfig.MemorySwap == 1073741824 and
      .[0].HostConfig.NanoCpus == 500000000 and
      .[0].HostConfig.PidsLimit == 192 and
      .[0].HostConfig.ShmSize == 67108864 and
      (.[0].HostConfig.Binds == null or .[0].HostConfig.Binds == []) and
      (.[0].HostConfig.Mounts == null or .[0].HostConfig.Mounts == []) and
      (.[0].HostConfig.CapDrop | sort) == ["ALL"] and
      (.[0].HostConfig.SecurityOpt | any(startswith("no-new-privileges"))) and
      (.[0].HostConfig.Ulimits | any(.Name == "core" and .Soft == 0 and .Hard == 0)) and
      (.[0].HostConfig.Tmpfs | keys | sort) ==
        ["/tmp", "/var/lib/postgresql", "/var/run/postgresql"] and
      (.[0].HostConfig.Tmpfs["/var/lib/postgresql"] as $options |
        ($options | contains("noexec")) and ($options | contains("nosuid")) and
        ($options | contains("nodev")) and ($options | contains("uid=70")) and
        ($options | contains("gid=70")) and
        (($options | contains("size=768m")) or ($options | contains("size=805306368")))) and
      (.[0].HostConfig.Tmpfs["/var/run/postgresql"] as $options |
        ($options | contains("noexec")) and ($options | contains("nosuid")) and
        ($options | contains("nodev")) and
        (($options | contains("size=16m")) or ($options | contains("size=16777216")))) and
      (.[0].HostConfig.Tmpfs["/tmp"] as $options |
        ($options | contains("noexec")) and ($options | contains("nosuid")) and
        ($options | contains("nodev")) and
        (($options | contains("size=64m")) or ($options | contains("size=67108864")))) and
      (.[0].Mounts | length) == 0 and
      .[0].NetworkSettings.Ports == {} and
      .[0].Config.StopTimeout == 30 and
      (.[0].Config.Env | all(test("^POSTGRES_(?:PASSWORD|PASSWORD_FILE)=") | not)) and
      (.[0].Config.Env | index("PGDATA=/var/lib/postgresql/data")) != null and
      (.[0].Config.Env | index("POSTGRES_INITDB_WALDIR=/var/lib/postgresql/wal")) != null and
      (.[0].Config.Cmd | index("logging_collector=off")) != null and
      (.[0].Config.Cmd | index("log_statement=none")) != null and
      (.[0].Config.Cmd | index("log_min_error_statement=fatal")) != null and
      (.[0].Config.Cmd | index("log_parameter_max_length=0")) != null and
      (.[0].Config.Cmd | index("log_parameter_max_length_on_error=0")) != null
    ' >/dev/null; then
    die "Restore-only PostgreSQL container identity mismatch"
  fi
}

assert_restore_absent() {
  local release_id=$1 container_name matching
  container_name=$(restore_container_name "$release_id")
  ! timeout --signal=TERM --kill-after=5s 30 docker container inspect "$container_name" >/dev/null 2>&1 ||
    die "Restore-only PostgreSQL container still exists"
  matching=$(timeout --signal=TERM --kill-after=5s 30 docker ps -aq \
    --filter "label=com.slopproof.restore.release=$release_id")
  [[ -z "$matching" ]] || die "A release-bound restore-only container still exists"
}

assert_all_restore_containers_absent() {
  local matching container_name='slopproof-restore-global'
  ! timeout --signal=TERM --kill-after=5s 30 docker container inspect "$container_name" >/dev/null 2>&1 ||
    die "The global restore-only PostgreSQL container name is already reserved"
  matching=$(timeout --signal=TERM --kill-after=5s 30 docker ps -aq \
    --filter label=com.slopproof.restore.release)
  [[ -z "$matching" ]] ||
    die "A stale restore-only PostgreSQL container must be removed before another rehearsal"
}

phase_restore_start() {
  require_root
  local release_id=${1:-} restore_database=${2:-} container_name postgres_image_id owner_token
  local cleanup_identity='' started_container_id='' creation_attempted=false ready=false
  require_release_id "$release_id"
  require_restore_database "$restore_database"
  require_bootstrapped_host
  verify_release "$release_id"
  assert_staged_release_images "$release_id"
  postgres_image_id=$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")
  container_name=$(restore_container_name "$release_id")
  assert_all_restore_containers_absent
  owner_token=''
  IFS= read -r owner_token < /proc/sys/kernel/random/uuid ||
    die "Restore-only ownership token generation failed"
  [[ "$owner_token" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
    die "Restore-only ownership token generation failed"
  cleanup_failed_restore_start() {
    local status=${1:-$?}
    trap - EXIT HUP INT TERM
    if [[ "$creation_attempted" == true ]]; then
      cleanup_identity=$(timeout --signal=TERM --kill-after=5s 10 docker inspect \
        --format '{{index .Config.Labels "com.slopproof.restore.owner"}}|{{index .Config.Labels "com.slopproof.restore.release"}}|{{index .Config.Labels "com.slopproof.restore.database"}}|{{.Image}}' \
        "$container_name" 2>/dev/null || true)
      if [[ "$cleanup_identity" == "$owner_token|$release_id|$restore_database|$postgres_image_id" ]]; then
        timeout --signal=KILL 30 docker rm --force --volumes "$container_name" >/dev/null 2>&1 ||
          printf '%s\n' "Owned restore-only PostgreSQL cleanup failed." >&2
      fi
    fi
    exit "$status"
  }
  trap 'cleanup_failed_restore_start $?' EXIT
  trap 'cleanup_failed_restore_start 129' HUP
  trap 'cleanup_failed_restore_start 130' INT
  trap 'cleanup_failed_restore_start 143' TERM
  creation_attempted=true
  if ! started_container_id=$(timeout --signal=TERM --kill-after=10s 90 docker run --detach \
    --name "$container_name" \
    --pull never \
    --label "com.slopproof.restore.release=$release_id" \
    --label "com.slopproof.restore.database=$restore_database" \
    --label "com.slopproof.restore.owner=$owner_token" \
    --platform linux/amd64 \
    --network none \
    --log-driver none \
    --user 70:70 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --ulimit core=0:0 \
    --cpus 0.5 \
    --memory 1024m \
    --memory-swap 1024m \
    --pids-limit 192 \
    --shm-size 64m \
    --stop-timeout 30 \
    --tmpfs /var/lib/postgresql:rw,noexec,nosuid,nodev,size=768m,uid=70,gid=70,mode=0700 \
    --tmpfs /var/run/postgresql:rw,noexec,nosuid,nodev,size=16m,uid=70,gid=70,mode=3770 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=70,gid=70,mode=1770 \
    --env PGDATA=/var/lib/postgresql/data \
    --env POSTGRES_INITDB_WALDIR=/var/lib/postgresql/wal \
    --env POSTGRES_USER=slopproof \
    --env "POSTGRES_DB=$restore_database" \
    --env POSTGRES_HOST_AUTH_METHOD=trust \
    "$postgres_image_id" postgres \
      -c listen_addresses= \
      -c logging_collector=off \
      -c log_destination=stderr \
      -c log_statement=none \
      -c log_min_duration_statement=-1 \
      -c log_duration=off \
      -c log_connections=off \
      -c log_disconnections=off \
      -c log_error_verbosity=terse \
      -c log_min_messages=fatal \
      -c log_min_error_statement=fatal \
      -c log_parameter_max_length=0 \
      -c log_parameter_max_length_on_error=0 \
      -c log_transaction_sample_rate=0 \
      -c log_statement_sample_rate=0 \
      -c log_min_duration_sample=-1 \
      2>/dev/null); then
    die "Restore-only PostgreSQL container failed to start"
  fi
  [[ "$started_container_id" =~ ^[0-9a-f]{64}$ ]] ||
    die "Restore-only PostgreSQL returned an invalid container identity"
  assert_restore_container "$release_id" "$restore_database" "$postgres_image_id"
  for _ in $(seq 1 45); do
    if timeout --signal=TERM --kill-after=5s 10 docker exec "$container_name" \
      pg_isready --username=slopproof \
      --dbname="$restore_database" >/dev/null 2>&1; then
      ready=true
      break
    fi
    [[ $(timeout --signal=TERM --kill-after=5s 10 docker inspect \
      --format '{{.State.Running}}' "$container_name" 2>/dev/null) == true ]] || break
    sleep 2
  done
  [[ "$ready" == true ]] || die "Restore-only PostgreSQL did not become ready"
  timeout --signal=TERM --kill-after=5s 10 docker exec "$container_name" /bin/sh -ceu \
    'test "$(ulimit -S -c)" = 0 && test "$(ulimit -H -c)" = 0' >/dev/null 2>&1 ||
    die "Restore-only PostgreSQL effective core limit is not zero"
  trap - EXIT HUP INT TERM
  printf '%s\n' "Restore-only PostgreSQL is ready in bounded tmpfs."
}

phase_restore_exec() {
  require_root
  local release_id=${1:-} restore_database=${2:-} command=${3:-} container_name postgres_image_id
  require_release_id "$release_id"
  require_restore_database "$restore_database"
  shift 3
  case "$command" in
    pg_restore)
      [[ $# -eq 7 ]] || die "Invalid restore-only pg_restore arguments"
      [[ $1 == --username=slopproof && $2 == --no-password &&
        $3 == --exit-on-error && $4 == --single-transaction && $5 == --no-owner &&
        $6 == --no-acl && $7 == "--dbname=$restore_database" ]] ||
        die "Invalid restore-only pg_restore arguments"
      ;;
    psql)
      [[ $# -eq 9 ]] || die "Invalid restore-only psql arguments"
      [[ $1 == --username=slopproof && $2 == --no-password &&
        $3 == "--dbname=$restore_database" && $4 == --no-psqlrc && $5 == --quiet &&
        $6 == --tuples-only && $7 == --no-align && $8 == --set=ON_ERROR_STOP=1 &&
        $9 == --file=- ]] ||
        die "Invalid restore-only psql arguments"
      ;;
    *) die "Restore-only command is not allowlisted" ;;
  esac
  container_name=$(restore_container_name "$release_id")
  assert_staged_release_images "$release_id"
  postgres_image_id=$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")
  assert_restore_container "$release_id" "$restore_database" "$postgres_image_id"
  [[ $(timeout --signal=TERM --kill-after=5s 10 docker inspect \
    --format '{{.State.Running}}' "$container_name" 2>/dev/null) == true ]] ||
    die "Restore-only PostgreSQL is not running"
  timeout --signal=TERM --kill-after=10s 1800 docker exec --interactive \
    --env 'PGOPTIONS=-c log_statement=none -c log_min_error_statement=fatal -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0' \
    "$container_name" "$command" "$@"
}

phase_restore_stop() {
  require_root
  local release_id=${1:-} restore_database=${2:-} container_name postgres_image_id
  require_release_id "$release_id"
  require_restore_database "$restore_database"
  container_name=$(restore_container_name "$release_id")
  assert_staged_release_images "$release_id"
  postgres_image_id=$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")
  assert_restore_container "$release_id" "$restore_database" "$postgres_image_id"
  if [[ $(timeout --signal=TERM --kill-after=5s 10 docker inspect \
    --format '{{.State.Running}}' "$container_name" 2>/dev/null) == true ]]; then
    timeout --signal=TERM --kill-after=10s 60 docker stop --time 30 "$container_name" >/dev/null 2>&1 ||
      die "Restore-only PostgreSQL did not stop cleanly"
  fi
  timeout --signal=TERM --kill-after=5s 30 docker rm --volumes "$container_name" >/dev/null 2>&1 ||
    die "Restore-only PostgreSQL container removal failed"
  assert_restore_absent "$release_id"
  printf '%s\n' "Restore-only PostgreSQL tmpfs state was removed."
}

phase_restore_absent() {
  require_root
  local release_id=${1:-} restore_database=${2:-}
  require_release_id "$release_id"
  require_restore_database "$restore_database"
  assert_restore_absent "$release_id"
  printf '%s\n' "Restore-only PostgreSQL container is absent."
}

phase_initial_caddy_cutover() {
  require_root
  local release_id=${1:-}
  require_release_id "$release_id"
  wait_release_stack "$release_id" 60
  [[ $(sha256sum "$CADDYFILE" | awk '{print $1}') == "$EXPECTED_CADDY_SHA256" ]] ||
    die "Live Caddyfile precondition changed"
  local backup="$SHARED_ROOT/caddy-backup-$release_id" candidate="$ETC_ROOT/Caddyfile.$release_id.candidate"
  local caddy_prefix="$backup/preserved-prefix.Caddyfile" caddy_block="$backup/current-slopproof.Caddyfile"
  local previous previous_resolved backup_boundary release_manifest rollback_boundary
  [[ ! -e "$backup" && ! -e "$candidate" ]] || die "Caddy backup or candidate already exists"
  install -d -o root -g root -m 0700 "$backup"
  install -o root -g root -m 0600 "$CADDYFILE" "$backup/Caddyfile"
  sed -n '1,108p' "$CADDYFILE" > "$caddy_prefix"
  sed -n '109,$p' "$CADDYFILE" > "$caddy_block"
  chmod 0600 "$caddy_prefix" "$caddy_block"
  [[ $(sha256sum "$caddy_prefix" | awk '{print $1}') == "$EXPECTED_CADDY_PREFIX_SHA256" ]] ||
    die "Caddy prefix snapshot mismatch"
  [[ $(sha256sum "$caddy_block" | awk '{print $1}') == "$EXPECTED_CADDY_BLOCK_SHA256" ]] ||
    die "Caddy site snapshot mismatch"
  cmp -s "$CADDYFILE" <(cat "$caddy_prefix" "$caddy_block") ||
    die "Caddy snapshot reconstruction mismatch"
  install -o root -g root -m 0600 /lib/systemd/system/caddy.service "$backup/caddy.service"
  if [[ -e "$CADDY_DROPIN" ]]; then
    install -o root -g root -m 0600 "$CADDY_DROPIN" "$backup/10-slopproof-credential.conf"
  else
    : > "$backup/caddy-dropin-absent"
  fi
  if [[ -L "$SECRET_ROOT/current" ]]; then
    readlink "$SECRET_ROOT/current" > "$backup/previous-secret-current"
  else
    : > "$backup/previous-secret-current-absent"
  fi
  if [[ -L "$CURRENT_LINK" ]]; then
    previous=$(readlink "$CURRENT_LINK")
    printf '%s\n' "$previous" > "$backup/previous-application-current"
  else
    previous=''
    : > "$backup/previous-application-current-absent"
  fi
  previous_resolved=$(realpath -e -- "$CURRENT_LINK" 2>/dev/null || true)
  [[ "$previous_resolved" =~ ^/opt/slopproof/releases/bootstrap-[0-9]{8}-[0-9]{4}$ ]] ||
    die "Initial cutover requires the exact audited bootstrap boundary"
  if [[ -f "$ETC_ROOT/release.env" && ! -L "$ETC_ROOT/release.env" ]]; then
    install -o root -g root -m 0600 "$ETC_ROOT/release.env" "$backup/release.env"
  else
    : > "$backup/release-env-absent"
  fi
  if [[ -f "$COMPOSE_UNIT" && ! -L "$COMPOSE_UNIT" ]]; then
    install -o root -g root -m 0600 "$COMPOSE_UNIT" "$backup/slopproof-compose.service"
  else
    : > "$backup/slopproof-unit-absent"
  fi

  # Publish the rollback receipt before the first public Caddy mutation. This
  # keeps rollback executable even if finalize fails before the incoming
  # release is renamed.
  backup_boundary="$SHARED_ROOT/backup-receipt-$release_id.verified.json"
  release_manifest="$(release_source "$release_id")/.slopproof-release.json"
  rollback_boundary="$(release_incoming "$release_id")/.rollback-boundary.json"
  [[ -f "$backup_boundary" && ! -L "$backup_boundary" &&
    ! -e "$rollback_boundary" && ! -L "$rollback_boundary" ]] ||
    die "Rollback database boundary state is invalid"
  jq -e --arg release_id "$release_id" \
    --arg commit "$(jq -er '.commit' "$release_manifest")" \
    --arg image_id "$(jq -er '.image.id' "$release_manifest")" \
    'keys == ["backupTimestamp","ciphertextSha256","commit","imageDigest","releaseId","restoreCompletedAt","schema","status","verifiedAt","verifier"] and
     .schema == "slopproof.verified-backup-boundary.v1" and
     .releaseId == $release_id and .commit == $commit and .imageDigest == $image_id and
     .status == "passed" and .verifier == "scripts/production-backup/verify-receipt.mjs"' \
    "$backup_boundary" >/dev/null || die "Verified backup boundary does not match the release"
  set -o noclobber
  jq -n --arg previousRaw "$previous" --arg previous "$previous_resolved" \
    --arg releaseId "$release_id" --arg backupBoundary "$backup_boundary" \
    --arg backupSha "$(jq -er '.ciphertextSha256' "$backup_boundary")" \
    --arg backupTimestamp "$(jq -er '.backupTimestamp' "$backup_boundary")" \
    --arg restoreCompletedAt "$(jq -er '.restoreCompletedAt' "$backup_boundary")" \
    --arg backupVerifiedAt "$(jq -er '.verifiedAt' "$backup_boundary")" \
    '{schema:"slopproof.rollback-boundary.v1",previousCurrentRaw:$previousRaw,previousCurrent:$previous,releaseId:$releaseId,caddyBackup:("/opt/slopproof/shared/caddy-backup-"+$releaseId),database:{policy:"forward-only-separate-restore",verifiedBoundary:$backupBoundary,ciphertextSha256:$backupSha,backupTimestamp:$backupTimestamp,restoreCompletedAt:$restoreCompletedAt,verifiedAt:$backupVerifiedAt}}' \
    > "$rollback_boundary"
  set +o noclobber
  chmod 0600 "$rollback_boundary"
  sync -f "$rollback_boundary"
  sync -f "$(release_incoming "$release_id")"
  node "$(release_source "$release_id")/scripts/production-deploy/render-caddy.mjs" \
    --live "$CADDYFILE" --expected-live-sha256 "$EXPECTED_CADDY_SHA256" \
    --preserved-prefix "$caddy_prefix" --expected-prefix-sha256 "$EXPECTED_CADDY_PREFIX_SHA256" \
    --current-block "$caddy_block" --expected-block-sha256 "$EXPECTED_CADDY_BLOCK_SHA256" \
    --template "$(release_source "$release_id")/infra/caddy/Caddyfile.production" --output "$candidate"
  caddy validate --config "$candidate" --adapter caddyfile
  caddy adapt --config "$candidate" --adapter caddyfile --pretty > "$backup/candidate-adapted.json"
  grep -Fq '{file./run/credentials/caddy.service/oauth-proxy-authenticator}' \
    "$backup/candidate-adapted.json" || die "Caddy candidate lost the runtime file placeholder"
  ! grep -Fq -f "$SECRET_ROOT/$release_id/oauth-proxy-authenticator" \
    "$backup/candidate-adapted.json" || die "Caddy candidate contains the credential value"
  # The complete recovery material and candidate must survive power loss before
  # any boot-visible Caddy state is changed.
  sync -f "$backup"
  sync -f "$candidate"
  sync -f "$SHARED_ROOT"
  sync -f "$ETC_ROOT"
  sync -f "$SECRET_ROOT/$release_id"
  sync -f "$SECRET_ROOT"

  local mutation_started=false cutover_complete=false caddy_temporary dropin_temporary
  caddy_temporary="$(dirname "$CADDYFILE")/.Caddyfile.$release_id.tmp"
  dropin_temporary="$(dirname "$CADDY_DROPIN")/.10-slopproof-credential.$release_id.tmp"
  restore_failed_cutover() {
    local exit_status=${1:-$?}
    trap - EXIT HUP INT TERM
    if [[ "$mutation_started" == true && "$cutover_complete" != true ]]; then
      install -o root -g caddy -m 0640 "$backup/Caddyfile" "$caddy_temporary.restore"
      sync -f "$caddy_temporary.restore" || true
      mv -Tf "$caddy_temporary.restore" "$CADDYFILE"
      sync -f "$(dirname "$CADDYFILE")" || true
      if [[ -f "$backup/caddy-dropin-absent" ]]; then
        rm -f -- "$CADDY_DROPIN"
      else
        install -o root -g root -m 0644 "$backup/10-slopproof-credential.conf" "$dropin_temporary.restore"
        sync -f "$dropin_temporary.restore" || true
        mv -Tf "$dropin_temporary.restore" "$CADDY_DROPIN"
      fi
      sync -f "$(dirname "$CADDY_DROPIN")" || true
      if [[ -f "$backup/previous-secret-current-absent" ]]; then
        rm -f -- "$SECRET_ROOT/current"
      else
        ln -sfn "$(cat "$backup/previous-secret-current")" "$SECRET_ROOT/current.restore"
        mv -Tf "$SECRET_ROOT/current.restore" "$SECRET_ROOT/current"
      fi
      sync -f "$SECRET_ROOT" || true
      systemctl daemon-reload || true
      systemctl restart caddy || true
    fi
    exit "$exit_status"
  }
  trap 'restore_failed_cutover $?' EXIT
  trap 'restore_failed_cutover 129' HUP
  trap 'restore_failed_cutover 130' INT
  trap 'restore_failed_cutover 143' TERM

  install -d -o root -g root -m 0755 "$(dirname "$CADDY_DROPIN")"
  install -o root -g root -m 0644 \
    "$(release_source "$release_id")/infra/systemd/caddy.service.d/10-slopproof-credential.conf" "$dropin_temporary"
  install -o root -g caddy -m 0640 "$candidate" "$caddy_temporary"
  sync -f "$dropin_temporary"
  sync -f "$caddy_temporary"
  mutation_started=true
  # The credential link is harmless to the old configuration and must become
  # durable first. This guarantees that either old Caddy boots, or every new
  # boot-visible state can resolve its LoadCredential source.
  [[ ! -e "$SECRET_ROOT/current.next" && ! -L "$SECRET_ROOT/current.next" ]] ||
    die "Temporary secret publication path already exists"
  ln -s "$SECRET_ROOT/$release_id" "$SECRET_ROOT/current.next"
  sync -f "$SECRET_ROOT"
  mv -Tf "$SECRET_ROOT/current.next" "$SECRET_ROOT/current"
  sync -f "$SECRET_ROOT"
  mv -Tf "$dropin_temporary" "$CADDY_DROPIN"
  sync -f "$(dirname "$CADDY_DROPIN")"
  mv -Tf "$caddy_temporary" "$CADDYFILE"
  sync -f "$(dirname "$CADDYFILE")"
  systemctl daemon-reload
  systemctl restart caddy
  timeout --signal=TERM --kill-after=5s 30 systemctl is-active --quiet caddy
  require_effective_service_core_limit caddy.service
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    --unix-socket /run/caddy/admin.sock http://localhost/config/ \
    > "$backup/active-admin.json"
  jq -e --arg placeholder '{file./run/credentials/caddy.service/oauth-proxy-authenticator}' \
    'tostring | contains($placeholder)' "$backup/active-admin.json" >/dev/null
  ! grep -Fq -f "$SECRET_ROOT/$release_id/oauth-proxy-authenticator" "$backup/active-admin.json" ||
    die "Caddy admin JSON expanded the protected credential"
  "$(release_source "$release_id")/scripts/production-deploy/smoke-production.sh" pre-finalize
  cutover_complete=true
  trap - EXIT HUP INT TERM
  printf '%s\n' "Caddy cutover and cohost smoke passed."
}

phase_finalize() {
  require_root
  local release_id=${1:-} source final backup app_id postgres_id release_env_temporary unit_temporary rollback_boundary finalize_complete=false
  require_release_id "$release_id"
  source=$(release_source "$release_id")
  final=$(release_final "$release_id")
  [[ ! -e "$final" ]] || die "Final release path already exists"
  backup="$SHARED_ROOT/caddy-backup-$release_id"
  rollback_boundary="$(release_incoming "$release_id")/.rollback-boundary.json"
  [[ -d "$backup" && -f "$rollback_boundary" && ! -L "$rollback_boundary" ]] ||
    die "Caddy or rollback boundary is absent"
  restore_failed_finalize() {
    local exit_status=${1:-$?}
    trap - EXIT HUP INT TERM
    if [[ "$finalize_complete" != true ]]; then
      phase_rollback "$release_id" ||
        printf '%s\n' "Automatic finalize rollback failed; manual recovery is required." >&2
    fi
    exit "$exit_status"
  }
  trap 'restore_failed_finalize $?' EXIT
  trap 'restore_failed_finalize 129' HUP
  trap 'restore_failed_finalize 130' INT
  trap 'restore_failed_finalize 143' TERM
  wait_release_stack "$release_id" 60
  assert_staged_release_images "$release_id"
  mv -- "$(release_incoming "$release_id")" "$final"
  sync -f "$(dirname "$final")"
  ln -sfn "$final/source" "$CURRENT_LINK.next"
  mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
  sync -f "$(dirname "$CURRENT_LINK")"
  app_id=$(jq -er '.image.id' "$CURRENT_LINK/.slopproof-release.json")
  postgres_id=$(jq -er '.postgresId' "$final/.image-stage-receipt.json")
  release_env_temporary="$ETC_ROOT/.release.env.$release_id.tmp"
  printf 'SLOPPROOF_SECRET_DIR=%s\nSLOPPROOF_DATA_DIR=%s\nSLOPPROOF_IMAGE=%s\nSLOPPROOF_POSTGRES_IMAGE=%s\nS3_PUBLIC_ENDPOINT=%s\n' \
    "$SECRET_ROOT/$release_id" "$DATA_ROOT" "$app_id" "$postgres_id" \
    'https://bf2f734c49e05a3ed1cbad16f0049e6c.eu.r2.cloudflarestorage.com' \
    > "$release_env_temporary"
  chown root:root "$release_env_temporary"
  chmod 0600 "$release_env_temporary"
  sync -f "$release_env_temporary"
  mv -Tf "$release_env_temporary" "$ETC_ROOT/release.env"
  sync -f "$ETC_ROOT"
  unit_temporary="$(dirname "$COMPOSE_UNIT")/.slopproof-compose.$release_id.tmp"
  install -o root -g root -m 0644 "$CURRENT_LINK/infra/systemd/slopproof-compose.service" "$unit_temporary"
  sync -f "$unit_temporary"
  mv -Tf "$unit_temporary" "$COMPOSE_UNIT"
  sync -f "$(dirname "$COMPOSE_UNIT")"
  systemctl daemon-reload
  systemctl enable slopproof-compose.service
  sync -f /etc/systemd/system
  if [[ -d /etc/systemd/system/multi-user.target.wants ]]; then
    sync -f /etc/systemd/system/multi-user.target.wants
  fi
  systemctl start slopproof-compose.service
  timeout --signal=TERM --kill-after=5s 300 systemctl is-active --quiet slopproof-compose.service
  assert_release_container_images "$release_id" postgres migrate worker github-control web
  "$CURRENT_LINK/scripts/production-deploy/smoke-production.sh" final
  finalize_complete=true
  trap - EXIT HUP INT TERM
  printf '%s\n' "Finalized immutable release $release_id."
}

phase_rollback() {
  require_root
  local release_id=${1:-} boundary previous backup candidate_source previous_secret restore_temporary
  local postgres_id postgres_mount data_identity data_realpath container_id state
  local compose_enable_link='/etc/systemd/system/multi-user.target.wants/slopproof-compose.service'
  require_release_id "$release_id"
  boundary="$(release_bundle "$release_id")/.rollback-boundary.json"
  [[ -f "$boundary" && ! -L "$boundary" ]] || die "Rollback boundary receipt is absent"
  previous=$(jq -er '.previousCurrent' "$boundary")
  backup=$(jq -er '.caddyBackup' "$boundary")
  [[ "$previous" =~ ^/opt/slopproof/releases/bootstrap-[0-9]{8}-[0-9]{4}$ ]] ||
    die "Automatic rollback is limited to the audited bootstrap boundary"
  [[ -d "$previous" && -f "$backup/Caddyfile" ]] || die "Rollback artifacts are absent"
  jq -e --arg release_id "$release_id" --arg expected "$SHARED_ROOT/backup-receipt-$release_id.verified.json" \
    '.schema == "slopproof.rollback-boundary.v1" and .releaseId == $release_id and .database.policy == "forward-only-separate-restore" and .database.verifiedBoundary == $expected and (.database.ciphertextSha256 | test("^[0-9a-f]{64}$")) and (.database.backupTimestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and (.database.restoreCompletedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "$boundary" >/dev/null ||
    die "Rollback database boundary is invalid"
  caddy validate --config "$backup/Caddyfile" --adapter caddyfile
  candidate_source="$(release_source "$release_id")"
  postgres_id=$(compose "$release_id" ps -a -q postgres)
  [[ "$postgres_id" =~ ^[0-9a-f]{12,64}$ ]] || die "Candidate PostgreSQL container is absent"
  data_realpath=$(realpath -e -- "$DATA_ROOT/postgres")
  [[ "$data_realpath" == "$DATA_ROOT/postgres" ]] || die "PostgreSQL data path identity mismatch"
  data_identity=$(stat -Lc '%d:%i:%u:%g:%a' "$DATA_ROOT/postgres")
  postgres_mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}}{{end}}{{end}}' "$postgres_id")
  [[ "$postgres_mount" == "bind|$DATA_ROOT/postgres|/var/lib/postgresql|true" ]] ||
    die "PostgreSQL preservation mount mismatch"
  if systemctl is-active --quiet slopproof-compose.service; then
    timeout --signal=TERM --kill-after=10s 120 systemctl stop slopproof-compose.service
  fi
  ! systemctl is-active --quiet slopproof-compose.service ||
    die "SlopProof service did not stop"
  timeout --signal=TERM --kill-after=10s 120 env \
    SLOPPROOF_SECRET_DIR="$SECRET_ROOT/$release_id" \
    SLOPPROOF_DATA_DIR="$DATA_ROOT" \
    SLOPPROOF_IMAGE="$(jq -er '.image.id' "$candidate_source/.slopproof-release.json")" \
    SLOPPROOF_POSTGRES_IMAGE="$(jq -er '.postgresId' "$(release_bundle "$release_id")/.image-stage-receipt.json")" \
    S3_PUBLIC_ENDPOINT='https://bf2f734c49e05a3ed1cbad16f0049e6c.eu.r2.cloudflarestorage.com' \
    COMPOSE_PROJECT_NAME=slopproof-production \
    docker compose -f "$candidate_source/compose.production.yaml" stop --timeout 60
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    state=$(docker inspect --format '{{.State.Status}}' "$container_id")
    [[ "$state" == exited || "$state" == created ]] ||
      die "Candidate container did not reach a preserved stopped state"
  done < <(docker ps -a --filter label=com.docker.compose.project=slopproof-production --format '{{.ID}}')
  [[ $(docker inspect --format '{{.Id}}' "$postgres_id") == "$postgres_id" &&
    $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}}{{end}}{{end}}' "$postgres_id") == "$postgres_mount" &&
    $(realpath -e -- "$DATA_ROOT/postgres") == "$data_realpath" &&
    $(stat -Lc '%d:%i:%u:%g:%a' "$DATA_ROOT/postgres") == "$data_identity" ]] ||
    die "PostgreSQL rollback preservation proof failed"
  if [[ -f "$COMPOSE_UNIT" && ! -L "$COMPOSE_UNIT" ]]; then
    timeout --signal=TERM --kill-after=5s 30 systemctl disable slopproof-compose.service
  else
    [[ ! -e "$COMPOSE_UNIT" && ! -L "$COMPOSE_UNIT" ]] ||
      die "SlopProof Compose unit boundary is unsafe"
    [[ ! -e "$compose_enable_link" || -L "$compose_enable_link" ]] ||
      die "SlopProof Compose enable boundary is unsafe"
    rm -f -- "$compose_enable_link"
  fi
  sync -f /etc/systemd/system
  if [[ -d /etc/systemd/system/multi-user.target.wants ]]; then
    sync -f /etc/systemd/system/multi-user.target.wants
  fi
  restore_temporary="$(dirname "$CADDYFILE")/.Caddyfile.$release_id.rollback"
  install -o root -g caddy -m 0640 "$backup/Caddyfile" "$restore_temporary"
  sync -f "$restore_temporary"
  mv -Tf "$restore_temporary" "$CADDYFILE"
  sync -f "$(dirname "$CADDYFILE")"
  if [[ -f "$backup/10-slopproof-credential.conf" ]]; then
    restore_temporary="$(dirname "$CADDY_DROPIN")/.10-slopproof-credential.$release_id.rollback"
    install -o root -g root -m 0644 "$backup/10-slopproof-credential.conf" "$restore_temporary"
    sync -f "$restore_temporary"
    mv -Tf "$restore_temporary" "$CADDY_DROPIN"
  else
    rm -f -- "$CADDY_DROPIN"
  fi
  sync -f "$(dirname "$CADDY_DROPIN")"
  if [[ -f "$backup/previous-secret-current" ]]; then
    previous_secret=$(cat "$backup/previous-secret-current")
    [[ "$previous_secret" =~ ^/etc/slopproof/secrets/[0-9]{8}T[0-9]{6}Z$ ]] ||
      die "Previous secret symlink boundary is invalid"
    ln -sfn "$previous_secret" "$SECRET_ROOT/current.rollback"
    mv -Tf "$SECRET_ROOT/current.rollback" "$SECRET_ROOT/current"
  else
    rm -f -- "$SECRET_ROOT/current"
  fi
  sync -f "$SECRET_ROOT"
  ln -sfn "$previous" "$CURRENT_LINK.next"
  mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
  sync -f "$(dirname "$CURRENT_LINK")"
  if [[ -f "$backup/release.env" ]]; then
    install -o root -g root -m 0600 "$backup/release.env" "$ETC_ROOT/.release.env.rollback"
    sync -f "$ETC_ROOT/.release.env.rollback"
    mv -Tf "$ETC_ROOT/.release.env.rollback" "$ETC_ROOT/release.env"
  else
    rm -f -- "$ETC_ROOT/release.env"
  fi
  sync -f "$ETC_ROOT"
  if [[ -f "$backup/slopproof-compose.service" ]]; then
    install -o root -g root -m 0644 "$backup/slopproof-compose.service" \
      "$(dirname "$COMPOSE_UNIT")/.slopproof-compose.rollback"
    sync -f "$(dirname "$COMPOSE_UNIT")/.slopproof-compose.rollback"
    mv -Tf "$(dirname "$COMPOSE_UNIT")/.slopproof-compose.rollback" "$COMPOSE_UNIT"
  else
    rm -f -- "$COMPOSE_UNIT"
  fi
  sync -f "$(dirname "$COMPOSE_UNIT")"
  systemctl daemon-reload
  systemctl restart caddy
  timeout --signal=TERM --kill-after=5s 30 systemctl is-active --quiet caddy
  [[ $(sha256sum "$CADDYFILE" | awk '{print $1}') == $(sha256sum "$backup/Caddyfile" | awk '{print $1}') ]] ||
    die "Restored Caddyfile identity mismatch"
  "$(release_source "$release_id")/scripts/production-deploy/smoke-production.sh" rollback-bootstrap
  printf '%s\n' "Restored the bootstrap landing state; candidate containers are stopped; PostgreSQL and R2 were preserved."
}

case "${1:-}" in
  preflight) [[ $# -eq 1 ]] || die "Usage: deploy.sh preflight"; phase_preflight ;;
  prepare-remote) [[ $# -eq 2 ]] || die "Usage: deploy.sh prepare-remote RELEASE_ID"; phase_prepare_remote "$2" ;;
  install) [[ $# -eq 3 ]] || die "Usage: deploy.sh install RELEASE_ID COMPILED_SECRET_DIR"; phase_install "$2" "$3" ;;
  image-stage) [[ $# -eq 2 ]] || die "Usage: deploy.sh image-stage RELEASE_ID"; phase_image_stage "$2" ;;
  postgres-only) [[ $# -eq 2 ]] || die "Usage: deploy.sh postgres-only RELEASE_ID"; phase_postgres_only "$2" ;;
  migrate-start) [[ $# -eq 3 ]] || die "Usage: deploy.sh migrate-start RELEASE_ID BACKUP_RECEIPT"; phase_migrate_start "$2" "$3" ;;
  backup-compose) [[ $# -ge 6 ]] || die "Usage: deploy.sh backup-compose RELEASE_ID exec -T postgres COMMAND ..."; shift; phase_backup_compose "$@" ;;
  restore-start) [[ $# -eq 3 ]] || die "Usage: deploy.sh restore-start RELEASE_ID DATABASE"; phase_restore_start "$2" "$3" ;;
  restore-exec) [[ $# -ge 5 ]] || die "Usage: deploy.sh restore-exec RELEASE_ID DATABASE COMMAND ..."; shift; phase_restore_exec "$@" ;;
  restore-stop) [[ $# -eq 3 ]] || die "Usage: deploy.sh restore-stop RELEASE_ID DATABASE"; phase_restore_stop "$2" "$3" ;;
  restore-absent) [[ $# -eq 3 ]] || die "Usage: deploy.sh restore-absent RELEASE_ID DATABASE"; phase_restore_absent "$2" "$3" ;;
  initial-caddy-cutover) [[ $# -eq 2 ]] || die "Usage: deploy.sh initial-caddy-cutover RELEASE_ID"; phase_initial_caddy_cutover "$2" ;;
  finalize) [[ $# -eq 2 ]] || die "Usage: deploy.sh finalize RELEASE_ID"; phase_finalize "$2" ;;
  rollback) [[ $# -eq 2 ]] || die "Usage: deploy.sh rollback RELEASE_ID"; phase_rollback "$2" ;;
  *) die "Expected preflight, prepare-remote, install, image-stage, postgres-only, backup-compose, restore-start, restore-exec, restore-stop, restore-absent, migrate-start, initial-caddy-cutover, finalize or rollback" ;;
esac
