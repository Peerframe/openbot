#!/bin/sh
# Offline package checks: rebuild/install the local wheel; missing locked environments fail.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"

if [ ! -x .venv/bin/python ]; then
  echo "no package-local virtualenv at ./.venv" >&2
  echo "run scripts/bootstrap.sh first; it is the only step that needs the network" >&2
  exit 1
fi

sh scripts/build.sh
sh scripts/install-wheel.sh "$here/.venv/bin/python"
./.venv/bin/python scripts/verify_environment.py
exec ./.venv/bin/python -m pytest tests "$@"
