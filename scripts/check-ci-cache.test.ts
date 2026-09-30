import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
type JsonObject = { readonly [key: string]: unknown };
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function member(value: unknown, key: string): unknown {
  return isJsonObject(value) ? value[key] : undefined;
}

test("actual Turbo hashes include toolchain/platform identity and runtime inputs", () => {
  const hash = (agent: string, port: string): unknown => {
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
    const plan: unknown = JSON.parse(result.stdout);
    const tasks = member(plan, "tasks");
    assert(Array.isArray(tasks), "Turbo dry run must list tasks.");
    const list: readonly unknown[] = tasks;
    const typecheck = list.find((task) => member(task, "task") === "typecheck");
    assert(typecheck !== undefined, "Turbo dry run must include the typecheck task.");
    return member(typecheck, "hash");
  };
  const baseline = hash("npm/10.9.9 node/v22.22.2 linux x64", "3001");
  assert.notEqual(baseline, hash("npm/10.9.9 node/v22.22.2 darwin arm64", "3001"));
  assert.notEqual(baseline, hash("npm/10.9.9 node/v24.15.0 linux x64", "3001"));
  assert.notEqual(baseline, hash("npm/10.9.9 node/v22.22.2 linux x64", "3002"));
});

test("declared Vitest gates cannot turn zero collected tests into success", async () => {
  const lock: unknown = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const packages = member(lock, "packages");
  assert(isJsonObject(packages), "package-lock.json must list packages.");
  for (const [path, item] of Object.entries(packages)) {
    const name = member(item, "name");
    if (
      !path ||
      path.includes("node_modules") ||
      !(typeof name === "string" && name.startsWith("@openbot/"))
    )
      continue;
    const pkg: unknown = JSON.parse(await readFile(new URL(`${path}/package.json`, root), "utf8"));
    const testScript = member(member(pkg, "scripts"), "test");
    assert(!(typeof testScript === "string" && testScript.includes("--passWithNoTests")), path);
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
