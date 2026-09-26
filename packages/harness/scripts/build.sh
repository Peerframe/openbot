#!/bin/sh
# Offline build. Bootstrap the pinned build toolchain explicitly first.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"
.build-venv/bin/python -I scripts/verify_environment.py --profile build
.build-venv/bin/python -I scripts/check-metadata.py
exec .build-venv/bin/python -I -m hatchling build -t wheel
