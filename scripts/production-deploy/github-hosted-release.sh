#!/usr/bin/env bash
# GitHub-hosted ubuntu-latest driver for the existing production operator path.
# Wraps prepare-release.mjs, pnpm production:env, transfer-release.sh, and
# deploy.sh. It never implements a second runner, never runs on pull_request,
# and never writes compiler outputs into the git checkout.
#
# Environment secret names (values never belong in this repository):
#   DEPLOY_SSH_KEY DEPLOY_SSH_HOST DEPLOY_SSH_USER DEPLOY_SSH_KNOWN_HOSTS
#   GH_APP_ID GH_WEBHOOK_SECRET GH_CLIENT_ID GH_CLIENT_SECRET GH_APP_PRIVATE_KEY
#   KEY_WRAPPING_PRIVATE_KEY KEY_WRAPPING_PUBLIC_KEY
#   APP_BASE_URL DATABASE_URL SESSION_SECRET LOG_LEVEL
#   GENERATION_BASE_URL GENERATION_API_KEY LEARNING_MODEL PRACTICE_MODEL
#   PROOF_QUESTION_MODEL JUDGE_BASE_URL JUDGE_API_KEY JUDGE_MODEL
#   JUDGE_FALLBACK_MODEL TRANSCRIPTION_BASE_URL TRANSCRIPTION_API_KEY
#   TRANSCRIPTION_MODEL S3_CONTROL_ENDPOINT S3_PUBLIC_ENDPOINT S3_REGION
#   S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY WORKER_INTERNAL_SECRET
#   PROVIDER_PAYLOAD_KEY_BASE64
#
# GH_* names exist because GitHub forbids Environment secrets named GITHUB_*.
# The compiler still receives GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET,
# GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and path-based PEM inputs.
#
# This driver stops after managed-prepare. migrate-start requires a verified
# CMS backup receipt. decrypt-cms-stream.sh reads the backup recipient
# passphrase from /dev/tty and the private key must remain
# -----BEGIN ENCRYPTED PRIVATE KEY-----. That key is not representable as an
# Actions secret without putting backup recovery material on ubuntu-latest.
set -euo pipefail
IFS=$'\n\t'
umask 077
[[ $- != *x* ]] || {
  printf '%s\n' "Shell tracing must be disabled" >&2
  exit 1
}

readonly CURRENT_DEPLOY='/opt/slopproof/current/scripts/production-deploy/deploy.sh'
REMOTE=''

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

bounded() {
  local seconds=$1
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' "$seconds" "$@"
}

require_release_id() {
  [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "Invalid release ID"
}

require_absolute_dir() {
  [[ "$1" == /* && -d "$1" && ! -L "$1" ]] || die "$2 is not a safe directory"
}

require_absolute_file() {
  [[ "$1" == /* && -f "$1" && ! -L "$1" ]] || die "$2 is not a safe file"
}

require_absent() {
  [[ ! -e "$1" && ! -L "$1" ]] || die "$2 already exists"
}

require_env() {
  local name=$1
  [[ -n "${!name:-}" ]] || die "Missing $name"
}

write_owner_file() {
  local path=$1 mode=$2
  require_absent "$path" "$path"
  install -m "$mode" /dev/null "$path"
  tr -d '\r' > "$path"
  chmod "$mode" -- "$path"
  [[ -s "$path" ]] || die "Wrote an empty protected file"
}

incoming_deploy() {
  printf '%s' "/opt/slopproof/releases/$1.incoming/source/scripts/production-deploy/deploy.sh"
}

final_deploy() {
  printf '%s' "/opt/slopproof/releases/$1/source/scripts/production-deploy/deploy.sh"
}

ssh_options_from_identity() {
  local identity=$1
  ssh_options=(
    -i "$identity"
    -o IdentitiesOnly=yes
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o ServerAliveInterval=10
    -o ServerAliveCountMax=3
    -o StrictHostKeyChecking=yes
  )
}

resolve_deploy_remote() {
  local user=${DEPLOY_SSH_USER:-root}
  require_env DEPLOY_SSH_HOST
  [[ "$user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "Invalid DEPLOY_SSH_USER"
  [[ "$DEPLOY_SSH_HOST" =~ ^[A-Za-z0-9._:\[\]-]+$ ]] || die "Invalid DEPLOY_SSH_HOST"
  REMOTE="$user@$DEPLOY_SSH_HOST"
  export DEPLOY_SSH_USER=$user
  export DEPLOY_SSH_HOST
}

install_ssh_material() {
  local identity=$1
  require_env DEPLOY_SSH_KEY
  require_env DEPLOY_SSH_KNOWN_HOSTS
  require_absent "$identity" "SSH identity"
  resolve_deploy_remote
  install -d -m 0700 -- "$(dirname "$identity")"
  printf '%s' "$DEPLOY_SSH_KEY" | write_owner_file "$identity" 600
  DEPLOY_SSH_KEY=''
  unset DEPLOY_SSH_KEY
  install -d -m 0700 -- "${HOME:?}/.ssh"
  chmod 700 -- "$HOME/.ssh"
  rm -f -- "$HOME/.ssh/known_hosts"
  printf '%s' "$DEPLOY_SSH_KNOWN_HOSTS" | write_owner_file "$HOME/.ssh/known_hosts" 600
  DEPLOY_SSH_KNOWN_HOSTS=''
  unset DEPLOY_SSH_KNOWN_HOSTS
}

ssh_production() {
  local seconds=$1
  shift
  [[ -n "$REMOTE" ]] || die "Production SSH remote is unset"
  bounded "$seconds" ssh "${ssh_options[@]}" "$REMOTE" "$@"
}

remote_deploy() {
  local seconds=$1 script=$2
  shift 2
  [[ "$script" == /opt/slopproof/* ]] || die "Refusing to execute a non-release deploy script"
  ssh_production "$seconds" "$script" "$@"
}

unset_compiler_secrets() {
  unset \
    GH_APP_PRIVATE_KEY \
    KEY_WRAPPING_PRIVATE_KEY \
    KEY_WRAPPING_PUBLIC_KEY \
    APP_BASE_URL \
    DATABASE_URL \
    SESSION_SECRET \
    LOG_LEVEL \
    GH_APP_ID \
    GH_WEBHOOK_SECRET \
    GH_CLIENT_ID \
    GH_CLIENT_SECRET \
    GITHUB_APP_ID \
    GITHUB_WEBHOOK_SECRET \
    GITHUB_CLIENT_ID \
    GITHUB_CLIENT_SECRET \
    GENERATION_BASE_URL \
    GENERATION_API_KEY \
    LEARNING_MODEL \
    PRACTICE_MODEL \
    PROOF_QUESTION_MODEL \
    JUDGE_BASE_URL \
    JUDGE_API_KEY \
    JUDGE_MODEL \
    JUDGE_FALLBACK_MODEL \
    TRANSCRIPTION_BASE_URL \
    TRANSCRIPTION_API_KEY \
    TRANSCRIPTION_MODEL \
    S3_CONTROL_ENDPOINT \
    S3_PUBLIC_ENDPOINT \
    S3_REGION \
    S3_BUCKET \
    S3_ACCESS_KEY_ID \
    S3_SECRET_ACCESS_KEY \
    WORKER_INTERNAL_SECRET \
    PROVIDER_PAYLOAD_KEY_BASE64
}

compile_production_secrets() {
  local repository=$1 output=$2 key_root=$3
  require_absolute_dir "$repository" "repository"
  require_absent "$output" "compiled secret directory"
  require_absent "$key_root" "compiler key directory"

  require_env GH_APP_PRIVATE_KEY
  require_env KEY_WRAPPING_PRIVATE_KEY
  require_env KEY_WRAPPING_PUBLIC_KEY
  require_env APP_BASE_URL
  require_env DATABASE_URL
  require_env SESSION_SECRET
  require_env LOG_LEVEL
  require_env GH_APP_ID
  require_env GH_WEBHOOK_SECRET
  require_env GH_CLIENT_ID
  require_env GH_CLIENT_SECRET
  require_env GENERATION_BASE_URL
  require_env GENERATION_API_KEY
  require_env LEARNING_MODEL
  require_env PRACTICE_MODEL
  require_env PROOF_QUESTION_MODEL
  require_env JUDGE_BASE_URL
  require_env JUDGE_API_KEY
  require_env JUDGE_MODEL
  require_env JUDGE_FALLBACK_MODEL
  require_env TRANSCRIPTION_BASE_URL
  require_env TRANSCRIPTION_API_KEY
  require_env TRANSCRIPTION_MODEL
  require_env S3_CONTROL_ENDPOINT
  require_env S3_PUBLIC_ENDPOINT
  require_env S3_REGION
  require_env S3_BUCKET
  require_env S3_ACCESS_KEY_ID
  require_env S3_SECRET_ACCESS_KEY
  require_env WORKER_INTERNAL_SECRET
  require_env PROVIDER_PAYLOAD_KEY_BASE64

  install -d -m 0700 -- "$key_root"
  printf '%s' "$GH_APP_PRIVATE_KEY" | write_owner_file "$key_root/github-app.pem" 600
  printf '%s' "$KEY_WRAPPING_PRIVATE_KEY" | write_owner_file "$key_root/wrapping-private.pem" 600
  printf '%s' "$KEY_WRAPPING_PUBLIC_KEY" | write_owner_file "$key_root/wrapping-public.pem" 644
  GH_APP_PRIVATE_KEY=''
  KEY_WRAPPING_PRIVATE_KEY=''
  KEY_WRAPPING_PUBLIC_KEY=''
  unset GH_APP_PRIVATE_KEY KEY_WRAPPING_PRIVATE_KEY KEY_WRAPPING_PUBLIC_KEY

  install -d -m 0700 -- "$output"

  (
    cd "$repository"
    NODE_ENV=production \
      DEMO_MODE=false \
      DEMO_FAKE_MEDIA=false \
      GITHUB_ADAPTER=octokit \
      GENERATION_PROVIDER=hetzner \
      MULTIMODAL_JUDGE_PROVIDER=hetzner \
      TRANSCRIPTION_PROVIDER=openrouter \
      EVIDENCE_STORAGE_PROVIDER=s3 \
      KEY_WRAPPING_PROVIDER=local \
      WORKER_INTERNAL_URL=http://worker:4001 \
      WORKER_HOST=0.0.0.0 \
      WORKER_PORT=4001 \
      FFMPEG_PATH=/usr/bin/ffmpeg \
      FFPROBE_PATH=/usr/bin/ffprobe \
      GITHUB_PRIVATE_KEY_CONTAINER_PATH=/run/secrets/github-app.pem \
      KEY_WRAPPING_PUBLIC_KEY_CONTAINER_PATH=/run/secrets/wrapping-public.pem \
      KEY_WRAPPING_PRIVATE_KEY_CONTAINER_PATH=/run/secrets/wrapping-private.pem \
      GITHUB_PRIVATE_KEY_PATH="$key_root/github-app.pem" \
      KEY_WRAPPING_PRIVATE_KEY_PATH="$key_root/wrapping-private.pem" \
      KEY_WRAPPING_PUBLIC_KEY_PATH="$key_root/wrapping-public.pem" \
      GITHUB_APP_ID="$GH_APP_ID" \
      GITHUB_WEBHOOK_SECRET="$GH_WEBHOOK_SECRET" \
      GITHUB_CLIENT_ID="$GH_CLIENT_ID" \
      GITHUB_CLIENT_SECRET="$GH_CLIENT_SECRET" \
      pnpm production:env -- "$output"
  )

  unset_compiler_secrets
}

create_release_bundle() {
  local repository=$1 output=$2 release_id=$3 image_archive=$4 image_tag=$5
  local image_id=$6 image_source_commit=$7 scan_report=$8 sbom_report=$9
  require_absent "$output" "release bundle"
  node "$repository/scripts/production-deploy/prepare-release.mjs" create \
    --repository "$repository" \
    --output "$output" \
    --release-id "$release_id" \
    --image-archive "$image_archive" \
    --image-tag "$image_tag" \
    --image-id "$image_id" \
    --image-source-commit "$image_source_commit" \
    --scan-report "$scan_report" \
    --sbom-report "$sbom_report"
}

transfer_release() {
  local repository=$1 bundle=$2 compiled_secrets=$3 identity=$4
  local image_id image_tag image_source_commit archive_sha256 scan_sha256 sbom_sha256
  image_id=$(jq -er '.image.id' "$bundle/source/.slopproof-release.json")
  image_tag=$(jq -er '.image.tag' "$bundle/source/.slopproof-release.json")
  image_source_commit=$(jq -er '.image.sourceCommit' "$bundle/source/.slopproof-release.json")
  archive_sha256=$(jq -er '.image.archiveSha256' "$bundle/source/.slopproof-release.json")
  scan_sha256=$(jq -er '.image.scanReportSha256' "$bundle/source/.slopproof-release.json")
  sbom_sha256=$(jq -er '.image.sbomReportSha256' "$bundle/source/.slopproof-release.json")
  "$repository/scripts/production-deploy/transfer-release.sh" \
    --bundle "$bundle" \
    --compiled-secrets "$compiled_secrets" \
    --identity "$identity" \
    --trusted-checkout "$repository" \
    --expected-image-id "$image_id" \
    --expected-image-tag "$image_tag" \
    --expected-image-source-commit "$image_source_commit" \
    --expected-archive-sha256 "$archive_sha256" \
    --expected-scan-sha256 "$scan_sha256" \
    --expected-sbom-sha256 "$sbom_sha256"
}

print_cms_blocker() {
  printf '%s\n' \
    "Staged the managed candidate through managed-prepare." \
    "Refusing migrate-start: the backup recipient private key is an encrypted PEM whose passphrase is read from /dev/tty by scripts/production-backup/decrypt-cms-stream.sh." \
    "Putting that key or passphrase in the production Environment would place backup recovery material on GitHub-hosted ubuntu-latest and in Actions logs' secret store." \
    "Do not pg_dump onto the runner. Complete run-backup-rehearsal.sh, verify-and-transfer-backup.sh, deploy.sh migrate-start, and deploy.sh managed-finalize from an operator machine."
  printf '%s\n' \
    '::warning title=Production current unchanged::migrate-start still requires the offline CMS recipient passphrase on a TTY. This job staged through managed-prepare only.'
}

run_deploy() {
  [[ $# -eq 22 && $1 == --repository && $3 == --release-id && $5 == --bundle &&
    $7 == --compiled-secrets && $9 == --identity && ${11} == --image-archive &&
    ${13} == --image-tag && ${15} == --image-id &&
    ${17} == --image-source-commit && ${19} == --scan-report &&
    ${21} == --sbom-report ]] ||
    die "Usage: github-hosted-release.sh deploy --repository ABS --release-id ID --bundle ABS --compiled-secrets ABS --identity ABS --image-archive ABS --image-tag TAG --image-id ID --image-source-commit SHA --scan-report ABS --sbom-report ABS"

  local repository=$2 release_id=$4 bundle=$6 compiled_secrets=$8 identity=${10}
  local image_archive=${12} image_tag=${14} image_id=${16}
  local image_source_commit=${18} scan_report=${20} sbom_report=${22}
  local key_root incoming_script
  require_release_id "$release_id"
  require_absolute_dir "$repository" "repository"
  [[ "$bundle" == /* && "$compiled_secrets" == /* && "$identity" == /* &&
    "$image_archive" == /* && "$scan_report" == /* && "$sbom_report" == /* ]] ||
    die "All local paths must be absolute"
  [[ "$bundle" != "$repository" && "$bundle" != "$repository"/* &&
    "$compiled_secrets" != "$repository" && "$compiled_secrets" != "$repository"/* &&
    "$identity" != "$repository" && "$identity" != "$repository"/* ]] ||
    die "Operator outputs must stay outside the git checkout"
  require_absolute_file "$image_archive" "image archive"
  require_absolute_file "$scan_report" "Trivy report"
  require_absolute_file "$sbom_report" "SPDX report"
  [[ -z $(git -C "$repository" status --porcelain=v1 --untracked-files=all) ]] ||
    die "Trusted checkout is not clean"

  key_root="$(dirname "$compiled_secrets")/compiler-keys"
  COMPILED_SECRETS_CLEANUP=$compiled_secrets
  KEY_ROOT_CLEANUP=$key_root
  IDENTITY_CLEANUP=$identity
  trap 'rm -rf -- "${COMPILED_SECRETS_CLEANUP:-}" "${KEY_ROOT_CLEANUP:-}"; rm -f -- "${IDENTITY_CLEANUP:-}"' EXIT

  create_release_bundle "$repository" "$bundle" "$release_id" \
    "$image_archive" "$image_tag" "$image_id" "$image_source_commit" \
    "$scan_report" "$sbom_report"
  compile_production_secrets "$repository" "$compiled_secrets" "$key_root"
  install_ssh_material "$identity"
  ssh_options_from_identity "$identity"

  ssh_production 60 test -x "$CURRENT_DEPLOY"
  remote_deploy 180 "$CURRENT_DEPLOY" preflight
  transfer_release "$repository" "$bundle" "$compiled_secrets" "$identity"
  incoming_script=$(incoming_deploy "$release_id")
  ssh_production 60 test -x "$incoming_script"
  remote_deploy 1800 "$incoming_script" image-stage "$release_id"
  remote_deploy 300 "$incoming_script" postgres-only "$release_id"
  remote_deploy 180 "$incoming_script" managed-prepare "$release_id"
  print_cms_blocker
}

run_managed_rollback() {
  [[ $# -eq 4 && $1 == --release-id && $3 == --identity ]] ||
    die "Usage: github-hosted-release.sh managed-rollback --release-id ID --identity ABS"
  local release_id=$2 identity=$4 script
  require_release_id "$release_id"
  [[ "$identity" == /* ]] || die "SSH identity must be absolute"
  IDENTITY_CLEANUP=$identity
  trap 'rm -f -- "${IDENTITY_CLEANUP:-}"' EXIT
  install_ssh_material "$identity"
  ssh_options_from_identity "$identity"
  if ssh_production 60 test -x "$(incoming_deploy "$release_id")"; then
    script=$(incoming_deploy "$release_id")
  elif ssh_production 60 test -x "$(final_deploy "$release_id")"; then
    script=$(final_deploy "$release_id")
  else
    die "Release deploy.sh is absent on the production host"
  fi
  remote_deploy 900 "$script" managed-rollback "$release_id"
}

case "${1:-}" in
  deploy)
    shift
    run_deploy "$@"
    ;;
  managed-rollback)
    shift
    run_managed_rollback "$@"
    ;;
  *)
    die "Expected deploy or managed-rollback"
    ;;
esac
