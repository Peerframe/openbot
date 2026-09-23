#!/bin/sh
set -eu
# Docker supplies this init; report the actual reaper used by descendant lifecycle tests.
/sbin/docker-init --version
node scripts/test-runtime-headless.mjs --python
# The control process never inherits the synthetic database credential used by the TS fixture.
# Fail on a missing SDK environment; silently skipped integration is not Linux acceptance.
test -x apps/agent-runtime-python/.venv/bin/python
env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  apps/server-python/scripts/check.sh tests/test_runtime_host.py tests/test_runtime_wire.py \
  tests/test_runtime_process.py tests/test_runtime_sdk_integration.py \
  tests/test_runtime_spawn_integration.py -q
