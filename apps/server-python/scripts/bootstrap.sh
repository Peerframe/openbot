#!/bin/sh
set -eu
control_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
control_python=${OPENBOT_CONTROL_PYTHON:-python3.12}
"$control_python" -c 'import sys; assert sys.version_info >= (3, 12)'
"$control_python" -m venv "$control_root/.venv"
"$control_root/.venv/bin/python" -m pip install --disable-pip-version-check -r "$control_root/requirements.lock"
"$control_root/.venv/bin/python" -I "$control_root/scripts/verify_environment.py"
