#!/bin/sh
# The upstream embedded YAML template does not escape arbitrary password characters.
set -eu
case "${POSTGRES_PWD:-}" in ''|*[!0-9a-fA-F]*) echo 'Runtime password must be random hexadecimal.' >&2; exit 2 ;; esac
[ "${#POSTGRES_PWD}" -ge 48 ] && [ "${#POSTGRES_PWD}" -le 128 ] || exit 2
exec /etc/temporal/entrypoint.sh
