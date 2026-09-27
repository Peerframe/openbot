import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateDeveloperEntrypoints } from "./check-developer-entrypoints.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "openbot-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".agents/skills/openbot-change");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const source =
    "---\nname: openbot-change\ndescription: Make a scoped change.\n---\nRead the map.\n";
  writeFileSync(path, source);
  writeFileSync(join(root, "AGENTS.md"), "[change](.agents/skills/openbot-change/SKILL.md)");
  return { root, dir, path, source };
}

test("repository entrypoints are discoverable and explicitly routed", () => {
  assert.deepEqual(validateDeveloperEntrypoints(process.cwd()), []);
});
test("missing metadata or renamed skill cannot silently lose its discovery identity", (t) => {
  const f = fixture(t);
  assert.deepEqual(validateDeveloperEntrypoints(f.root), []);
  for (const source of [
    f.source.replace("name: openbot-change", "name: renamed"),
    f.source.replace("description: Make a scoped change.", "description: TODO"),
    "# No metadata",
  ]) {
    writeFileSync(f.path, source);
    assert.ok(validateDeveloperEntrypoints(f.root).length > 0);
  }
});
test("root routing and actual skill files are both required", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "AGENTS.md"), "No skill route");
  assert.match(validateDeveloperEntrypoints(f.root).join(" "), /root AGENTS/u);
  rmSync(f.path);
  assert.match(validateDeveloperEntrypoints(f.root).join(" "), /missing plain/u);
});
test("repo discovery cannot depend on symlink support", (t) => {
  const f = fixture(t);
  symlinkSync(f.dir, join(f.root, ".agents/skills/alias"), "junction");
  assert.match(validateDeveloperEntrypoints(f.root).join(" "), /not a symlink/u);
});
