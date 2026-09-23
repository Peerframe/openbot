#!/bin/sh
# Called through maintain.py after both databases pass read-only preflight.
# This guard prevents accidental raw use; a trusted administrator can bypass it.
set -eu
[ "${OPENBOT_TEMPORAL_SCHEMA_PREFLIGHT:-}" = passed ] || { echo 'Use maintain.py for schema maintenance.' >&2; exit 2; }
mode=${1:-}
case "$mode" in initialize|upgrade) ;; *) exit 2 ;; esac
for database in temporal temporal_visibility; do
  if [ "$mode" = initialize ]; then
    temporal-sql-tool --db "$database" setup-schema -v 0.0
  fi
  directory=temporal
  target=1.19
  if [ "$database" = temporal_visibility ]; then directory=visibility; target=1.14; fi
  # Never use --quiet (suppresses failure) or --overwrite.
  temporal-sql-tool --db "$database" update-schema -d "/etc/temporal/schema/postgresql/v12/$directory/versioned" -v "$target"
done
