import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

assert(
  process.argv.slice(2).every((argument) => argument === "--python"),
  "Only --python is supported.",
);
const usePython = process.argv.includes("--python");
const root = fileURLToPath(new URL("../", import.meta.url));
const image =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const fixtureName = `openbot-runtime-${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let ownedContainer = false;
let databaseUrl = process.env.OPENBOT_COLLAB_TEST_DATABASE_URL;
// Only OS process prerequisites enter the test. Model keys, OPENBOT_DATABASE_URL,
// local dotenv configuration and paid provider settings are never inherited.
const environment = Object.fromEntries(
  [
    "PATH",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "HOME",
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
    // Container arguments include synthetic credentials; never include them in failure output.
    const detail = String(result.stderr ?? result.error?.message ?? "").replaceAll(
      password,
      "[fixture password]",
    );
    throw new Error(`${command} failed (${result.status ?? "unavailable"}). ${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

function cleanup() {
  if (ownedContainer) {
    ownedContainer = false;
    const removed = spawnSync("docker", ["rm", "--force", fixtureName], {
      env: environment,
      stdio: "ignore",
      timeout: 20_000,
    });
    if (removed.status !== 0)
      console.error(`Could not remove owned fixture container ${fixtureName}.`);
  }
}
process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  assert(
    existsSync(join(root, "node_modules/vitest/vitest.mjs")),
    "Install the lockfile first: npm ci --ignore-scripts.",
  );
  if (usePython) {
    assert(process.platform !== "win32", "Python process acceptance currently requires POSIX.");
    assert(
      existsSync(join(root, "apps/agent-runtime-python/scripts/run-worker.py")),
      "Python worker entry point is required; never fall back to the TypeScript loop.",
    );
    assert(
      existsSync(join(root, "apps/agent-runtime-python/.venv/bin/python")),
      "Bootstrap the package-local Python environment first.",
    );
    run("sh", [join(root, "apps/agent-runtime-python/scripts/check.sh"), "--maxfail=1"], {
      timeout: 300_000,
    });
  }
  if (!databaseUrl) {
    run("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true, timeout: 15_000 });
    console.log(
      "Starting a disposable loopback PostgreSQL fixture (first run may download the pinned image).",
    );
    run(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        fixtureName,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_USER=openbot_test",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        "POSTGRES_DB=openbot_collab_test_runtime",
        "--tmpfs",
        "/var/lib/postgresql/data",
        image,
        "-c",
        "client_min_messages=warning",
      ],
      { capture: true, timeout: 180_000 },
    );
    ownedContainer = true;
    const binding = run("docker", ["port", fixtureName, "5432/tcp"], { capture: true });
    assert(/^127\.0\.0\.1:\d+$/.test(binding), "Fixture must bind only to loopback.");
    databaseUrl = `postgres://openbot_test:${password}@${binding}/openbot_collab_test_runtime`;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const check = spawnSync(
        "docker",
        [
          "exec",
          fixtureName,
          "pg_isready",
          "-U",
          "openbot_test",
          "-d",
          "openbot_collab_test_runtime",
        ],
        { env: environment, stdio: "ignore", timeout: 5000 },
      );
      if (check.status === 0) {
        ready = true;
        break;
      }
      await delay(500);
    }
    assert(ready, "Disposable PostgreSQL did not become ready.");
  }
  const target = new URL(databaseUrl);
  assert(
    ["postgres:", "postgresql:"].includes(target.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
      /^\/openbot_collab_test_[a-z0-9_]+$/.test(target.pathname) &&
      !target.search &&
      !target.hash,
    "Use only a disposable loopback PostgreSQL database named openbot_collab_test_* without URL parameters; fixture tables are reset.",
  );
  run(process.execPath, [
    join(root, "node_modules/turbo/bin/turbo"),
    "run",
    "build",
    "--filter=@openbot/server^...",
  ]);
  run(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "apps/server/src/native-agent-headless.integration.test.ts",
      "apps/server/src/native-agent.test.ts",
      "apps/server/src/agent-runtime.test.ts",
      "apps/server/src/agent-runtime-executor.test.ts",
      "apps/server/src/agent-runtime-host.test.ts",
      "apps/server/src/agent-runtime-wire.test.ts",
      "apps/server/src/agent-runtime-process.test.ts",
      "apps/server/src/agent-runtime-bootstrap.test.ts",
      "apps/server/src/agent-collaboration.integration.test.ts",
      "--maxWorkers=1",
      "--no-file-parallelism",
    ],
    {
      timeout: usePython ? 300_000 : 120_000,
      env: {
        ...environment,
        OPENBOT_COLLAB_TEST_DATABASE_URL: databaseUrl,
        ...(usePython ? { OPENBOT_RUNTIME_TEST_PYTHON: "1" } : {}),
      },
    },
  );
  if (usePython)
    console.log(
      "Python SDK child process exercised through the real Server API and PostgreSQL fixture.",
    );
  console.log(
    "Headless runtime acceptance passed: real Server API, durable task/artifact delivery, failure, cancellation, disconnect and continuation regressions. No paid model call.",
  );
} finally {
  cleanup();
}
