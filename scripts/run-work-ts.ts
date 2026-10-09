import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowlistedEnvironment } from "./python-acceptance-fixture.ts";

import { qualifyCommandInterop } from "./ts-work-command-interop.ts";

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args[0] !== undefined && !["--drain-only", "--recovery-only"].includes(args[0]))
)
  throw new Error("Work qualification accepts only --drain-only or --recovery-only.");
const root = fileURLToPath(new URL("../", import.meta.url));
const python =
  process.env.OPENBOT_TEMPORAL_TEST_PYTHON ??
  join(root, "apps/server-python/.worker-venv/bin/python");
const env = allowlistedEnvironment([
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
]);
const verified = spawnSync(
  python,
  ["-I", "apps/server-python/scripts/verify_environment.py", "--worker"],
  { cwd: root, env, stdio: "inherit", timeout: 30_000 },
);
if (verified.error || verified.status !== 0)
  throw new Error(
    "The existing pinned Worker environment is required; no installation was attempted.",
  );
await qualifyCommandInterop(python);
const child = spawn(
  python,
  ["-I", "experiments/work-journey/ts_control_probe.py", "--node", process.execPath, ...args],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
