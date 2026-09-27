import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("actual Python audit gate refuses empty, missing, skipped, stale and vulnerable reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-audit-test-"));
  const lock = join(root, "requirements.lock");
  const report = join(root, "report.json");
  const run = () =>
    spawnSync(
      "python3",
      [new URL("./check-python-audit.py", import.meta.url).pathname, lock, report],
      { encoding: "utf8" },
    );
  const good = { name: "test_package", version: "1.0.0", vulns: [] };
  try {
    await writeFile(lock, "test-package==1.0.0\n");
    await writeFile(report, JSON.stringify({ dependencies: [good] }));
    assert.equal(run().status, 0);
    for (const dependencies of [
      [],
      [good, good],
      [{ ...good, version: "0.9.0" }],
      [{ ...good, skip_reason: "not found" }],
      [{ ...good, vulns: [{ id: "SYNTHETIC-ADVISORY" }] }],
      [{ name: good.name, version: good.version }],
    ]) {
      await writeFile(report, JSON.stringify({ dependencies }));
      assert.notEqual(run().status, 0);
    }
    await writeFile(lock, "");
    await writeFile(report, JSON.stringify({ dependencies: [] }));
    assert.notEqual(run().status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisory command scans the product lock without resolution, fixes or exclusions", async () => {
  const script = await readFile(new URL("./audit-python.sh", import.meta.url), "utf8");
  for (const value of [
    "--strict",
    "--disable-pip",
    "--no-deps",
    "requirements-product.lock",
    "check-python-audit.py",
    "set -eu",
  ])
    assert(script.includes(value), value);
  assert(!/--fix|--ignore-vuln|\|\|\s*true/.test(script));
});

test("actual Python direct manifests agree with every production environment lock", async () => {
  const root = new URL("../apps/server-python/", import.meta.url);
  const metadata = await readFile(new URL("pyproject.toml", root), "utf8");
  const dependencyBlock = metadata.match(/dependencies = \[([\s\S]*?)\n\]/)[1];
  const manifestPins = [...dependencyBlock.matchAll(/"([^"\n]+)==([^"\n]+)"/g)]
    .map((match) => `${match[1]}==${match[2]}`)
    .sort();
  const direct = (await readFile(new URL("requirements.txt", root), "utf8"))
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .sort();
  assert.deepEqual(manifestPins, direct);
  const normalize = (line) =>
    line
      .toLowerCase()
      .replace(/\[[^\]]+\]/g, "")
      .replaceAll("_", "-");
  for (const name of [
    "requirements.lock",
    "requirements-worker.lock",
    "requirements-product.lock",
  ]) {
    const locked = new Set(
      (await readFile(new URL(name, root), "utf8")).split("\n").map(normalize),
    );
    for (const pin of direct) assert(locked.has(normalize(pin)), `${name}: ${pin}`);
  }
});
