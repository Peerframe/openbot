import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapAgentRuntime } from "./agent-runtime-bootstrap.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(body = "") {
  const root = await mkdtemp(join(tmpdir(), "openbot-bootstrap-test-"));
  directories.push(root);
  await mkdir(join(root, ".venv", "bin"), { recursive: true });
  await mkdir(join(root, "scripts"));
  const entrypoint = join(root, "scripts", "run-worker.py");
  await writeFile(entrypoint, "# Fixed fixture entry point.\n");
  await writeFile(join(root, "scripts", "verify_environment.py"), "# Fixture verifier.\n");
  const recordPath = join(root, "observed.json");
  const nodeFixture = join(root, "interpreter.mjs");
  await writeFile(
    nodeFixture,
    `import { writeFileSync, readdirSync } from 'node:fs';
writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  args: process.argv.slice(2), env: process.env, cwd: process.cwd(), files: readdirSync('.')
}));
${body}`,
  );
  const python = join(root, ".venv", "bin", "python");
  await writeFile(
    python,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nodeFixture)} "$@"\n`,
  );
  await chmod(python, 0o700);
  return { root, entrypoint, recordPath, python };
}

it("does not inspect Python or run a preflight for the default adapter", async () => {
  expect(
    await bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "typescript" }, "/absent"),
  ).toBeUndefined();
});

describe.skipIf(process.platform === "win32")("Python startup selection", () => {
  it("checks the fixed package from an empty cwd with a minimal environment", async () => {
    const files = await fixture();
    const before = process.env.OPENBOT_BOOTSTRAP_TEST_SECRET;
    process.env.OPENBOT_BOOTSTRAP_TEST_SECRET = "must-not-reach-interpreter";
    try {
      expect(
        typeof (await bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "python" }, files.root)),
      ).toBe("function");
    } finally {
      if (before === undefined) delete process.env.OPENBOT_BOOTSTRAP_TEST_SECRET;
      else process.env.OPENBOT_BOOTSTRAP_TEST_SECRET = before;
    }
    const seen = JSON.parse(await readFile(files.recordPath, "utf8"));
    expect(seen.args.slice(0, 3)).toEqual(["-I", "-u", "-c"]);
    expect(seen.args[3]).toContain("import openbot_agent_runtime");
    expect(seen.args.slice(4)).toEqual([
      join(files.root, "src"),
      join(files.root, "scripts", "verify_environment.py"),
    ]);
    expect(seen.env.OPENBOT_BOOTSTRAP_TEST_SECRET).toBeUndefined();
    expect(seen.env.HOME).toBeUndefined();
    // The fixture shell may create PWD/SHLVL; the real interpreter gets the explicit locales.
    expect(
      Object.keys(seen.env).filter(
        (key) => !["LANG", "LC_ALL", "PWD", "SHLVL", "__CF_USER_TEXT_ENCODING"].includes(key),
      ),
    ).toEqual([]);
    expect(seen.files).toEqual([]);
    await expect(access(seen.cwd)).rejects.toThrow();
  });

  it("fails before launching when the worker is missing", async () => {
    const files = await fixture();
    await rm(files.entrypoint);
    await expect(
      bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "python" }, files.root),
    ).rejects.toThrow("preflight failed");
    await expect(access(files.recordPath)).rejects.toThrow();
  });

  it("rejects a missing interpreter without fallback", async () => {
    const files = await fixture();
    await rm(files.python);
    await expect(
      bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "python" }, files.root),
    ).rejects.toThrow("preflight failed");
  });

  it("sanitizes failed dependency checks and removes its temporary cwd", async () => {
    const files = await fixture(
      'console.error("private interpreter diagnostic"); process.exitCode = 1;',
    );
    await expect(
      bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "python" }, files.root),
    ).rejects.toThrow(/^Python Agent runtime preflight failed\./);
    const seen = JSON.parse(await readFile(files.recordPath, "utf8"));
    await expect(access(seen.cwd)).rejects.toThrow();
  });

  it("bounds interpreter output", async () => {
    const files = await fixture('process.stdout.write("x".repeat(32768));');
    await expect(
      bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "python" }, files.root),
    ).rejects.toThrow("preflight failed");
  });
});
