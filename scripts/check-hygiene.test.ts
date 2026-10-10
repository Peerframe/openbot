import assert from "node:assert/strict";
import test from "node:test";
import {
  checkHygiene,
  type HygieneBaseline,
  type HygieneInput,
  NESTED_RULES_MAX_LINES,
  opensWithComment,
  repositoryInput,
} from "./check-hygiene.ts";

const clean: Record<string, string> = {
  "AGENTS.md": "# Map\n",
  "README.zh-CN.md": "# 中文\n",
  "docs/ARCHITECTURE.md": "See `apps/web/src/App.tsx` and `docs/research/choice.md`.\n",
  "docs/decisions/0001-x.md": "Old: `apps/server/src/app.ts` and [choice](../research/choice.md)\n",
  "docs/research/choice.md": "# Choice\n",
  "docs/research/README.md": "[choice](choice.md)\n",
  "apps/web/src/App.tsx": "// The workspace shell.\nexport const App = 1;\n",
  "apps/web/AGENTS.md": "Short rules.\n",
  "experiments/probe/run.ts": "// Probe.\nexport {};\n",
  "package.json": '{"scripts":{"probe":"node experiments/probe/run.ts"}}\n',
};
const zero: HygieneBaseline = { nestedRules: {}, undocumentedFiles: {} };

function input(files: Record<string, string>, baseline = zero): HygieneInput {
  return {
    files: Object.keys(files),
    read: (path) => files[path] ?? "",
    exists: (path) => path in files || Object.keys(files).some((f) => f.startsWith(`${path}/`)),
    ignored: (path) => path.endsWith(".local.json"),
    baseline,
  };
}

test("a clean tree passes, and ADRs may keep historical paths", () => {
  assert.deepEqual(checkHygiene(input(clean)), []);
});

test("translations outside the kept set fail", () => {
  const failures = checkHygiene(input({ ...clean, "docs/API.zh-CN.md": "# API\n" }));
  assert.match(failures.join("\n"), /docs\/API\.zh-CN\.md: Chinese translations are kept only/u);
});

test("dated plans and status logs cannot become permanent docs", () => {
  for (const name of [
    "MIGRATION_PLAN.md",
    "ROADMAP.md",
    "DELIVERY_STATUS.md",
    "CLEANUP_2026-11.md",
  ])
    assert.match(
      checkHygiene(input({ ...clean, [`docs/${name}`]: "x\n" })).join("\n"),
      /PR or issue/u,
    );
});

test("a research record that only an index links is refused", () => {
  const failures = checkHygiene(
    input({
      ...clean,
      "docs/research/slice-notes.md": "# Notes\n",
      "docs/OPEN_SOURCE_REUSE.md": "[notes](research/slice-notes.md)\n",
    }),
  );
  assert.match(failures.join("\n"), /slice-notes\.md: no ADR, code, README or doc refers/u);
  const named: Record<string, string> = { ...clean, "docs/research/slice-notes.md": "# Notes\n" };
  named["apps/web/src/App.tsx"] = "// See docs/research/slice-notes.md.\nexport const App = 1;\n";
  assert.deepEqual(checkHygiene(input(named)), []);
});

test("living docs cannot name paths that are gone", () => {
  const stale = { ...clean, "docs/NATIVE.md": "Edit `apps/server/src/native-agent.ts`.\n" };
  assert.match(
    checkHygiene(input(stale)).join("\n"),
    /apps\/server\/src\/native-agent\.ts` does not exist/u,
  );
  // Paths relative to the doc's package, build output and ignored local files are fine.
  const relative: Record<string, string> = {
    ...clean,
    "packages/harness/scripts/check.sh": "#!/bin/sh\n",
    "packages/tools/README.md":
      "Run `scripts/check.sh`, then open `apps/web/dist/index.html` and `docs/x.local.json`.\n",
  };
  relative["packages/tools/scripts/check.sh"] = "#!/bin/sh\n";
  assert.deepEqual(checkHygiene(input(relative)), []);
});

test("nested rules have a line budget; recorded exceptions may only shrink", () => {
  const long = "rule\n".repeat(NESTED_RULES_MAX_LINES + 5);
  const files: Record<string, string> = { ...clean, "packages/protocol/AGENTS.md": long };
  assert.match(checkHygiene(input(files)).join("\n"), /exceeds 60/u);
  const recorded = {
    nestedRules: { "packages/protocol/AGENTS.md": NESTED_RULES_MAX_LINES + 5 },
    undocumentedFiles: {},
  };
  assert.deepEqual(checkHygiene(input(files, recorded)), []);
  const shorter = {
    ...files,
    "packages/protocol/AGENTS.md": "rule\n".repeat(NESTED_RULES_MAX_LINES + 1),
  };
  assert.match(checkHygiene(input(shorter, recorded)).join("\n"), /lower its entry/u);
});

test("an experiment that nothing runs is refused", () => {
  const files: Record<string, string> = {
    ...clean,
    "experiments/forgotten/notes.ts": "export {};\n",
  };
  assert.match(checkHygiene(input(files)).join("\n"), /experiments\/forgotten: nothing in code/u);
  // Another experiment depending on it keeps it alive.
  files["experiments/probe/run.ts"] = 'import "../forgotten/notes.ts";\n';
  assert.deepEqual(checkHygiene(input(files)), []);
});

test("new source files must say what they are for; the recorded gap only shrinks", () => {
  const files: Record<string, string> = {
    ...clean,
    "apps/web/src/Panel.tsx": "export const Panel = 1;\n",
  };
  assert.match(
    checkHygiene(input(files)).join("\n"),
    /apps\/web: 1 source files lack an opening comment/u,
  );
  const recorded = { nestedRules: {}, undocumentedFiles: { "apps/web": 1 } };
  assert.deepEqual(checkHygiene(input(files, recorded)), []);
  // Tests are exempt; documenting the file means the recorded number must come down.
  files["apps/web/src/Panel.test.tsx"] = "it('x', () => {});\n";
  files["apps/web/src/Panel.tsx"] = "/** The member panel. */\nexport const Panel = 1;\n";
  assert.match(
    checkHygiene(input(files, recorded)).join("\n"),
    /lower undocumentedFiles\["apps\/web"\]/u,
  );
});

test("Python files and packaging names cannot come back", () => {
  for (const name of [
    "scripts/fix.py",
    "experiments/probe/requirements-dev.txt",
    "apps/tool/pyproject.toml",
    ".python-version",
  ])
    assert.match(
      checkHygiene(input({ ...clean, [name]: "x\n" })).join("\n"),
      new RegExp(`${name.replaceAll(".", "\\.")}: Python was retired in P5 \\(ADR-0050\\)`, "u"),
    );
  // Similar names that are not Python stay allowed.
  const similar = { ...clean, "docs/requirements.md": "x\n", "apps/web/src/copy.pyx.ts": "// x\n" };
  assert.deepEqual(checkHygiene(input(similar)), []);
});

test("an opening comment may follow a shebang but not code", () => {
  assert.equal(opensWithComment("#!/usr/bin/env node\n// Release helper.\n"), true);
  assert.equal(opensWithComment("\n/* Panel */\n"), true);
  assert.equal(opensWithComment('import x from "y";\n// late\n'), false);
});

test("the actual repository satisfies the hygiene guards", () => {
  assert.deepEqual(checkHygiene(repositoryInput(process.cwd())), []);
});
