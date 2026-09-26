import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const suffix = randomBytes(6).toString("hex");
const runnerName = `openbot-python-test-${suffix}`;
const image = `openbot-python-acceptance:${suffix}`;
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
    const detail = String(result.stderr ?? result.error?.message ?? "");
    throw new Error(`Linux runtime fixture failed (${result.status ?? "unavailable"}). ${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

function cleanup() {
  for (const name of [...(runnerOwned ? [runnerName] : [])]) {
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
  console.log("Starting owned Linux/amd64 Python runtime acceptance fixture.");
  docker(
    [
      "create",
      "--name",
      runnerName,
      "--init",
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=512",
      "--memory=3g",
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
