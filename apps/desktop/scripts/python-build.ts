import { spawn } from "node:child_process";

// Desktop build children share a filtered environment and bounded failure reporting.
export const PYTHON_INSTALL_TIMEOUT_MS = 15 * 60_000;

export function pythonInstallArguments(requirements: string): string[] {
  return [
    "-I",
    "-B",
    "-m",
    "pip",
    "--isolated",
    "install",
    "--no-cache-dir",
    "--index-url",
    "https://pypi.org/simple",
    "--disable-pip-version-check",
    "--timeout",
    "30",
    "--retries",
    "5",
    "--resume-retries",
    "5",
    "--no-deps",
    "--only-binary=:all:",
    "-r",
    requirements,
  ];
}

export async function runPythonBuildStage(
  stage: string,
  executable: string,
  args: string[],
  cwd: string,
  timeout = 60_000,
): Promise<void> {
  console.info(`[Python candidate] ${stage} (limit ${timeout} ms).`);
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
          `Python candidate stage "${stage}" failed after ${elapsedMs} ms ` +
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
