import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Run one owned Node process and reap it before fixture files or its database are removed. */
export async function runConformanceChild(
  args,
  {
    cwd,
    env,
    signal,
    timeoutMs = 180_000,
    graceMs = 2000,
    stdout = (chunk) => process.stdout.write(chunk),
    stderr = (chunk) => process.stderr.write(chunk),
    onSpawn = () => {},
  },
) {
  // execFile's timeout alone sends SIGTERM but may never reject if a child ignores it. An
  // independent abort deadline rejects immediately and reaches the bounded forced-reap path.
  const execution = exec(process.execPath, args, {
    cwd,
    env,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    maxBuffer: 1024 * 1024,
  });
  const child = execution.child;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdout.on("data", stdout);
  child.stderr.on("data", stderr);
  onSpawn(child);
  try {
    await execution;
  } catch (error) {
    // execFile can reject on abort before the child closes. Never delete its resources first.
    const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
    throw new Error(
      `Conformance child failed (${error.code ?? "aborted"}); inspect the named stage and report.`,
    );
  }
}
