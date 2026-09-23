#!/bin/sh
# The upstream embedded YAML template does not escape arbitrary password characters.
set -eu
case "${POSTGRES_PWD:-}" in ''|*[!0-9a-fA-F]*) echo 'Runtime password must be random hexadecimal.' >&2; exit 2 ;; esac
[ "${#POSTGRES_PWD}" -ge 48 ] && [ "${#POSTGRES_PWD}" -le 128 ] || exit 2
if [ "${OPENBOT_REQUIRE_MTLS:-false}" = true ]; then
  [ "${TEMPORAL_TLS_REQUIRE_CLIENT_AUTH:-}" = true ] || exit 2
  [ "${TEMPORAL_TLS_INTERNODE_DISABLE_HOST_VERIFICATION:-}" = false ] || exit 2
  [ "${TEMPORAL_TLS_FRONTEND_DISABLE_HOST_VERIFICATION:-}" = false ] || exit 2
  [ "${TEMPORAL_TLS_INTERNODE_SERVER_NAME:-}" = temporal.openbot.internal ] || exit 2
  [ "${TEMPORAL_TLS_FRONTEND_SERVER_NAME:-}" = temporal.openbot.internal ] || exit 2
  [ "${TEMPORAL_TLS_SERVER_CERT:-}" = /openbot/tls/server.pem ] || exit 2
  [ "${TEMPORAL_TLS_SERVER_KEY:-}" = /openbot/tls/server.key ] || exit 2
  [ "${TEMPORAL_TLS_SERVER_CA_CERT:-}" = /openbot/tls/server-ca.pem ] || exit 2
  [ "${TEMPORAL_TLS_FRONTEND_CERT:-}" = /openbot/tls/server.pem ] || exit 2
  [ "${TEMPORAL_TLS_FRONTEND_KEY:-}" = /openbot/tls/server.key ] || exit 2
  [ "${TEMPORAL_TLS_CLIENT1_CA_CERT:-}" = /openbot/tls/client-ca.pem ] || exit 2
  [ "${TEMPORAL_TLS_CLIENT2_CA_CERT:-}" = /openbot/tls/server-ca.pem ] || exit 2
  for pem_file in /openbot/tls/server.pem /openbot/tls/server.key /openbot/tls/server-ca.pem /openbot/tls/client-ca.pem; do
    [ -f "$pem_file" ] && [ -s "$pem_file" ] && [ -r "$pem_file" ] || exit 2
  done
fi
exec /etc/temporal/entrypoint.sh
