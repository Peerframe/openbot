#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"
test -x .quality-venv/bin/python || "${PYTHON:-python3.12}" -m venv .quality-venv
.quality-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -r requirements-quality.lock
.quality-venv/bin/python -I scripts/verify_environment.py --profile quality
