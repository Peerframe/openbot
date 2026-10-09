import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { validateDocumentation } from "./check-docs.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "openbot-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  write(
    "AGENTS.md",
    "## Research before implementation\n## Product and security boundaries\n[change](.agents/skills/openbot-change/SKILL.md)",
  );
  write(
    ".agents/skills/openbot-change/SKILL.md",
    "---\nname: openbot-change\ndescription: Make a scoped change.\n---\n",
  );
  for (const path of [
    "docs/research/TEMPLATE.md",
    "docs/decisions/TEMPLATE.md",
    ".github/workflows/ci.yml",
    ".github/pull_request_template.md",
  ])
    write(path, readFileSync(path, "utf8"));
  // Templates link to the actual contributor rules. The fixture only needs the target to exist.
  write("CLAUDE.md", "@AGENTS.md\n");
  write("CONTRIBUTING.md", "Contribution rules.");
  write("README.md", "Welcome.\n");
  write("README.zh-CN.md", "欢迎。\n");
  return { root, write };
}

test("the actual repository satisfies all documentation and developer-entry checks", () => {
  const result = validateDocumentation(process.cwd());
  assert.ok(result.markdownFiles.length > 0);
  assert.deepEqual(result.failures, []);
});

test("valid local and external links pass while broken and malformed links identify the source", (t) => {
  const f = fixture(t);
  f.write(
    "docs/guide.md",
    "[root](../README.md#intro) [web](https://example.invalid) [mail](mailto:test@example.invalid)\n",
  );
  assert.deepEqual(validateDocumentation(f.root).failures, []);
  f.write("docs/guide.md", "[missing](absent.md) [invalid](bad%FF.md)\n");
  assert.deepEqual(validateDocumentation(f.root).failures, [
    "docs/guide.md: local link does not exist: absent.md",
    "docs/guide.md: link has invalid percent encoding: bad%FF.md",
  ]);
});

test("generated directories do not pollute source docs, and separate roots cannot share diagnostics", (t) => {
  const f = fixture(t);
  f.write("dist/generated.md", "[missing](absent.md)");
  f.write("node_modules/package/README.md", "[missing](absent.md)");
  assert.deepEqual(validateDocumentation(f.root).failures, []);
  f.write("docs/guide.md", "[missing](absent.md)");
  assert.equal(validateDocumentation(f.root).failures.length, 1);
  const other = fixture(t);
  assert.deepEqual(validateDocumentation(other.root).failures, []);
});

test("ADRs can use decision-specific structure while their local links remain checked", (t) => {
  const f = fixture(t);
  const decision =
    "# ADR-0099: Keep the existing transport\n\n" +
    "Retain the current transport because it preserves cancellation and needs no new runtime. " +
    "The cost is maintaining the current adapter; [evidence](../../README.md) covers its consumer.\n";
  f.write("docs/decisions/0099-example.md", decision);
  assert.deepEqual(validateDocumentation(f.root).failures, []);
  f.write("docs/decisions/0099-example.md", `${decision}[missing](absent.md)\n`);
  assert.deepEqual(validateDocumentation(f.root).failures, [
    "docs/decisions/0099-example.md: local link does not exist: absent.md",
  ]);
});

test("research-policy files and the PR research heading remain enforced", (t) => {
  const f = fixture(t);
  f.write(".github/pull_request_template.md", "## What changed\n");
  assert.ok(
    validateDocumentation(f.root).failures.includes(
      ".github/pull_request_template.md: missing '## Open-source research'.",
    ),
  );
  for (const path of ["docs/research/TEMPLATE.md", "docs/decisions/TEMPLATE.md"]) {
    rmSync(join(f.root, path));
    assert.ok(
      validateDocumentation(f.root).failures.includes(
        `${path}: required research-policy file is missing.`,
      ),
    );
  }
});

test("unpinning an action or removing developer routing still fails", (t) => {
  const f = fixture(t);
  f.write(
    ".github/workflows/ci.yml",
    "steps:\n  - uses: actions/checkout@main\n  - uses: actions/setup-node@v7\n",
  );
  f.write("AGENTS.md", "## Research before implementation\n## Product and security boundaries\n");
  const failures = validateDocumentation(f.root).failures;
  assert.equal(
    failures.filter((failure) => failure.includes("must be pinned to a full commit")).length,
    2,
  );
  assert.ok(failures.some((failure) => failure.includes("root AGENTS must link the skill")));
});

test("root README diagrams and oversized image inventories still fail", (t) => {
  const f = fixture(t);
  f.write(
    "README.md",
    "```mermaid\ngraph TD\n```\n" +
      Array(6).fill("![icon](https://example.invalid/icon.png)").join("\n"),
  );
  assert.deepEqual(validateDocumentation(f.root).failures, [
    "README.md: root READMEs must link to architecture docs instead of embedding Mermaid.",
    "README.md: contains 6 images; keep the root README lightweight.",
  ]);
});
