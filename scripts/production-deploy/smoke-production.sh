#!/usr/bin/env bash
set -euo pipefail
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
ulimit -S -c 0
ulimit -H -c 0
[[ $(ulimit -S -c) == 0 && $(ulimit -H -c) == 0 ]] || {
  printf '%s\n' "Production smoke core limit is not zero" >&2
  exit 1
}

readonly BASE_URL='https://slopproof.paskie.me'
readonly PASKIE_URL='https://paskie.me'
readonly WUNDERBLUETE_URL='https://wunderbluete.club'
readonly REPLIKATOR_URL='https://replikator.paskie.me/api/health'

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

request_status() {
  local method=$1 url=$2 output=$3
  shift 3
  curl --silent --show-error --max-redirs 0 \
    --connect-timeout 5 --max-time 15 \
    --request "$method" --output "$output" --write-out '%{http_code}' \
    "$@" "$url" 2>/dev/null || true
}

require_status() {
  local expected=$1 actual=$2 label=$3
  [[ "$actual" =~ $expected ]] || die "$label returned unexpected status $actual"
}

main() {
  local phase=${1:-}
  [[ "$phase" == pre-finalize || "$phase" == final || "$phase" == rollback-bootstrap ]] ||
    die "Usage: smoke-production.sh pre-finalize|final|rollback-bootstrap"
  local scratch
  [[ -d /run && ! -L /run && $(realpath -e -- /run) == /run &&
    $(findmnt -n -o FSTYPE -T /run) == tmpfs ]] ||
    die "Production smoke requires the verified /run tmpfs"
  scratch=$(mktemp -d /run/slopproof-smoke.XXXXXXXX)
  [[ -d "$scratch" && ! -L "$scratch" && $(stat -c '%u %a' "$scratch") == "${EUID:-$(id -u)} 700" ]] ||
    die "Production smoke scratch identity is invalid"
  cleanup_scratch() {
    local exit_status=${1:-$?}
    trap - EXIT HUP INT TERM
    rm -f -- "$scratch"/* 2>/dev/null || true
    rmdir -- "$scratch" 2>/dev/null || true
    exit "$exit_status"
  }
  trap 'cleanup_scratch $?' EXIT
  trap 'cleanup_scratch 129' HUP
  trap 'cleanup_scratch 130' INT
  trap 'cleanup_scratch 143' TERM
  local status

  status=$(request_status GET "$BASE_URL/" "$scratch/landing")
  require_status '^200$' "$status" 'Landing page'

  if [[ "$phase" == rollback-bootstrap ]]; then
    status=$(request_status GET "$BASE_URL/api/health/live" "$scratch/bootstrap-api")
    require_status '^503$' "$status" 'Bootstrap API boundary'
    for url in "$PASKIE_URL" "$WUNDERBLUETE_URL"; do
      status=$(request_status GET "$url/" "$scratch/cohost")
      require_status '^(2[0-9]{2}|3[0-9]{2})$' "$status" "Existing cohost"
    done
    status=$(request_status GET "$REPLIKATOR_URL" "$scratch/replikator")
    require_status '^200$' "$status" 'Existing Replikator health'
    printf '%s\n' "Bootstrap rollback and cohost smoke passed."
    return
  fi

  status=$(
    curl --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 \
      --output "$scratch/oauth-start" --dump-header "$scratch/oauth-start.headers" \
      --header 'sec-fetch-site: same-origin' \
      --header 'sec-fetch-mode: navigate' \
      --header 'sec-fetch-dest: document' \
      --header 'referer: https://slopproof.paskie.me/review' \
      --write-out '%{http_code}' "$BASE_URL/api/auth/github/start" 2>/dev/null || true
  )
  require_status '^30[2378]$' "$status" 'OAuth start'
  grep -Eiq '^location: https://github\.com/login/oauth/authorize\?' \
    "$scratch/oauth-start.headers" || die "OAuth start did not target GitHub"

  status=$(request_status GET "$BASE_URL/api/auth/github/callback" "$scratch/oauth-callback")
  require_status '^400$' "$status" 'OAuth callback failure path'
  jq -e '.error == "oauth_rejected" and (keys | length) == 1' \
    "$scratch/oauth-callback" >/dev/null || die "OAuth error response exposed unexpected data"

  status=$(
    request_status POST "$BASE_URL/api/github/webhooks" "$scratch/webhook" \
      --header 'content-type: application/json' \
      --header 'x-github-event: ping' \
      --header 'x-github-delivery: 00000000-0000-4000-8000-000000000009' \
      --header 'x-hub-signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
      --data-binary '{}'
  )
  require_status '^401$' "$status" 'Invalid webhook signature'
  jq -e '.error == "invalid_signature" and (keys | length) == 1' \
    "$scratch/webhook" >/dev/null || die "Webhook error response exposed unexpected data"

  for endpoint in live ready; do
    status=$(request_status GET "$BASE_URL/api/health/$endpoint" "$scratch/health-$endpoint")
    require_status '^200$' "$status" "Health $endpoint"
  done
  jq -e '.status == "ok" and (keys | length) == 1' "$scratch/health-live" >/dev/null ||
    die "Liveness response was not value-free"
  jq -e '.status == "ready" and (keys | length) == 1' "$scratch/health-ready" >/dev/null ||
    die "Readiness response was not value-free"

  for path in /review /icon.svg; do
    status=$(request_status GET "$BASE_URL$path" "$scratch/app")
    require_status '^200$' "$status" "Application path $path"
  done

  for url in "$PASKIE_URL" "$WUNDERBLUETE_URL"; do
    status=$(request_status GET "$url/" "$scratch/cohost")
    require_status '^(2[0-9]{2}|3[0-9]{2})$' "$status" "Existing cohost"
  done
  status=$(request_status GET "$REPLIKATOR_URL" "$scratch/replikator")
  require_status '^200$' "$status" 'Existing Replikator health'
  printf 'Production and cohost smoke passed (%s).\n' "$phase"
}

main "$@"
