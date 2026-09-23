#!/bin/sh
set -eu
control_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$control_root/.venv/bin/python" -I "$control_root/scripts/verify_environment.py"
"$control_root/.venv/bin/python" -m pip check
cd "$control_root"
"$control_root/.venv/bin/python" -m pytest "$@"
