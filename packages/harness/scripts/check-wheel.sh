#!/bin/sh
# Real clean installation, outside the checkout; no PYTHONPATH, paid model or services.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sh "$here/scripts/build.sh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/openbot-harness-wheel.XXXXXX")
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
"${PYTHON:-python3.12}" -m venv "$fixture/venv"
"$fixture/venv/bin/python" -I -m pip --isolated install --disable-pip-version-check --only-binary=:all: --no-deps -r "$here/requirements-runtime.lock"
sh "$here/scripts/install-wheel.sh" "$fixture/venv/bin/python"
"$fixture/venv/bin/python" -I "$here/scripts/verify_environment.py" --profile runtime
"$fixture/venv/bin/python" -I -m pip check
cp "$here/examples/read_note.py" "$fixture/read_note.py"
cd "$fixture"
exec_result=0
"$fixture/venv/bin/python" -I "$fixture/read_note.py" || exec_result=$?
exit "$exec_result"
