#!/bin/sh
# Package checks. Never installs anything: a missing environment is a failure.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"

if [ ! -x .venv/bin/python ]; then
  echo "no package-local virtualenv at ./.venv" >&2
  echo "run scripts/bootstrap.sh first; it is the only step that needs the network" >&2
  exit 1
fi

./.venv/bin/python scripts/verify_environment.py
exec ./.venv/bin/python -m pytest tests "$@"
