#!/bin/sh
set -eu
control_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$control_root/.venv/bin/python" -I "$control_root/scripts/verify_environment.py"
"$control_root/.venv/bin/python" -m pip check
cd "$control_root"
# These modules execute in the separate Worker gate with its own locked dependencies.
worker_count=0
while IFS= read -r worker_test; do
  test -n "$worker_test"
  test -f "$worker_test"
  set -- "$@" "--ignore=$worker_test"
  worker_count=$((worker_count + 1))
done < "$control_root/worker-tests.txt"
test "$worker_count" -gt 0
printf 'Base profile: %s Worker files delegated to test:control:python with OPENBOT_TEMPORAL_TEST_PYTHON.\n' "$worker_count"
"$control_root/.venv/bin/python" -m pytest "$@"
