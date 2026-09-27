import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
test("actual Turbo hashes include toolchain/platform identity and runtime inputs", () => {
  const hash = (agent, port) => {
    const result = spawnSync(
      process.execPath,
      [
        new URL("node_modules/turbo/bin/turbo", root).pathname,
        "run",
        "typecheck",
        "--filter=@openbot/config",
        "--dry=json",
      ],
      {
        cwd: root,
        env: { ...process.env, npm_config_user_agent: agent, OPENBOT_PORT: port },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).tasks.find((task) => task.task === "typecheck").hash;
  };
  const baseline = hash("npm/10.9.9 node/v22.22.2 linux x64", "3001");
  assert.notEqual(baseline, hash("npm/10.9.9 node/v22.22.2 darwin arm64", "3001"));
  assert.notEqual(baseline, hash("npm/10.9.9 node/v24.15.0 linux x64", "3001"));
  assert.notEqual(baseline, hash("npm/10.9.9 node/v22.22.2 linux x64", "3002"));
});

test("declared Vitest gates cannot turn zero collected tests into success", async () => {
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path || path.includes("node_modules") || !item.name?.startsWith("@openbot/")) continue;
    const pkg = JSON.parse(await readFile(new URL(`${path}/package.json`, root), "utf8"));
    assert(!pkg.scripts?.test?.includes("--passWithNoTests"), path);
  }
  const directory = await mkdtemp(join(tmpdir(), "openbot-empty-tests-"));
  try {
    const result = spawnSync(
      process.execPath,
      [new URL("node_modules/vitest/vitest.mjs", root).pathname, "run", "--root", directory],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /No test files found/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
