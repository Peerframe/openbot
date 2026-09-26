#!/bin/sh
# Advisory lookups only. The actual product lock is audited without resolving or installing it.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/openbot-python-audit.XXXXXX")
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
"${PYTHON:-python3.12}" -m venv "$fixture/tools"
python="$fixture/tools/bin/python"
"$python" -I -m pip --isolated install --disable-pip-version-check --only-binary=:all: --no-deps -r "$root/scripts/requirements-python-audit.lock"
"$python" -I -m pip check
audit_status=0
"$python" -I -m pip_audit --strict --disable-pip --no-deps --vulnerability-service pypi --progress-spinner off \
  --requirement "$root/apps/server-python/requirements-product.lock" --format json --output "$fixture/result.json" || audit_status=$?
"$python" -I "$root/scripts/check-python-audit.py" "$root/apps/server-python/requirements-product.lock" "$fixture/result.json"
test "$audit_status" -eq 0
