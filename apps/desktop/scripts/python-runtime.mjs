import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectProductionPackageGraph } from "../../../scripts/node-linux-release.mjs";
import { validateContainedResource } from "./package-resources.mjs";

export const PYTHON_CANDIDATE = Object.freeze({
  format: "openbot.desktop.python-control/v1",
  backend: "python-product",
  pythonVersion: "3.12.13",
  platform: "darwin",
  arch: "arm64",
});
export const PYTHON_ARCHIVE = Object.freeze({
  name: "cpython-3.12.13+20260807-aarch64-apple-darwin-install_only.tar.gz",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-aarch64-apple-darwin-install_only.tar.gz",
  sha256: "4201588fc5051c2ba988abbe1f033d318965ee378fadf7fb7ef79882ba7be84b",
  maximumBytes: 26 * 1024 * 1024,
});
export const NODE_ARCHIVE = Object.freeze({
  name: "node-v24.21.0-darwin-arm64.tar.gz",
  url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
  sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  maximumBytes: 64 * 1024 * 1024,
});

export function pythonCandidateGraph(lock) {
  const entryPoint = "packages/python-node-runtime";
  const runtime = lock.packages?.[entryPoint];
  for (const name of [
    "@openbot/db",
    "pdfjs-dist",
    "officeparser",
    "tesseract.js",
    "@tesseract.js-data/eng",
    "@tesseract.js-data/chi_sim",
  ]) {
    if (typeof runtime?.dependencies?.[name] !== "string")
      throw new Error("Retained Python parser dependency is missing.");
  }
  // The metadata-only workspace owns these pins independently of the retired business Server.
  const graph = collectProductionPackageGraph(lock, entryPoint);
  return {
    ...graph,
    workspaceKeys: graph.workspaceKeys.filter((key) => key !== entryPoint),
  };
}

export const PYTHON_INSTALL_TIMEOUT_MS = 15 * 60_000;

export function pythonInstallArguments(requirements) {
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

export async function runPythonBuildStage(stage, executable, args, cwd, timeout = 60_000) {
  console.info(`[Python candidate] ${stage} (limit ${timeout} ms).`);
  const started = performance.now();
  await new Promise((resolve, reject) => {
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
    function failure(code, signal, spawnCode = null) {
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
      reject(failure(null, null, error.code ?? "unknown"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      code === 0 && !timedOut ? resolve() : reject(failure(code, signal));
    });
  });
}

export async function verifiedDownload(archive, destination) {
  const response = await fetch(archive.url, {
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok || !response.body) throw new Error("Candidate runtime download failed.");
  const file = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const part of response.body) {
      bytes += part.byteLength;
      if (bytes > archive.maximumBytes) throw new Error("Candidate runtime exceeds its bound.");
      hash.update(part);
      await file.write(part);
    }
    if (hash.digest("hex") !== archive.sha256)
      throw new Error("Candidate runtime checksum mismatch.");
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    await file.close();
    await rm(destination, { force: true });
    throw error;
  }
  await file.close();
}

export async function stagePythonProduct(root, output) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Only the macOS arm64 Python candidate has a reviewed distribution.");
  const downloads = join(output, ".downloads");
  await mkdir(downloads);
  try {
    for (const archive of [PYTHON_ARCHIVE, NODE_ARCHIVE]) {
      const path = join(downloads, archive.name);
      await verifiedDownload(archive, path);
      // Only exact checked upstream release archives reach the platform tar executable.
      await runPythonBuildStage(
        archive === PYTHON_ARCHIVE ? "extract Python runtime" : "extract Node runtime",
        "/usr/bin/tar",
        ["-xzf", path, "-C", output],
        output,
      );
    }
    await rename(join(output, "node-v24.21.0-darwin-arm64"), join(output, "node"));
    await validateContainedResource(join(output, "python"));
    await validateContainedResource(join(output, "node"));
  } finally {
    await rm(downloads, { recursive: true, force: true });
  }
  await cp(join(root, "apps/desktop/resources/python-notices"), join(output, "python-notices"), {
    recursive: true,
  });
  const source = join(root, "apps/server-python");
  const target = join(output, "apps/server-python");
  await mkdir(join(target, "scripts"), { recursive: true });
  await cp(join(source, "src"), join(target, "src"), {
    recursive: true,
    filter: (path) => !path.endsWith("__pycache__") && !path.endsWith(".pyc"),
  });
  for (const name of ["serve.py", "verify_environment.py"])
    await cp(join(source, "scripts", name), join(target, "scripts", name));
  for (const name of [
    "requirements-worker.lock",
    "requirements.lock",
    "requirements.txt",
    "requirements-dev.txt",
  ])
    await cp(join(source, name), join(target, name));
  await cp(
    join(root, "apps/agent-runtime-python/src"),
    join(output, "apps/agent-runtime-python/src"),
    {
      recursive: true,
      filter: (path) => !path.endsWith("__pycache__") && !path.endsWith(".pyc"),
    },
  );
  await mkdir(join(output, "desktop"));
  for (const name of ["python-control-entry.py", "python-control-migrate.mjs"])
    await cp(join(root, "apps/desktop/native", name), join(output, "desktop", name));
  const python = join(output, "python/bin/python3.12");
  await runPythonBuildStage(
    "verify Python version",
    python,
    ["-I", "-B", "-c", "import sys; assert sys.version_info[:3] == (3,12,13)"],
    output,
  );
  await runPythonBuildStage(
    "install Python dependencies",
    python,
    pythonInstallArguments(join(target, "requirements-worker.lock")),
    output,
    PYTHON_INSTALL_TIMEOUT_MS,
  );
  await runPythonBuildStage(
    "verify Python environment",
    python,
    ["-I", "-B", join(target, "scripts/verify_environment.py"), "--worker"],
    output,
  );
  await runPythonBuildStage(
    "check Python dependencies",
    python,
    ["-I", "-B", "-m", "pip", "check"],
    output,
  );
  await writeFile(
    join(output, "python-control-provenance.json"),
    `${JSON.stringify(
      {
        python: PYTHON_ARCHIVE,
        node: NODE_ARCHIVE,
        pythonSource:
          "https://github.com/astral-sh/python-build-standalone/tree/00c8a06113f11220667c3bcf5fab1672ff9e78ef",
        requirementsSha256: createHash("sha256")
          .update(await readFile(join(target, "requirements-worker.lock")))
          .digest("hex"),
        support:
          "unsigned macOS arm64 development candidate; no native execution or signing qualification",
      },
      null,
      2,
    )}\n`,
  );
  await validateContainedResource(output);
  // Selection is written last; a partial build can never silently select the Python backend.
  await writeFile(join(output, "python-control.json"), `${JSON.stringify(PYTHON_CANDIDATE)}\n`, {
    flag: "wx",
  });
}
