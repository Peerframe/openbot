#!/bin/sh
# Create the package-local virtual environment and install the frozen resolution.
#
# This is the only networked step in the package. It never installs globally and
# never touches a user interpreter outside ./.venv. Override the interpreter with
# PYTHON=/path/to/python3.12 if `python3.12` is not on PATH; the version, not a
# machine-specific path, is what the package requires (>=3.12).
#
# pip is deliberately **not** upgraded. `python -m venv` provisions the pip wheel
# bundled with the chosen interpreter, so the installer version is reproducible
# from the interpreter rather than floating to whatever is latest on PyPI. The
# locked closure is resolved by that bundled pip.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"

python_bin=${PYTHON:-python3.12}

if [ -x .venv/bin/python ]; then
  echo "reusing existing .venv"
else
  "$python_bin" -m venv .venv
fi

./.venv/bin/python -m pip install --disable-pip-version-check --quiet -r requirements.lock
./.venv/bin/python scripts/verify_environment.py
