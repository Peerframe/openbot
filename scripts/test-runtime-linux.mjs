import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const suffix = randomBytes(6).toString("hex");
const databaseName = `openbot-python-db-${suffix}`;
const runnerName = `openbot-python-test-${suffix}`;
const password = randomBytes(24).toString("hex");
const image = `openbot-python-acceptance:${suffix}`;
const postgresImage =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const databaseUrl = `postgres://openbot_test:${password}@127.0.0.1:5432/openbot_collab_test_linux`;
const environment = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
let imageOwned = false;
let databaseOwned = false;
let runnerOwned = false;

function docker(args, { capture = false, timeout = 600_000 } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? result.error?.message ?? "").replaceAll(
      password,
      "[fixture password]",
    );
    throw new Error(`Linux runtime fixture failed (${result.status ?? "unavailable"}). ${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

function cleanup() {
  for (const name of [
    ...(runnerOwned ? [runnerName] : []),
    ...(databaseOwned ? [databaseName] : []),
  ]) {
    const removed = spawnSync("docker", ["rm", "--force", name], {
      env: environment,
      stdio: "ignore",
      timeout: 20_000,
    });
    if (removed.status !== 0) console.error(`Could not remove owned fixture ${name}.`);
  }
  if (imageOwned) {
    const removed = spawnSync("docker", ["image", "rm", image], {
      env: environment,
      stdio: "ignore",
      timeout: 20_000,
    });
    if (removed.status !== 0) console.error(`Could not remove owned fixture image ${image}.`);
    imageOwned = false;
  }
  runnerOwned = false;
  databaseOwned = false;
}
for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    cleanup();
    process.exit(status);
  });
}

try {
  docker(["info", "--format", "{{.ServerVersion}}"], { capture: true, timeout: 15_000 });
  docker([
    "build",
    "--platform",
    "linux/amd64",
    "--file",
    "deploy/runtime-acceptance/Dockerfile",
    "--tag",
    image,
    ".",
  ]);
  imageOwned = true;
  console.log("Starting owned Linux/amd64 PostgreSQL and Python runtime acceptance fixtures.");
  docker(
    [
      "create",
      "--name",
      databaseName,
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--env",
      "POSTGRES_USER=openbot_test",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      "POSTGRES_DB=openbot_collab_test_linux",
      "--tmpfs",
      "/var/lib/postgresql/data",
      postgresImage,
      "-c",
      "client_min_messages=warning",
    ],
    { capture: true },
  );
  databaseOwned = true;
  docker(["start", databaseName], { capture: true });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const check = spawnSync(
      "docker",
      ["exec", databaseName, "pg_isready", "-U", "openbot_test", "-d", "openbot_collab_test_linux"],
      {
        env: environment,
        stdio: "ignore",
        timeout: 5_000,
      },
    );
    if (check.status === 0) {
      ready = true;
      break;
    }
    await delay(500);
  }
  if (!ready) throw new Error("Linux fixture database did not become ready.");
  docker(
    [
      "create",
      "--name",
      runnerName,
      "--init",
      "--platform",
      "linux/amd64",
      "--network",
      `container:${databaseName}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=512",
      "--memory=3g",
      "--env",
      `OPENBOT_COLLAB_TEST_DATABASE_URL=${databaseUrl}`,
      image,
    ],
    { capture: true },
  );
  runnerOwned = true;
  docker(["start", "--attach", runnerName]);
  const exit = docker(["inspect", "--format", "{{.State.ExitCode}}", runnerName], {
    capture: true,
  });
  if (exit !== "0") throw new Error(`Linux acceptance exited ${exit}.`);
  console.log(
    "Linux/amd64 Python runtime acceptance passed; no paid model or external plugin call.",
  );
} finally {
  cleanup();
}
