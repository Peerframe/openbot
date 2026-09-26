import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ServerEnv } from "@openbot/config";
import type { AgentRuntimeExecutor } from "./agent-runtime.js";
import { createPythonAgentExecutor } from "./agent-runtime-process.js";

const runFile = promisify(execFile);
const defaultPackageRoot = fileURLToPath(new URL("../../agent-runtime-python/", import.meta.url));
const preflight = [
  "import sys, runpy",
  "assert sys.version_info >= (3, 12)",
  "sys.path.insert(0, sys.argv[1])",
  "import openbot_agent_runtime",
  'sys.argv = [sys.argv[2], "--profile", "auto"]',
  'runpy.run_path(sys.argv[0], run_name="__main__")',
].join("; ");

// The optional path is for trusted composition/tests only, never request or environment input.
export async function bootstrapAgentRuntime(
  env: Pick<ServerEnv, "OPENBOT_AGENT_RUNTIME">,
  packageRoot = defaultPackageRoot,
): Promise<AgentRuntimeExecutor | undefined> {
  if (env.OPENBOT_AGENT_RUNTIME === "typescript") return undefined;
  if (env.OPENBOT_AGENT_RUNTIME !== "python") throw new Error("Unknown Agent runtime selection.");
  if (process.platform === "win32")
    throw new Error("The Python Agent runtime currently requires a POSIX Server.");
  const pythonExecutable = join(packageRoot, ".venv", "bin", "python");
  const workerEntrypoint = join(packageRoot, "scripts", "run-worker.py");
  const verifier = join(packageRoot, "scripts", "verify_environment.py");
  let directory: string | undefined;
  try {
    await access(pythonExecutable, constants.X_OK);
    for (const path of [workerEntrypoint, verifier]) {
      if (!(await stat(path)).isFile()) throw new Error("Missing runtime entry point.");
    }
    directory = await mkdtemp(join(tmpdir(), "openbot-runtime-preflight-"));
    await runFile(
      pythonExecutable,
      ["-I", "-u", "-c", preflight, join(packageRoot, "src"), verifier],
      {
        cwd: directory,
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        timeout: 10_000,
        maxBuffer: 16_384,
        killSignal: "SIGKILL",
      },
    );
  } catch {
    // Do not surface interpreter output, inherited paths or local dependency diagnostics to logs.
    throw new Error(
      "Python Agent runtime preflight failed. Run apps/agent-runtime-python/scripts/bootstrap.sh and its checks before selecting python.",
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return createPythonAgentExecutor({ pythonExecutable, workerEntrypoint });
}
