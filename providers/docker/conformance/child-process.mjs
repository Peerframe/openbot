import { spawn } from "node:child_process";
import { createOwnedProcessGroup } from "../../../scripts/owned-process-group.mjs";

/** Drain the owned POSIX group, including descendants, before deleting fixture resources. */
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
  signal.throwIfAborted();
  // execFile does not forward detached to spawn. Own a fresh group explicitly so Turbo's
  // descendants remain in the cleanup scope even after their immediate parent exits.
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const group = createOwnedProcessGroup(child, "Browser conformance");
  const closed = new Promise((resolve) => child.once("close", resolve));
  let finish;
  const outcome = new Promise((resolve) => {
    finish = resolve;
  });
  child.once("exit", (code, exitSignal) => finish({ code: code ?? exitSignal }));
  child.once("error", (error) => finish({ code: error.code ?? "SPAWN_ERROR" }));
  const abort = () => finish({ code: "ABORT_ERR" });
  signal.addEventListener("abort", abort, { once: true });
  // A deadline must wake the driver independently of child exit or inherited-pipe closure.
  const deadline = setTimeout(abort, timeoutMs);
  let outputBytes = 0;
  let outputFailure;
  for (const [stream, write] of [
    [child.stdout, stdout],
    [child.stderr, stderr],
  ]) {
    stream.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        outputFailure = "OUTPUT_LIMIT";
        finish({ code: outputFailure });
        return;
      }
      try {
        write(chunk);
      } catch {
        outputFailure = "OUTPUT_FAILED";
        finish({ code: outputFailure });
      }
    });
  }
  let result;
  let operationError;
  try {
    onSpawn(child);
    result = await outcome;
  } catch (error) {
    operationError = error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  }
  // The shared D2 lifecycle checks the complete known PGID and reaps the direct child. A
  // successful parent may also leave descendants; no exit path bypasses group cleanup.
  try {
    await group.stop({ graceMs });
  } catch (error) {
    child.stdout.destroy();
    child.stderr.destroy();
    throw error;
  }
  // Drain buffered stage output after group exit. An escaped session retaining a pipe cannot
  // extend cleanup indefinitely or produce a successful result; it is outside the group scope.
  let forcedPipeClose = false;
  const pipeDeadline = setTimeout(() => {
    forcedPipeClose = true;
    child.stdout.destroy();
    child.stderr.destroy();
  }, 1000);
  try {
    await closed;
  } finally {
    clearTimeout(pipeDeadline);
  }
  if (forcedPipeClose)
    throw new Error("Conformance child pipes did not close after group cleanup.");
  if (operationError) throw operationError;
  const code = outputFailure ?? result.code;
  if (code !== 0)
    throw new Error(`Conformance child failed (${code}); inspect the named stage and report.`);
}
