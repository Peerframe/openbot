#!/bin/sh
# One lint/format and one type entry. Optional SDK types come from the actual Worker closure.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here/../.."
quality="$here/.quality-venv/bin/python"
worker="$here/../../apps/server-python/.worker-venv/bin/python"
"$quality" -I "$here/scripts/verify_environment.py" --profile quality
"$quality" -I "$here/scripts/check-boundaries.py"
set -- scripts/check-python-audit.py apps/server-python/scripts/derive-product-lock.py apps/server-python/scripts/export-work-contract.py apps/server-python/scripts/work-contract-fixtures.py
"$quality" -m ruff check --config "$here/pyproject.toml" "$here/src" "$here/scripts" "$here/examples" "$@" apps/server-python/src/openbot_server/work_runtime_ports.py
"$quality" -m ruff format --config "$here/pyproject.toml" --check "$here/src" "$here/scripts" "$here/examples" "$@" apps/server-python/src/openbot_server/work_runtime_ports.py
MYPYPATH="$here/../../apps/server-python/src" "$quality" -m mypy --config-file "$here/pyproject.toml" --python-executable "$worker" "$here/src" "$here/examples" "$@" apps/server-python/scripts/verify_environment.py apps/server-python/src/openbot_server/work_runtime_ports.py
