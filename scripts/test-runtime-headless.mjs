// Public compatibility entry now targets the real Python child-process suite.
import { spawnSync } from "node:child_process";
if (process.argv.slice(2).some((arg) => arg !== "--python"))
  throw new Error("Only --python is supported.");
const result = spawnSync("sh", ["apps/agent-runtime-python/scripts/check.sh", "--maxfail=1"], {
  stdio: "inherit",
  timeout: 300_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
