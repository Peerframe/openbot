import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ROOT_RULES_MAX_LINES,
  validateDeveloperEntrypoints,
} from "./check-developer-entrypoints.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "openbot-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".agents/skills/openbot-change");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const source =
    "---\nname: openbot-change\ndescription: Make a scoped change.\n---\nRead the map.\n";
  writeFileSync(path, source);
  writeFileSync(join(root, "AGENTS.md"), "[change](.agents/skills/openbot-change/SKILL.md)");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
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
test("the root map keeps its line budget and Claude Code imports it", (t) => {
  const f = fixture(t);
  const route = "[change](.agents/skills/openbot-change/SKILL.md)";
  writeFileSync(join(f.root, "AGENTS.md"), `${route}\n${"line\n".repeat(ROOT_RULES_MAX_LINES)}`);
  assert.match(validateDeveloperEntrypoints(f.root).join(" "), /keep the root map within/u);
  writeFileSync(join(f.root, "AGENTS.md"), route);
  assert.deepEqual(validateDeveloperEntrypoints(f.root), []);
  writeFileSync(join(f.root, "CLAUDE.md"), "Read AGENTS.md.");
  assert.match(validateDeveloperEntrypoints(f.root).join(" "), /CLAUDE\.md must/u);
  rmSync(join(f.root, "CLAUDE.md"));
  assert.match(validateDeveloperEntrypoints(f.root).join(" "), /CLAUDE\.md must/u);
});
