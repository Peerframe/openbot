import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { isolatedConfiguration, parseArguments } from "./probe-support.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-desktop-probe-unit-"));
  roots.push(root);
  const path = join(root, "input.json");
  const source = {
    temporal_address: "127.0.0.1:7233",
    namespace: "synthetic",
    queue: "original-do-not-poll",
    tls: {
      ca: "/synthetic/ca",
      certificate: "/synthetic/cert",
      key: "/synthetic/key",
      server_name: "synthetic.internal",
    },
    interval_seconds: 2,
  };
  await writeFile(path, JSON.stringify(source), { mode: 0o600 });
  return { root, path, source };
}

test("only an explicit trio of absolute paths selects probe inputs", () => {
  assert.deepEqual(
    parseArguments([
      "--runtime",
      "/runtime",
      "--temporal-config",
      "/engine.json",
      "--desktop-dist",
      "/dist",
    ]),
    { runtimeRoot: "/runtime", temporalConfigPath: "/engine.json", desktopDist: "/dist" },
  );
  for (const args of [
    [],
    ["--runtime", "/a"],
    ["--runtime", "relative"],
    ["--data-root", "/user"],
    ["--runtime", "/a", "--runtime", "/b"],
    ["--runtime"],
  ])
    assert.throws(() => parseArguments(args), /explicit absolute/u);
});

test("random queue preserves original engine config and does not read private key bytes", async () => {
  const { path, source } = await fixture();
  const before = await readFile(path);
  const first = JSON.parse(await isolatedConfiguration(path));
  const second = JSON.parse(await isolatedConfiguration(path));
  assert.match(first.queue, /^openbot-desktop-probe-[a-f0-9-]{36}$/u);
  assert.notEqual(first.queue, second.queue);
  assert.deepEqual({ ...first, queue: source.queue }, source);
  assert.deepEqual(await readFile(path), before);
});

for (const fault of [
  "permission",
  "symlink",
  "directory",
  "empty",
  "oversized",
  "invalid-json",
  "array",
]) {
  test(`rejects ${fault} input before attempting a runtime`, async () => {
    const { root, path } = await fixture();
    if (fault === "permission") await chmod(path, 0o644);
    if (fault === "symlink") {
      await symlink(path, join(root, "link.json"));
      await assert.rejects(
        isolatedConfiguration(join(root, "link.json")),
        /bounded private owned/u,
      );
      return;
    }
    if (fault === "directory") {
      await rm(path);
      await mkdir(path);
    }
    if (fault === "empty") await writeFile(path, "");
    if (fault === "oversized") await writeFile(path, "x".repeat(16385));
    if (fault === "invalid-json") await writeFile(path, "secret-invalid-value");
    if (fault === "array") await writeFile(path, "[]");
    await assert.rejects(isolatedConfiguration(path), (error) => {
      assert.equal(
        error.message,
        "Explicit probe configuration must be a bounded private owned JSON file.",
      );
      assert.ok(!error.message.includes(root));
      return true;
    });
  });
}
