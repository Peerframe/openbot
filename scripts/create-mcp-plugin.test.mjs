import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMcpPlugin } from "./create-mcp-plugin.mjs";

test("creates a standalone pinned plugin and refuses to overwrite an existing project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openbot-plugin-starter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await createMcpPlugin(join(root, "plugin"));
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
  assert.equal(manifest.scripts.test, "node --import tsx --test plugin-author-scenarios.ts");
  assert.equal(manifest.scripts.preflight, "node --import tsx plugin-preflight.ts");
  for (const name of [
    "plugin-compatibility.ts",
    "plugin-preflight.ts",
    "plugin-preflight-fixture.ts",
    "plugin-author-scenarios.ts",
  ]) {
    const copied = await readFile(join(directory, name), "utf8");
    assert.doesNotMatch(copied, /from ["']@openbot\//u);
    assert.equal(
      copied,
      await readFile(new URL(`../apps/server/src/${name}`, import.meta.url), "utf8"),
    );
  }
  const source = await readFile(join(directory, "plugin-example.ts"), "utf8");
  assert.doesNotMatch(source, /from ["']@openbot\//u);
  assert.match(source, /registerResource/u);
  await writeFile(join(directory, "keep.txt"), "user file");
  await assert.rejects(createMcpPlugin(directory), { code: "EEXIST" });
  assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "user file");
});
