import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

// Build tools exist only in this disposable staging directory. The payload gets the wheel and
// its exact local-distribution lock, not a source directory or contributor skills.
export async function stageInstalledHarness(root, output, python, run, installArguments) {
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
    await run(
      "create harness build environment",
      python,
      ["-I", "-m", "venv", join(stage, ".build-venv")],
      stage,
    );
    const builder = join(stage, ".build-venv/bin/python");
    await run(
      "install harness build tools",
      builder,
      installArguments(join(stage, "requirements-build.lock")).filter(
        (arg, index, args) => arg !== "--resume-retries" && args[index - 1] !== "--resume-retries",
      ),
      stage,
      15 * 60_000,
    );
    await run(
      "verify harness build tools",
      builder,
      ["-I", "scripts/verify_environment.py", "--profile", "build"],
      stage,
    );
    await run("verify harness metadata", builder, ["-I", "scripts/check-metadata.py"], stage);
    await run(
      "build harness wheel",
      builder,
      ["-I", "-m", "hatchling", "build", "-t", "wheel"],
      stage,
    );
    const lock = await readFile(join(stage, "distribution.lock"), "utf8");
    const pins = lock.split("\n").filter((line) => line && !line.startsWith("#"));
    if (pins.length !== 1 || !/^openbot-agent-runtime==[0-9]+\.[0-9]+\.[0-9]+$/u.test(pins[0]))
      throw new Error("Invalid local harness distribution pin.");
    const version = pins[0].split("==")[1];
    const wheel = join(stage, "dist", `openbot_agent_runtime-${version}-py3-none-any.whl`);
    const sha256 = createHash("sha256")
      .update(await readFile(wheel))
      .digest("hex");
    await run(
      "install harness wheel",
      python,
      ["-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", wheel],
      stage,
    );
    await mkdir(join(output, "packages/harness"), { recursive: true });
    await cp(join(stage, "distribution.lock"), join(output, "packages/harness/distribution.lock"));
    await run(
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
