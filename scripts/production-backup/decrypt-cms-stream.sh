#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 077

die() {
  builtin printf '%s\n' "$1" >&2
  exit 1
}

clear_backup_passphrase() {
  backup_passphrase=''
  unset backup_passphrase
}

restore_terminal() {
  if [[ "${terminal_echo_disabled:-false}" != true ]]; then
    return 0
  fi
  if ! /bin/stty "$terminal_state" 2>/dev/null < /dev/tty; then
    return 1
  fi
  terminal_echo_disabled=false
  terminal_state=''
}

cleanup_on_exit() {
  restore_terminal || true
  clear_backup_passphrase
}

cleanup_on_signal() {
  local status=$1
  trap - EXIT HUP INT TERM
  restore_terminal || true
  clear_backup_passphrase
  exit "$status"
}

[[ $- != *x* ]] || die "Shell tracing must be disabled"
[[ $# -eq 6 && $1 == --ciphertext && $3 == --recipient-certificate &&
  $5 == --recipient-key ]] || die "Invalid CMS decryption arguments"

ciphertext=$2
recipient_certificate=$4
recipient_key=$6
for path in "$ciphertext" "$recipient_certificate" "$recipient_key"; do
  [[ "$path" == /* && -f "$path" && ! -L "$path" ]] ||
    die "CMS decryption input is unsafe"
done

key_header=''
IFS= read -r key_header < "$recipient_key" ||
  die "Backup private key is not encrypted"
[[ "$key_header" == '-----BEGIN ENCRYPTED PRIVATE KEY-----' ]] ||
  die "Backup private key is not encrypted"
key_header=''
unset key_header

backup_passphrase=''
terminal_state=''
terminal_echo_disabled=false
trap cleanup_on_exit EXIT
trap 'cleanup_on_signal 129' HUP
trap 'cleanup_on_signal 130' INT
trap 'cleanup_on_signal 143' TERM
if ! terminal_state=$(/bin/stty -g 2>/dev/null < /dev/tty); then
  die "Backup private-key terminal is unavailable"
fi
[[ -n "$terminal_state" ]] || die "Backup private-key terminal is unavailable"
# Arm cleanup before changing the terminal. The prompt is emitted only after
# ECHO is disabled, closing the prompt/read scheduling race for immediate paste.
terminal_echo_disabled=true
if ! /bin/stty -echo 2>/dev/null < /dev/tty; then
  die "Backup private-key terminal is unavailable"
fi
if ! builtin printf '%s' 'Backup private-key passphrase: ' 2>/dev/null > /dev/tty; then
  die "Backup private-key terminal is unavailable"
fi
if ! IFS= builtin read -r backup_passphrase 2>/dev/null < /dev/tty; then
  restore_terminal || true
  builtin printf '\n' 2>/dev/null > /dev/tty || true
  die "Backup private-key passphrase input failed"
fi
if ! restore_terminal; then
  die "Backup private-key terminal restoration failed"
fi
if ! builtin printf '\n' 2>/dev/null > /dev/tty; then
  die "Backup private-key terminal is unavailable"
fi
[[ -n "$backup_passphrase" ]] || die "Backup private-key passphrase is empty"

if ! builtin printf '%s\n' "$backup_passphrase" |
  openssl cms -decrypt -binary -inform DER -in "$ciphertext" \
    -recip "$recipient_certificate" -inkey "$recipient_key" -passin stdin \
    -keyopt rsa_padding_mode:oaep \
    -keyopt rsa_oaep_md:sha256 \
    -keyopt rsa_mgf1_md:sha256 2>/dev/null; then
  die "Authenticated CMS decryption failed"
fi

clear_backup_passphrase
trap - EXIT HUP INT TERM
