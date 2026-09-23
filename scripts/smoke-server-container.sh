#!/usr/bin/env bash
set -euo pipefail

image="${OPENBOT_TEST_IMAGE:-openbot-server:smoke}"
agent_runtime="${OPENBOT_TEST_AGENT_RUNTIME:-typescript}"
case "$agent_runtime" in
  typescript | python) ;;
  *) echo "Unsupported Agent runtime smoke selection." >&2; exit 1 ;;
esac
case "${OPENBOT_TEST_PLATFORM:-$(uname -m)}" in
  amd64 | x86_64) expected_arch="amd64" ;;
  arm64 | aarch64) expected_arch="arm64" ;;
  *)
    echo "Unsupported Server container smoke architecture." >&2
    exit 1
    ;;
esac

suffix="${GITHUB_RUN_ID:-local}-$$"
network="openbot-server-smoke-${suffix}"
postgres_container="openbot-postgres-smoke-${suffix}"
server_container="openbot-server-smoke-${suffix}"
invalid_server_container="openbot-server-invalid-smoke-${suffix}"
invalid_python_container="openbot-python-invalid-smoke-${suffix}"
object_volume="openbot-server-objects-${suffix}"
model_volume="openbot-server-model-${suffix}"
database_password="openbot-container-ci-only"

cleanup() {
  set +e
  docker rm --force "$server_container" >/dev/null 2>&1
  docker rm --force "$invalid_server_container" >/dev/null 2>&1
  docker rm --force "$invalid_python_container" >/dev/null 2>&1
  docker rm --force "$postgres_container" >/dev/null 2>&1
  docker volume rm --force "$object_volume" >/dev/null 2>&1
  docker volume rm --force "$model_volume" >/dev/null 2>&1
  docker network rm "$network" >/dev/null 2>&1
}
trap cleanup EXIT

wait_for_health() {
  local container="$1"
  local health=""
  local state=""
  for _ in $(seq 1 60); do
    state="$(docker inspect --format '{{.State.Status}}' "$container")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container")"
    if [[ "$health" == "healthy" ]]; then
      return 0
    fi
    if [[ "$state" != "running" ]]; then
      docker logs "$container" >&2
      echo "Container $container stopped before becoming healthy." >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$container" >&2
  echo "Container $container did not become healthy." >&2
  return 1
}

actual_arch="$(docker image inspect --format '{{.Architecture}}' "$image")"
if [[ "$actual_arch" != "$expected_arch" ]]; then
  echo "Expected image architecture $expected_arch, found $actual_arch." >&2
  exit 1
fi

runtime_version="$(docker run --rm --entrypoint node "$image" --version)"
if [[ "$runtime_version" != "v24.21.0" ]]; then
  echo "Expected Node v24.21.0, found $runtime_version." >&2
  exit 1
fi

runtime_uid="$(docker run --rm --entrypoint id "$image" -u)"
if [[ "$runtime_uid" == "0" ]]; then
  echo "Server image must not run as root." >&2
  exit 1
fi

docker run --rm --entrypoint node "$image" --input-type=commonjs --eval '
  const { existsSync } = require("node:fs");
  const requiredModules = ["hono", "@openbot/config", "@openbot/db", "@openbot/domain"];
  for (const name of requiredModules) require.resolve(name);
  const forbiddenModules = ["electron", "tsx", "turbo", "typescript", "vite", "vitest"];
  for (const name of forbiddenModules) {
    try {
      require.resolve(name);
      throw new Error(`Development or unrelated module is present: ${name}`);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  const requiredPaths = [
    "apps/server/dist/index.js",
    "packages/db/migrations/meta/_journal.json",
    "deploy/server/healthcheck.mjs",
  ];
  for (const path of requiredPaths) {
    if (!existsSync(path)) throw new Error(`Required runtime path is missing: ${path}`);
  }
  const forbiddenPaths = [
    ".git",
    ".env",
    "apps/desktop",
    "apps/node",
    "apps/server/src",
    "apps/web",
    "docs",
    "packages/db/src",
    "providers",
  ];
  for (const path of forbiddenPaths) {
    if (existsSync(path)) throw new Error(`Non-runtime path is present: ${path}`);
  }
'

# Nested Server workspace production closure + advisory export filename coverage.
# Resolves modules the same way apps/server/dist/*.js does (walks apps/server/node_modules
# before the root), and imports the exact module that failed dual-arch CI with
# ERR_MODULE_NOT_FOUND for filename-reserved-regex.
docker run --rm --entrypoint node "$image" --input-type=module --eval '
  import { createRequire } from "node:module";
  import { existsSync } from "node:fs";

  const requireFromServerDist = createRequire(
    new URL("./apps/server/dist/employee-package.js", import.meta.url),
  );
  for (const name of ["filename-reserved-regex", "hono", "zod", "@openbot/protocol"]) {
    requireFromServerDist.resolve(name);
  }
  for (const name of ["@types/filename-reserved-regex", "tsx", "vitest", "typescript"]) {
    try {
      requireFromServerDist.resolve(name);
      throw new Error(`Development or unrelated module is present in Server closure: ${name}`);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }

  const { buildEmployeeTemplate } = await import("./apps/server/dist/employee-package.js");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const result = buildEmployeeTemplate(
    {
      employee: {
        id: "container-smoke-employee",
        name: "CON",
        role: "Container smoke",
        status: "idle",
        computerProfile: "docker-linux",
        appearance: {
          head: "round",
          body: "classic",
          mobility: "feet",
          accessory: "none",
          accent: "green",
        },
        createdAt: timestamp,
      },
      details: {
        description: "Native container export filename coverage.",
        revision: 1,
        updatedAt: timestamp,
      },
      evolution: [],
      skills: [],
      memories: [],
      memoryEvents: [],
      records: { runs: [], approvals: [], artifacts: [], decisions: [] },
      statistics: {
        totalRuns: 0,
        completedRuns: 0,
        failedRuns: 0,
        verifiedSkills: 0,
      },
      configuration: {
        executionProfile: "none",
        portabilityFormat: "openbot.employee/v1",
      },
    },
    {
      generatedAt: timestamp,
      packageId: "00000000-0000-4000-8000-000000000043",
    },
  );
  if (result.preview.fileName !== "con-employee.openbot-employee.json") {
    throw new Error(`Unexpected advisory export filename: ${result.preview.fileName}`);
  }
  // Nested path may be empty when everything hoists, but when the lock nests a
  // Server production package it must be present in the image (not only at root).
  if (
    existsSync("apps/server/node_modules/filename-reserved-regex/package.json") === false &&
    existsSync("node_modules/filename-reserved-regex/package.json") === false
  ) {
    throw new Error("filename-reserved-regex missing from both nested and root production closures");
  }
'


expected_migration_count="$(docker run --rm --entrypoint node "$image" --input-type=module --eval '
  import { readFile } from "node:fs/promises";
  const journal = JSON.parse(await readFile("packages/db/migrations/meta/_journal.json", "utf8"));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) process.exit(1);
  console.log(journal.entries.length);
')"

docker network create --internal "$network" >/dev/null
docker volume create "$object_volume" >/dev/null
docker volume create "$model_volume" >/dev/null
docker run --detach \
  --name "$postgres_container" \
  --network "$network" \
  --env POSTGRES_DB=openbot \
  --env POSTGRES_USER=openbot \
  --env "POSTGRES_PASSWORD=$database_password" \
  --health-cmd "pg_isready -U openbot -d openbot" \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 30 \
  postgres:17.11-bookworm >/dev/null
wait_for_health "$postgres_container"

database_url="postgres://openbot:${database_password}@${postgres_container}:5432/openbot"

if [[ "$agent_runtime" == "python" ]]; then
  # A missing installed interpreter must stop startup before any durable initialization.
  docker run --detach --name "$invalid_python_container" --network "$network" \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
    --tmpfs /workspace/apps/agent-runtime-python/.venv:ro,noexec,nosuid,nodev,size=1m \
    --env "OPENBOT_DATABASE_URL=$database_url" \
    --env OPENBOT_OWNER_PASSWORD=openbot-container-owner-password \
    --env OPENBOT_AGENT_RUNTIME=python "$image" >/dev/null
  for _ in $(seq 1 15); do
    [[ "$(docker inspect --format '{{.State.Status}}' "$invalid_python_container")" != "running" ]] && break
    sleep 1
  done
  if [[ "$(docker inspect --format '{{.State.Status}}' "$invalid_python_container")" == "running" ]] ||
     [[ "$(docker inspect --format '{{.State.ExitCode}}' "$invalid_python_container")" == "0" ]]; then
    echo "Broken Python installation did not stop startup." >&2
    exit 1
  fi
  if ! docker logs "$invalid_python_container" 2>&1 | grep --quiet 'Python Agent runtime preflight failed'; then
    echo "Broken Python installation did not fail at the fixed preflight." >&2
    exit 1
  fi
  if [[ "$(docker exec "$postgres_container" psql -U openbot -d openbot -Atc "select count(*) from pg_namespace where nspname='drizzle'")" != "0" ]]; then
    echo "Python preflight failure changed the fresh database." >&2
    exit 1
  fi
fi
docker run --detach \
  --name "$invalid_server_container" \
  --network "$network" \
  --env "OPENBOT_DATABASE_URL=$database_url" \
  "$image" >/dev/null
invalid_state=""
for _ in $(seq 1 10); do
  invalid_state="$(docker inspect --format '{{.State.Status}}' "$invalid_server_container")"
  [[ "$invalid_state" != "running" ]] && break
  sleep 1
done
if [[ "$invalid_state" == "running" ]]; then
  echo "Server image started without the required Owner password." >&2
  exit 1
fi
invalid_exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$invalid_server_container")"
if [[ "$invalid_exit_code" == "0" ]]; then
  echo "Server image accepted missing required configuration without an error." >&2
  exit 1
fi

docker run --detach \
  --name "$server_container" \
  --network "$network" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
  --mount "type=volume,src=${object_volume},dst=/var/lib/openbot/objects" \
  --mount "type=volume,src=${model_volume},dst=/var/lib/openbot/model" \
  --env OPENBOT_MODEL_DIRECTORY=/var/lib/openbot/model \
  --env "OPENBOT_AGENT_RUNTIME=$agent_runtime" \
  --env OPENBOT_HOST=0.0.0.0 \
  --env OPENBOT_PORT=3001 \
  --env "OPENBOT_DATABASE_URL=$database_url" \
  --env OPENBOT_OWNER_NAME=Owner \
  --env OPENBOT_OWNER_PASSWORD=openbot-container-owner-password \
  --env OPENBOT_ALLOWED_ORIGINS=http://localhost:5173 \
  "$image" >/dev/null
wait_for_health "$server_container"

if [[ "$agent_runtime" == "python" ]]; then
  docker exec "$server_container" /workspace/apps/agent-runtime-python/.venv/bin/python -I \
    /workspace/apps/agent-runtime-python/scripts/verify_environment.py --profile runtime
  docker exec "$server_container" /workspace/apps/agent-runtime-python/.venv/bin/python -I -c '
import importlib.util
from pathlib import Path
assert importlib.util.find_spec("pytest") is None
assert not Path("/workspace/apps/agent-runtime-python/tests").exists()
'
  # Resolve the piped module imports against /workspace/scripts, without installing a test runner.
  docker exec -i --workdir /workspace/scripts "$server_container" node --input-type=module \
    < scripts/smoke-python-runtime.mjs
fi

docker exec "$server_container" node --input-type=module --eval '
  const response = await fetch("http://127.0.0.1:3001/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ password: "openbot-container-owner-password" }),
  });
  if (!response.ok) throw new Error(`Owner login failed: ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Owner session missing");
  const channels = await fetch("http://127.0.0.1:3001/api/v1/channels", { headers: { Cookie: cookie } });
  if (!channels.ok) throw new Error(`Authenticated channels failed: ${channels.status}`);
'

health_body="$(docker exec "$server_container" node --input-type=module --eval '
  const response = await fetch("http://127.0.0.1:3001/health", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) process.exit(1);
  console.log(await response.text());
')"
if ! grep --quiet '"ok":true' <<<"$health_body" ||
  ! grep --quiet '"service":"openbot-server"' <<<"$health_body"; then
  echo "Server container returned an unexpected health identity." >&2
  exit 1
fi

migration_count_before="$(docker exec "$postgres_container" \
  psql --username openbot --dbname openbot --tuples-only --no-align \
  --command 'select count(*) from drizzle.__drizzle_migrations;' | tr -d '[:space:]')"
if [[ "$migration_count_before" != "$expected_migration_count" ]]; then
  echo "Server container did not apply the complete PostgreSQL migration journal." >&2
  exit 1
fi

docker exec "$server_container" node --input-type=module --eval '
  import { writeFile } from "node:fs/promises";
  import { bootstrapModelSettings } from "./apps/server/dist/model-settings-bootstrap.js";
  const models = await bootstrapModelSettings({ OPENBOT_MODEL_DIRECTORY: "/var/lib/openbot/model" },
    async () => Response.json({ id: "container-smoke-model" }));
  await models.save({ provider: "openai", model: "container-smoke-model", apiKey: "container-test-key-private", revision: null, agentEnabled: false });
  await writeFile("/var/lib/openbot/objects/container-smoke", "ok", { flag: "wx", mode: 0o600 });
'

docker restart --time 20 "$server_container" >/dev/null
wait_for_health "$server_container"
docker exec "$server_container" node --input-type=module --eval '
  import { readFile } from "node:fs/promises";
  import { bootstrapModelSettings } from "./apps/server/dist/model-settings-bootstrap.js";
  const models = await bootstrapModelSettings({ OPENBOT_MODEL_DIRECTORY: "/var/lib/openbot/model" });
  const summary = await models.summary();
  if (summary.status !== "configured" || summary.model !== "container-smoke-model" || summary.agentEnabled !== false) process.exit(1);
  if (await readFile("/var/lib/openbot/objects/container-smoke", "utf8") !== "ok") process.exit(1);
'

migration_count_after="$(docker exec "$postgres_container" \
  psql --username openbot --dbname openbot --tuples-only --no-align \
  --command 'select count(*) from drizzle.__drizzle_migrations;' | tr -d '[:space:]')"
if [[ "$migration_count_after" != "$migration_count_before" ]]; then
  echo "Server restart changed the applied migration count." >&2
  exit 1
fi

docker stop --time 20 "$server_container" >/dev/null
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$server_container")"
if [[ "$exit_code" != "0" ]]; then
  docker logs "$server_container" >&2
  echo "Server container exited with status $exit_code after SIGTERM." >&2
  exit 1
fi

server_logs="$(docker logs "$server_container" 2>&1)"
if ! grep --quiet 'server.shutdown_started' <<<"$server_logs"; then
  echo "Server container did not record graceful shutdown." >&2
  exit 1
fi
if grep --quiet 'server.shutdown_failed' <<<"$server_logs"; then
  echo "Server container recorded a failed shutdown." >&2
  exit 1
fi

echo "Server container smoke passed for linux/${expected_arch} (${agent_runtime}) with ${migration_count_after} migrations."
