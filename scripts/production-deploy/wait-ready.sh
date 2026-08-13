#!/usr/bin/env bash
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

valid_timeout() {
  [[ "$1" =~ ^[1-9][0-9]{0,3}$ ]] && ((10#$1 <= 900))
}

container_state() {
  docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.State.ExitCode}}' "$1" 2>/dev/null
}

wait_container_health() {
  local container_id=$1 timeout_seconds=$2 deadline state
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || die "Invalid container identity"
  valid_timeout "$timeout_seconds" || die "Invalid bounded timeout"
  deadline=$((SECONDS + 10#$timeout_seconds))
  while ((SECONDS < deadline)); do
    state=$(container_state "$container_id" || true)
    [[ "$state" == "running healthy 0" ]] && return 0
    [[ "$state" =~ ^(dead|exited) ]] && break
    sleep 2
  done
  die "Container did not become healthy before the bounded deadline"
}

wait_container_exit_zero() {
  local container_id=$1 timeout_seconds=$2 deadline state
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || die "Invalid container identity"
  valid_timeout "$timeout_seconds" || die "Invalid bounded timeout"
  deadline=$((SECONDS + 10#$timeout_seconds))
  while ((SECONDS < deadline)); do
    state=$(container_state "$container_id" || true)
    [[ "$state" == "exited  0" ]] && return 0
    [[ "$state" =~ ^(dead|exited) ]] && break
    sleep 2
  done
  die "One-shot container did not exit successfully before the bounded deadline"
}

wait_stack() {
  local timeout_seconds=$1 deadline service container_id state all_ready
  valid_timeout "$timeout_seconds" || die "Invalid bounded timeout"
  deadline=$((SECONDS + 10#$timeout_seconds))
  while ((SECONDS < deadline)); do
    all_ready=true
    for service in postgres worker github-control web; do
      container_id=$(docker compose -f compose.production.yaml ps -q "$service" 2>/dev/null || true)
      if [[ ! "$container_id" =~ ^[0-9a-f]{12,64}$ ]]; then
        all_ready=false
        continue
      fi
      state=$(container_state "$container_id" || true)
      [[ "$state" == "running healthy 0" ]] || all_ready=false
    done
    container_id=$(docker compose -f compose.production.yaml ps -a -q migrate 2>/dev/null || true)
    if [[ ! "$container_id" =~ ^[0-9a-f]{12,64}$ ]] ||
      [[ "$(container_state "$container_id" || true)" != "exited  0" ]]; then
      all_ready=false
    fi
    if [[ "$all_ready" == true ]] &&
      curl --fail --silent --show-error --output /dev/null \
        --connect-timeout 2 --max-time 3 \
        http://127.0.0.1:3000/api/health/live &&
      curl --fail --silent --show-error --output /dev/null \
        --connect-timeout 2 --max-time 3 \
        http://127.0.0.1:3000/api/health/ready; then
      return 0
    fi
    sleep 2
  done
  die "Production stack did not become ready before the bounded deadline"
}

case "${1:-}" in
  container-health)
    [[ $# -eq 3 ]] || die "Usage: wait-ready.sh container-health ID SECONDS"
    wait_container_health "$2" "$3"
    ;;
  container-exit-zero)
    [[ $# -eq 3 ]] || die "Usage: wait-ready.sh container-exit-zero ID SECONDS"
    wait_container_exit_zero "$2" "$3"
    ;;
  stack)
    [[ $# -eq 2 ]] || die "Usage: wait-ready.sh stack SECONDS"
    wait_stack "$2"
    ;;
  *)
    die "Expected container-health, container-exit-zero or stack"
    ;;
esac
