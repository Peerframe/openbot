#!/bin/sh
# The build toolchain is separate from execution and test environments.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"
if [ ! -x .build-venv/bin/python ]; then
  "${PYTHON:-python3.12}" -m venv .build-venv
fi
.build-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -r requirements-build.lock
.build-venv/bin/python -I scripts/verify_environment.py --profile build
