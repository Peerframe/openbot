#!/bin/sh
# One tool environment; ordinary core and real Worker integrations have distinct type inputs.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here/../.."
quality="$here/.quality-venv/bin/python"
worker="$here/../../apps/server-python/.worker-venv/bin/python"
profile=${1:---all}
case "$profile" in --core|--all) ;; *) echo 'usage: quality.sh [--core|--all]' >&2; exit 2;; esac
test "$#" -le 1 || exit 2
"$quality" -I "$here/scripts/verify_environment.py" --profile quality
"$quality" -I "$here/scripts/check-boundaries.py"
if [ "$profile" = --core ]; then
  "$here/.venv/bin/python" -I "$here/scripts/verify_environment.py" --profile dev
  "$quality" -m ruff check --config "$here/pyproject.toml" "$here/src" "$here/scripts" "$here/examples"
  "$quality" -m ruff format --config "$here/pyproject.toml" --check "$here/src" "$here/scripts" "$here/examples"
  # Only the two optional Temporal adapters belong to the Worker gate. No missing-import
  # suppression or fake SDK stubs: --all checks both against the actual locked SDK.
  exec "$quality" -m mypy --config-file "$here/pyproject.toml" \
    --python-executable "$here/.venv/bin/python" --exclude '/temporal_(agent|guard)\.py$' \
    "$here/src" "$here/examples"
fi
"$worker" -I apps/server-python/scripts/verify_environment.py --worker
set -- scripts/check-python-audit.py apps/server-python/scripts/derive-product-lock.py apps/server-python/scripts/export-work-contract.py apps/server-python/scripts/work-contract-fixtures.py apps/server-python/scripts/check-tool-types.py
set -- "$@" apps/server-python/src/openbot_server/work_runtime_ports.py apps/server-python/src/openbot_server/work_tool_results.py
"$quality" -m ruff check --config "$here/pyproject.toml" "$here/src" "$here/scripts" "$here/examples" "$@"
"$quality" -m ruff format --config "$here/pyproject.toml" --check "$here/src" "$here/scripts" "$here/examples" "$@"
MYPYPATH="$here/../../apps/server-python/src" "$quality" -m mypy --config-file "$here/pyproject.toml" --python-executable "$worker" "$here/src" "$here/examples" "$@" apps/server-python/scripts/verify_environment.py apps/server-python/src/openbot_server/work_product_reads.py apps/server-python/src/openbot_server/work_product_web.py
