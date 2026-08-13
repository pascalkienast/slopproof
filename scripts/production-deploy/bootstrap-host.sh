#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly EXPECTED_NODEJS_PACKAGE='18.19.1+dfsg-6ubuntu5'
readonly EXPECTED_JQ_PACKAGE='1.7.1-3ubuntu0.24.04.2'
readonly UBUNTU_SOURCES=/etc/apt/sources.list.d/ubuntu.sources
readonly CADDY_SOURCES=/etc/apt/sources.list.d/caddy-stable.list
readonly UBUNTU_KEYRING=/usr/share/keyrings/ubuntu-archive-keyring.gpg
readonly CADDY_KEYRING=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
readonly STATE_ROOT=/opt/slopproof/shared/host-bootstrap
readonly DOCKER_DROPIN=/etc/systemd/system/docker.service.d/99-slopproof-core-limit.conf
readonly CONTAINERD_DROPIN=/etc/systemd/system/containerd.service.d/99-slopproof-core-limit.conf
readonly SSH_DROPIN=/etc/systemd/system/ssh.service.d/99-slopproof-core-limit.conf

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

bounded() {
  local seconds=$1
  shift
  timeout --signal=TERM --kill-after=10s "$seconds" "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required host command: $1"
}

require_root_ubuntu_amd64() {
  local os_release mode
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Host bootstrap must run as root"
  os_release=$(realpath -e /etc/os-release) || die "Unsafe or absent os-release"
  [[ "$os_release" == /etc/os-release || "$os_release" == /usr/lib/os-release ]] ||
    die "Unexpected os-release target"
  [[ -f "$os_release" && ! -L "$os_release" && $(stat -c '%U:%G' "$os_release") == 'root:root' ]] ||
    die "Unsafe os-release identity"
  mode=$(stat -c '%a' "$os_release")
  (( (8#$mode & 8#022) == 0 )) || die "os-release is group/world writable"
  grep -Fxq 'ID=ubuntu' "$os_release" || die "Production host must be Ubuntu"
  grep -Fxq 'VERSION_ID="24.04"' "$os_release" || die "Production host must be Ubuntu 24.04"
  [[ $(uname -m) == x86_64 ]] || die "Production host must be x86_64"
  [[ $(dpkg --print-architecture) == amd64 ]] || die "Production dpkg architecture must be amd64"
}

require_root_owned_source_file() {
  local path=$1
  [[ -f "$path" && ! -L "$path" ]] || die "Unsafe or absent apt source: $path"
  [[ $(stat -c '%U:%G %a' "$path") == 'root:root 644' ]] ||
    die "Apt source owner or mode mismatch: $path"
}

require_root_owned_keyring() {
  local path=$1 mode
  [[ -f "$path" && ! -L "$path" ]] || die "Unsafe or absent apt keyring: $path"
  [[ $(stat -c '%U:%G' "$path") == 'root:root' ]] || die "Apt keyring is not root-owned: $path"
  mode=$(stat -c '%a' "$path")
  (( (8#$mode & 8#022) == 0 )) || die "Apt keyring is group/world writable: $path"
}

active_source_lines() {
  sed -e 's/[[:space:]]\+$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' -- "$1"
}

require_exact_apt_sources() {
  local path
  local -a enabled_parts=()

  require_root_owned_source_file /etc/apt/sources.list
  [[ -z $(active_source_lines /etc/apt/sources.list) ]] ||
    die "/etc/apt/sources.list must contain comments only"

  shopt -s nullglob
  enabled_parts=(/etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources)
  shopt -u nullglob
  [[ ${#enabled_parts[@]} -eq 2 ]] || die "Unexpected enabled apt source file count"
  for path in "${enabled_parts[@]}"; do
    case "$path" in
      "$UBUNTU_SOURCES"|"$CADDY_SOURCES") ;;
      *) die "Unexpected enabled apt source file: $path" ;;
    esac
  done

  require_root_owned_source_file "$UBUNTU_SOURCES"
  require_root_owned_source_file "$CADDY_SOURCES"
  require_root_owned_keyring "$UBUNTU_KEYRING"
  require_root_owned_keyring "$CADDY_KEYRING"

  local expected_ubuntu expected_caddy actual
  expected_ubuntu=$(printf '%s\n' \
    'Types: deb' \
    'URIs: https://mirror.hetzner.com/ubuntu/packages' \
    'Suites: noble noble-updates noble-backports' \
    'Components: main universe restricted multiverse' \
    'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
    'Types: deb' \
    'URIs: https://mirror.hetzner.com/ubuntu/security' \
    'Suites: noble-security' \
    'Components: main universe restricted multiverse' \
    'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg')
  actual=$(active_source_lines "$UBUNTU_SOURCES")
  [[ "$actual" == "$expected_ubuntu" ]] || die "Hetzner Ubuntu apt source boundary mismatch"

  expected_caddy=$(printf '%s\n' \
    'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' \
    'deb-src [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main')
  actual=$(active_source_lines "$CADDY_SOURCES")
  [[ "$actual" == "$expected_caddy" ]] || die "Caddy apt source boundary mismatch"
}

require_no_docker_containers() {
  local containers
  containers=$(bounded 30 docker ps -aq --no-trunc) || die "Could not enumerate Docker containers"
  [[ -z "$containers" ]] || die "Host bootstrap refuses to restart Docker while any container exists"
}

backup_dropin() {
  local target=$1 label=$2 state=$3 original_hash backup_hash
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" && $(stat -c '%h' "$target") == 1 ]] ||
      die "Existing $label drop-in is not a single-link regular file"
    cp --archive -- "$target" "$state/$label.dropin"
    stat -c '%u:%g %a %s' "$target" > "$state/$label.dropin.stat"
    original_hash=$(sha256sum "$target" | awk '{print $1}')
    backup_hash=$(sha256sum "$state/$label.dropin" | awk '{print $1}')
    [[ "$backup_hash" == "$original_hash" ]] || die "$label drop-in rollback backup mismatch"
    printf '%s\n' "$original_hash" > "$state/$label.dropin.sha256"
  else
    : > "$state/$label.dropin.absent"
  fi
}

record_dropin_parent() {
  local target=$1 label=$2 state=$3 parent mode
  parent=$(dirname "$target")
  if [[ -e "$parent" || -L "$parent" ]]; then
    [[ -d "$parent" && ! -L "$parent" && $(realpath -e "$parent") == "$parent" ]] ||
      die "Unsafe existing $label drop-in directory"
    [[ $(stat -c '%U' "$parent") == root ]] || die "$label drop-in directory is not root-owned"
    mode=$(stat -c '%a' "$parent")
    (( (8#$mode & 8#022) == 0 )) || die "$label drop-in directory is group/world writable"
    : > "$state/$label.parent.present"
  else
    : > "$state/$label.parent.absent"
  fi
}

ensure_dropin_parent() {
  local target=$1
  if [[ ! -d $(dirname "$target") ]]; then
    install -d -o root -g root -m 0755 "$(dirname "$target")"
  fi
}

restore_dropin_parent() {
  local target=$1 label=$2 state=$3 parent
  parent=$(dirname "$target")
  if [[ -f "$state/$label.parent.absent" && -d "$parent" && ! -L "$parent" ]]; then
    rmdir -- "$parent"
  fi
}

restore_dropin() {
  local target=$1 label=$2 state=$3 temporary expected_hash actual_hash expected_stat actual_stat
  temporary="$(dirname "$target")/.99-slopproof-core-limit.restore.$$"
  if [[ -f "$state/$label.dropin.absent" ]]; then
    rm -f -- "$target"
  else
    expected_hash=$(<"$state/$label.dropin.sha256")
    actual_hash=$(sha256sum "$state/$label.dropin" | awk '{print $1}')
    [[ "$actual_hash" == "$expected_hash" ]] || return 1
    cp --archive -- "$state/$label.dropin" "$temporary"
    mv -Tf -- "$temporary" "$target"
    actual_hash=$(sha256sum "$target" | awk '{print $1}')
    [[ "$actual_hash" == "$expected_hash" ]] || return 1
    expected_stat=$(<"$state/$label.dropin.stat")
    actual_stat=$(stat -c '%u:%g %a %s' "$target")
    [[ "$actual_stat" == "$expected_stat" ]] || return 1
  fi
}

install_dropin() {
  local target=$1 temporary
  temporary="$(dirname "$target")/.99-slopproof-core-limit.$$"
  printf '%s\n' '[Service]' 'LimitCORE=0' > "$temporary"
  chown root:root "$temporary"
  chmod 0644 "$temporary"
  mv -Tf -- "$temporary" "$target"
  [[ $(stat -c '%U:%G %a' "$target") == 'root:root 644' ]] ||
    die "Installed core-limit drop-in owner or mode mismatch"
}

require_effective_core_limit() {
  local unit=$1 hard soft pid
  hard=$(systemctl show "$unit" --property=LimitCORE --value)
  soft=$(systemctl show "$unit" --property=LimitCORESoft --value)
  [[ "$hard" == 0 && "$soft" == 0 ]] || die "$unit does not have effective hard/soft LimitCORE=0"
  pid=$(systemctl show "$unit" --property=MainPID --value)
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/limits" ]] || die "$unit has no verifiable main process"
  awk '$1 == "Max" && $2 == "core" && $3 == "file" && $4 == "size" && $5 == "0" && $6 == "0" { found=1 } END { exit(found ? 0 : 1) }' \
    "/proc/$pid/limits" || die "$unit main process can create a core dump"
}

install_pinned_host_tools() {
  local node_candidate jq_candidate node_package jq_package node_runtime jq_runtime
  bounded 300 env DEBIAN_FRONTEND=noninteractive apt-get update
  node_candidate=$(apt-cache policy nodejs | awk '$1 == "Candidate:" { count += 1; candidate = $2 } END { if (count == 1) print candidate; else exit 1 }')
  jq_candidate=$(apt-cache policy jq | awk '$1 == "Candidate:" { count += 1; candidate = $2 } END { if (count == 1) print candidate; else exit 1 }')
  [[ "$node_candidate" == "$EXPECTED_NODEJS_PACKAGE" ]] || die "Unexpected nodejs apt candidate"
  [[ "$jq_candidate" == "$EXPECTED_JQ_PACKAGE" ]] || die "Unexpected jq apt candidate"
  bounded 300 env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    "nodejs=$EXPECTED_NODEJS_PACKAGE" "jq=$EXPECTED_JQ_PACKAGE"

  [[ $(command -v node) == /usr/bin/node && $(command -v jq) == /usr/bin/jq ]] ||
    die "Host tools must resolve to the Ubuntu package paths"
  node_package=$(dpkg-query -W -f='${Version}' nodejs)
  jq_package=$(dpkg-query -W -f='${Version}' jq)
  [[ "$node_package" == "$EXPECTED_NODEJS_PACKAGE" ]] || die "Installed nodejs package version mismatch"
  [[ "$jq_package" == "$EXPECTED_JQ_PACKAGE" ]] || die "Installed jq package version mismatch"
  node_runtime=$(node --version)
  jq_runtime=$(jq --version)
  [[ "$node_runtime" =~ ^v([0-9]+)\. ]] || die "Unparseable Node.js runtime version"
  (( BASH_REMATCH[1] >= 18 )) || die "Node.js runtime must be at least 18"
  [[ "$jq_runtime" =~ ^jq-1\.7([.]|$) ]] || die "jq runtime must be 1.7.x"
}

main() {
  local command state timestamp mutation_started=false complete=false shared_mode
  [[ $# -eq 0 ]] || die "Usage: bootstrap-host.sh"
  for command in apt-cache apt-get awk chmod chown cp date dirname docker dpkg dpkg-query env grep install mv realpath rm rmdir sed sha256sum stat systemctl timeout uname; do
    require_command "$command"
  done
  require_root_ubuntu_amd64
  ulimit -S -c 0
  ulimit -H -c 0
  [[ $(ulimit -S -c) == 0 && $(ulimit -H -c) == 0 ]] || die "Bootstrap shell core limit is not zero"
  require_exact_apt_sources
  [[ $(command -v sshd) == /usr/sbin/sshd ]] || die "OpenSSH server must resolve to /usr/sbin/sshd"
  bounded 30 /usr/sbin/sshd -t
  systemctl is-active --quiet docker.service || die "Docker must be active before bootstrap"
  systemctl is-active --quiet containerd.service || die "containerd must be active before bootstrap"
  systemctl is-active --quiet ssh.service || die "SSH must be active before bootstrap"
  require_no_docker_containers
  install_pinned_host_tools

  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  state="$STATE_ROOT/$timestamp"
  [[ ! -e "$state" ]] || die "Host-bootstrap state path already exists"
  [[ -d /opt/slopproof/shared && ! -L /opt/slopproof/shared && $(realpath -e /opt/slopproof/shared) == /opt/slopproof/shared ]] ||
    die "Unsafe /opt/slopproof/shared state parent"
  [[ $(stat -c '%U' /opt/slopproof/shared) == root ]] || die "Shared state parent is not root-owned"
  shared_mode=$(stat -c '%a' /opt/slopproof/shared)
  (( (8#$shared_mode & 8#022) == 0 )) || die "Shared state parent is group/world writable"
  if [[ -e "$STATE_ROOT" || -L "$STATE_ROOT" ]]; then
    [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && $(stat -c '%U:%G %a' "$STATE_ROOT") == 'root:root 700' ]] ||
      die "Unsafe existing host-bootstrap state root"
  else
    install -d -o root -g root -m 0700 "$STATE_ROOT"
  fi
  install -d -o root -g root -m 0700 "$state"
  record_dropin_parent "$DOCKER_DROPIN" docker "$state"
  record_dropin_parent "$CONTAINERD_DROPIN" containerd "$state"
  record_dropin_parent "$SSH_DROPIN" ssh "$state"
  backup_dropin "$DOCKER_DROPIN" docker "$state"
  backup_dropin "$CONTAINERD_DROPIN" containerd "$state"
  backup_dropin "$SSH_DROPIN" ssh "$state"
  printf 'schema=slopproof.host-bootstrap.v1\nnodejs_package=%s\nnode_runtime=%s\njq_package=%s\njq_runtime=%s\ncreated_at=%s\napport_boundary=not-relied-on-docker-containerd-ssh-service-core-limits-zero\n' \
    "$(dpkg-query -W -f='${Version}' nodejs)" "$(node --version)" \
    "$(dpkg-query -W -f='${Version}' jq)" "$(jq --version)" \
    "${timestamp:0:8}T${timestamp:9:6}Z" > "$state/receipt"

  rollback_failed_bootstrap() {
    local status=${1:-$?}
    trap - EXIT HUP INT TERM
    if [[ "$mutation_started" == true && "$complete" != true ]]; then
      restore_dropin "$DOCKER_DROPIN" docker "$state" || true
      restore_dropin "$CONTAINERD_DROPIN" containerd "$state" || true
      restore_dropin "$SSH_DROPIN" ssh "$state" || true
      restore_dropin_parent "$DOCKER_DROPIN" docker "$state" || true
      restore_dropin_parent "$CONTAINERD_DROPIN" containerd "$state" || true
      restore_dropin_parent "$SSH_DROPIN" ssh "$state" || true
      bounded 30 systemctl daemon-reload || true
      if bounded 30 /usr/sbin/sshd -t; then
        bounded 90 systemctl restart ssh.service || true
      fi
      local rollback_containers
      if rollback_containers=$(bounded 30 docker ps -aq --no-trunc) && [[ -z "$rollback_containers" ]]; then
        bounded 90 systemctl restart containerd.service docker.service || true
      fi
    fi
    exit "$status"
  }
  trap 'rollback_failed_bootstrap $?' EXIT
  trap 'rollback_failed_bootstrap 129' HUP
  trap 'rollback_failed_bootstrap 130' INT
  trap 'rollback_failed_bootstrap 143' TERM

  mutation_started=true
  ensure_dropin_parent "$DOCKER_DROPIN"
  ensure_dropin_parent "$CONTAINERD_DROPIN"
  ensure_dropin_parent "$SSH_DROPIN"
  install_dropin "$DOCKER_DROPIN"
  install_dropin "$CONTAINERD_DROPIN"
  install_dropin "$SSH_DROPIN"
  bounded 30 systemctl daemon-reload
  bounded 30 /usr/sbin/sshd -t
  require_no_docker_containers
  bounded 90 systemctl restart containerd.service docker.service
  bounded 90 systemctl restart ssh.service
  bounded 30 systemctl is-active --quiet containerd.service
  bounded 30 systemctl is-active --quiet docker.service
  bounded 30 systemctl is-active --quiet ssh.service
  require_effective_core_limit containerd.service
  require_effective_core_limit docker.service
  require_effective_core_limit ssh.service
  [[ $(ulimit -S -c) == 0 && $(ulimit -H -c) == 0 ]] || die "Bootstrap shell core limit changed"
  require_no_docker_containers

  complete=true
  trap - EXIT HUP INT TERM
  printf 'Host bootstrap passed: nodejs=%s jq=%s state=%s docker_containerd_ssh_core_limits=zero apport=not-relied-on\n' \
    "$EXPECTED_NODEJS_PACKAGE" "$EXPECTED_JQ_PACKAGE" "$state"
}

main "$@"
