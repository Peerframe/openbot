import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stageInstalledHarness } from "./harness-wheel.ts";
import { validateContainedResource } from "./package-resources.ts";
import {
  PYTHON_INSTALL_TIMEOUT_MS,
  pythonInstallArguments,
  runPythonBuildStage,
} from "./python-build.ts";

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

export interface RuntimeArchive {
  url: string;
  sha256: string;
  maximumBytes: number;
}

export async function verifiedDownload(
  archive: RuntimeArchive,
  destination: string,
): Promise<void> {
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

export async function stagePythonProduct(root: string, output: string): Promise<void> {
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
    "requirements-product.lock",
    "requirements.lock",
    "requirements.txt",
    "requirements-dev.txt",
    "requirements-temporal.txt",
  ])
    await cp(join(source, name), join(target, name));
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
    pythonInstallArguments(join(target, "requirements-product.lock")),
    output,
    PYTHON_INSTALL_TIMEOUT_MS,
  );
  const harness = await stageInstalledHarness(root, output, python);
  await runPythonBuildStage(
    "verify Python environment",
    python,
    ["-I", "-B", join(target, "scripts/verify_environment.py"), "--product"],
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
        harness,
        node: NODE_ARCHIVE,
        pythonSource:
          "https://github.com/astral-sh/python-build-standalone/tree/00c8a06113f11220667c3bcf5fab1672ff9e78ef",
        requirementsSha256: createHash("sha256")
          .update(await readFile(join(target, "requirements-product.lock")))
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
