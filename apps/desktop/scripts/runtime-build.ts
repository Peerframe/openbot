/** Runs fixed native build tools with a bounded lifetime and filtered environment. */
import { spawn } from "node:child_process";
export async function runRuntimeBuildStage(
  stage: string,
  executable: string,
  args: string[],
  cwd: string,
  timeout = 60_000,
): Promise<void> {
  console.info(`[Native runtime] ${stage} (limit ${timeout} ms).`);
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      shell: false,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    function failure(
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnCode: string | null = null,
    ) {
      const elapsedMs = Math.round(performance.now() - started);
      // Preserve subprocess facts without printing potentially private paths or arguments.
      return Object.assign(
        new Error(
          `Native runtime stage "${stage}" failed after ${elapsedMs} ms ` +
            `(timeout=${timedOut}, code=${code}, signal=${signal}, spawn=${spawnCode}).`,
        ),
        { stage, elapsedMs, timedOut, exitCode: code, signal, spawnCode },
      );
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(failure(null, null, (error as NodeJS.ErrnoException).code ?? "unknown"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      code === 0 && !timedOut ? resolve() : reject(failure(code, signal));
    });
  });
}
