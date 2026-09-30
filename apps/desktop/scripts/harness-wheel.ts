import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { pythonInstallArguments, runPythonBuildStage } from "./python-build.ts";

// Build tools exist only in this disposable staging directory. The payload gets the wheel and
// its exact local-distribution lock, not a source directory or contributor skills.
export async function stageInstalledHarness(root: string, output: string, python: string) {
  const source = join(root, "packages/harness");
  const stage = join(output, ".harness-build");
  await mkdir(join(stage, "scripts"), { recursive: true });
  try {
    for (const name of [
      "pyproject.toml",
      "README.md",
      "LICENSE",
      "distribution.lock",
      "requirements.txt",
      "requirements-build.txt",
      "requirements-build.lock",
    ])
      await cp(join(source, name), join(stage, name));
    for (const name of ["verify_environment.py", "check-metadata.py"])
      await cp(join(source, "scripts", name), join(stage, "scripts", name));
    await cp(join(source, "src"), join(stage, "src"), {
      recursive: true,
      filter: (path) => !path.endsWith("__pycache__") && !path.endsWith(".pyc"),
    });
    await runPythonBuildStage(
      "create harness build environment",
      python,
      ["-I", "-m", "venv", join(stage, ".build-venv")],
      stage,
    );
    const builder = join(stage, ".build-venv/bin/python");
    await runPythonBuildStage(
      "install harness build tools",
      builder,
      pythonInstallArguments(join(stage, "requirements-build.lock")).filter(
        (arg, index, args) => arg !== "--resume-retries" && args[index - 1] !== "--resume-retries",
      ),
      stage,
      15 * 60_000,
    );
    await runPythonBuildStage(
      "verify harness build tools",
      builder,
      ["-I", "scripts/verify_environment.py", "--profile", "build"],
      stage,
    );
    await runPythonBuildStage(
      "verify harness metadata",
      builder,
      ["-I", "scripts/check-metadata.py"],
      stage,
    );
    await runPythonBuildStage(
      "build harness wheel",
      builder,
      ["-I", "-m", "hatchling", "build", "-t", "wheel"],
      stage,
    );
    const lock = await readFile(join(stage, "distribution.lock"), "utf8");
    const pins = lock.split("\n").filter((line) => line && !line.startsWith("#"));
    const [pin] = pins;
    if (pins.length !== 1 || !pin || !/^openbot-agent-runtime==[0-9]+\.[0-9]+\.[0-9]+$/u.test(pin))
      throw new Error("Invalid local harness distribution pin.");
    const version = pin.slice("openbot-agent-runtime==".length);
    const wheel = join(stage, "dist", `openbot_agent_runtime-${version}-py3-none-any.whl`);
    const sha256 = createHash("sha256")
      .update(await readFile(wheel))
      .digest("hex");
    await runPythonBuildStage(
      "install harness wheel",
      python,
      ["-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", wheel],
      stage,
    );
    await mkdir(join(output, "packages/harness"), { recursive: true });
    await cp(join(stage, "distribution.lock"), join(output, "packages/harness/distribution.lock"));
    await runPythonBuildStage(
      "verify installed harness",
      python,
      [
        "-I",
        "-c",
        "import importlib.metadata as m, pathlib, openbot_agent_runtime as h; " +
          `assert m.version('openbot-agent-runtime') == '${version}'; ` +
          "assert 'site-packages' in pathlib.Path(h.__file__).parts",
      ],
      output,
    );
    return { distribution: "openbot-agent-runtime", version, wheelSha256: sha256 };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
