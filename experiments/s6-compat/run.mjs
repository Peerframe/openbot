import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

assert(process.argv.length === 2, "This fixture accepts no database or configuration arguments.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const image =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const suffix = randomBytes(6).toString("hex");
const name = `openbot-s6-${suffix}`;
const database = `openbot_s6_test_${suffix}`;
const password = randomBytes(24).toString("hex");
let owned = false;
// Match the existing headless harness: keep OS/Docker prerequisites, exclude all product secrets.
const environment = Object.fromEntries(
  [
    "PATH",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(environment, {
  CI: "1",
  NO_COLOR: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_CACHE: "local:rw",
});

function run(command, args, { capture = false, env = environment, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? result.error?.message ?? "").replaceAll(
      password,
      "[fixture password]",
    );
    throw new Error(`${command} failed (${result.status ?? "unavailable"}). ${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

function cleanup() {
  if (!owned) return;
  owned = false;
  const result = spawnSync("docker", ["rm", "--force", name], {
    env: environment,
    stdio: "ignore",
    timeout: 20_000,
  });
  if (result.status !== 0) {
    console.error(`Could not remove owned fixture container ${name}.`);
    process.exitCode = 1;
  }
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    cleanup();
    process.exit(code);
  });
}

try {
  assert(
    existsSync(join(root, "node_modules/vitest/vitest.mjs")),
    "First run npm ci --ignore-scripts --no-audit.",
  );
  run(process.execPath, [
    join(root, "node_modules/turbo/bin/turbo"),
    "run",
    "build",
    "--filter=@openbot/node^...",
  ]);
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--project",
    "experiments/s6-compat/tsconfig.json",
  ]);
  run("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true, timeout: 15_000 });
  console.log("Starting owned S6 PostgreSQL fixture; all Bot/model/MCP inputs are synthetic.");
  // Record the generated name before starting so an uncertain launch also receives bounded cleanup.
  owned = true;
  run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=openbot_test",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      `POSTGRES_DB=${database}`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      image,
      "-c",
      "client_min_messages=warning",
    ],
    { capture: true, timeout: 180_000 },
  );
  const binding = run("docker", ["port", name, "5432/tcp"], { capture: true });
  assert(/^127\.0\.0\.1:\d+$/.test(binding), "Fixture must bind only to loopback.");
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync(
      "docker",
      ["exec", name, "pg_isready", "-U", "openbot_test", "-d", database],
      {
        env: environment,
        stdio: "ignore",
        timeout: 5000,
      },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    await delay(500);
  }
  assert(ready, "S6 PostgreSQL did not become ready.");
  run(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "experiments/s6-compat/compat.test.ts",
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--reporter=verbose",
    ],
    {
      env: {
        ...environment,
        OPENBOT_S6_TEST_DATABASE_URL: `postgres://openbot_test:${password}@${binding}/${database}`,
      },
    },
  );
  console.log(
    "S6 baseline probes passed, including current per-Run budget behavior. Shared Task admission and durable delegation acceptance remain open.",
  );
} finally {
  cleanup();
}
