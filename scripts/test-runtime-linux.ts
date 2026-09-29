import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  allowlistedEnvironment,
  cleanupOnTerminationSignals,
  OwnedDockerFixture,
} from "./python-acceptance-fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const suffix = randomBytes(6).toString("hex");
const runnerName = `openbot-python-test-${suffix}`;
const image = `openbot-python-acceptance:${suffix}`;
const environment = allowlistedEnvironment([
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
]);
const fixture = new OwnedDockerFixture(root, environment);

type DockerOptions = { readonly capture?: boolean; readonly timeout?: number };

// Build/attach output streams through; only captured metadata is returned.
function docker(
  args: readonly string[],
  { capture = false, timeout = 600_000 }: DockerOptions = {},
) {
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

cleanupOnTerminationSignals(() => fixture.cleanup());

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
  fixture.own("image", image);
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
  fixture.own("container", runnerName);
  docker(["start", "--attach", runnerName]);
  const exit = docker(["inspect", "--format", "{{.State.ExitCode}}", runnerName], {
    capture: true,
  });
  if (exit !== "0") throw new Error(`Linux acceptance exited ${exit}.`);
  console.log(
    "Linux/amd64 Python runtime acceptance passed; no paid model or external plugin call.",
  );
} finally {
  fixture.cleanup();
}
