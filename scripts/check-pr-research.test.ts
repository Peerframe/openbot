import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { readPullRequestChanges, validatePullRequestResearch } from "./check-pr-research.ts";
import type { ResearchChange } from "./check-research-reuse.ts";

const validSection = `
## Open-source research

- Research artifact: docs/research/example.md
- Selected upstream/standard: example/project
- Version or commit: v1.2.3
- License: Apache-2.0
- Decision: thin adapter
- OpenBot-specific gap: Server-owned approval binding
- Source copied or substantially adapted: no

## Verification
`;

test("accepts completed research evidence", () => {
  assert.deepEqual(validatePullRequestResearch(validSection), []);
});

test("rejects a missing research section", () => {
  assert.deepEqual(validatePullRequestResearch("## Verification\n\n- Tests: pass"), [
    "missing the 'Open-source research' section",
  ]);
});

test("rejects missing and placeholder fields", () => {
  const failures = validatePullRequestResearch(`
## Open-source research

- Research artifact: TODO
- Selected upstream/standard: example/project
- Version or commit: v1.2.3
- License: MIT
- Decision: adapter
- Source copied or substantially adapted: no
`);

  assert.deepEqual(failures, [
    "'Research artifact' still contains a placeholder",
    "missing '- OpenBot-specific gap:'",
  ]);
});

test("rejects the unchanged repository pull request template", () => {
  const template = readFileSync(".github/pull_request_template.md", "utf8");
  assert.equal(validatePullRequestResearch(template).length, 7);
});

const exemption = `## Open-source research

- Research exemption: translation
- Exemption reason: Translate the introductory paragraph faithfully; commands and product claims are unchanged.
`;

function documentationChange(
  before: string,
  after: string,
  overrides: Partial<ResearchChange> = {},
): ResearchChange {
  return {
    path: "README.zh-CN.md",
    beforeMode: "100644",
    afterMode: "100644",
    before,
    after,
    ...overrides,
  };
}

test("accepts translated prose around preserved inline commands and links", () => {
  const changes = [
    documentationChange(
      "Use `npm ci` and read [setup](docs/SETUP.md).\n",
      "运行 `npm ci`，阅读[安装说明](docs/SETUP.md)。\n",
    ),
  ];
  assert.deepEqual(validatePullRequestResearch(exemption, changes), []);
});

test("accepts prose spelling and mechanical wrapping without a new research artifact", () => {
  for (const category of ["spelling", "mechanical-formatting"]) {
    const body = exemption.replace("translation", category);
    assert.deepEqual(
      validatePullRequestResearch(body, [
        documentationChange("Welcom to OpenBot.\n", "Welcome to\nOpenBot.\n"),
      ]),
      [],
    );
  }
});

test("requires a concrete exemption reason, known category and actual change evidence", () => {
  const changes = [documentationChange("Welcom.", "Welcome.")];
  assert.match(
    validatePullRequestResearch(
      exemption.replace(/Exemption reason:.*/u, "Exemption reason: N/A"),
      changes,
    ).join(" "),
    /specific correction/u,
  );
  assert.match(
    validatePullRequestResearch(exemption.replace("translation", "documentation"), changes).join(
      " ",
    ),
    /must be spelling/u,
  );
  assert.match(validatePullRequestResearch(exemption).join(" "), /actual committed/u);
  assert.match(validatePullRequestResearch(exemption, []).join(" "), /actual committed/u);
});

test("rejects mixing exemption and incomplete or complete research answers", () => {
  const changes = [documentationChange("Welcom.", "Welcome.")];
  assert.match(
    validatePullRequestResearch(
      `${exemption}\n- Research artifact: docs/research/example.md`,
      changes,
    ).join(" "),
    /not both/u,
  );
  assert.match(
    validatePullRequestResearch(
      validSection.replace("## Verification", exemption.replace("## Open-source research", "")),
      changes,
    ).join(" "),
    /not both/u,
  );
});

test("does not let a self-declared exemption cover code, dependencies, workflow or policy changes", () => {
  for (const path of [
    "apps/server/src/app.ts",
    "package.json",
    "package-lock.json",
    ".github/workflows/ci.yml",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/SECURITY.md",
    "docs/research/TEMPLATE.md",
    "docs/research/policy-review.md",
    "docs/decisions/0001-rule.md",
    "docs/OPEN_SOURCE_REUSE.zh-CN.md",
    "docs/../apps/run.md",
  ]) {
    assert.match(
      validatePullRequestResearch(exemption, [
        documentationChange("before", "after", { path }),
      ]).join(" "),
      /ordinary Markdown/u,
      path,
    );
  }
});

test("rejects executable, symlink and binary documentation changes", () => {
  for (const overrides of [
    { afterMode: "100755" },
    { beforeMode: "120000" },
    { after: "binary\0data" },
  ]) {
    assert.match(
      validatePullRequestResearch(exemption, [
        documentationChange("before", "after", overrides),
      ]).join(" "),
      /ordinary Markdown/u,
    );
  }
});

test("protects technical Markdown content across apparent prose-only paths", () => {
  const cases: [string, string][] = [
    ["Run `npm ci`.", "Run `npm install`."],
    ["Run ``npm ci``.", "Run ``npm install``."],
    ["```bash\nnpm ci\n```\n", "```bash\nnpm install\n```\n"],
    ["~~~bash\nnpm ci\n~~~\n", "~~~bash\nnpm install\n~~~\n"],
    ["    npm ci\n", "    npm install\n"],
    ["[setup](docs/SETUP.md)", "[setup](https://example.invalid/download)"],
    ["[setup][source]", "[setup][replacement]"],
    [
      "[source]\n\n[source]: one.md\n[other]: two.md",
      "[other]\n\n[source]: one.md\n[other]: two.md",
    ],
    [
      "[source][]\n\n[source]: one.md\n[other]: two.md",
      "[other][]\n\n[source]: one.md\n[other]: two.md",
    ],
    ["[setup](docs/SETUP.md)", "![setup](docs/SETUP.md)"],
    ["[setup [nested]](docs/SETUP.md)", "![setup [nested]](docs/SETUP.md)"],
    ["[source]: https://example.org", "[source]: https://example.invalid"],
    ["<img src='one.png'>", "<img src='two.png'>"],
    ["<script>original()</script>", "<script>replacement()</script>"],
    ["https://example.org", "https://example.invalid"],
    ["---\nlayout: prose\n---\n", "---\nlayout: executable\n---\n"],
    ["Read instructions.", "Run `unfinished command."],
    ["Read instructions.", "```sh\nunfinished"],
  ];
  for (const [before, after] of cases) {
    assert.match(
      validatePullRequestResearch(exemption, [documentationChange(before, after)]).join(" "),
      /commands, code blocks/u,
      before,
    );
  }
});

test("preserves ordinary research validation even when the change inventory is unavailable", () => {
  assert.deepEqual(validatePullRequestResearch(validSection), []);
  assert.equal(validatePullRequestResearch(validSection.replace("v1.2.3", "N/A")).length, 1);
});

function fixtureRepository(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "openbot-research-check-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "Fixture change");
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  write("README.md", "Welcom.\n");
  const base = commit();
  return { cwd, git, write, commit, base };
}

test("uses immutable PR blobs and the merge base, with no trust in working-tree content", (t) => {
  const fixture = fixtureRepository(t);
  fixture.git("checkout", "-b", "contribution");
  fixture.write("README.md", "Welcome.\n");
  const head = fixture.commit();
  fixture.git("checkout", "main");
  fixture.write("apps/server/src/new.ts", "unrelated base branch change");
  const base = fixture.commit();
  fixture.write("README.md", "Run `uncommitted command`.\n");
  const changes = readPullRequestChanges(
    { pull_request: { base: { sha: base }, head: { sha: head } } },
    fixture,
  );
  assert.deepEqual(changes, [
    documentationChange("Welcom.\n", "Welcome.\n", { path: "README.md" }),
  ]);
  assert.deepEqual(validatePullRequestResearch(exemption, changes), []);
});

test("reads renames as both paths so a source-to-document move cannot qualify", (t) => {
  const fixture = fixtureRepository(t);
  fixture.write("apps/source.ts", "source");
  const base = fixture.commit();
  fixture.git("mv", "apps/source.ts", "README.source.md");
  const head = fixture.commit();
  const changes = readPullRequestChanges(
    { pull_request: { base: { sha: base }, head: { sha: head } } },
    fixture,
  );
  assert.equal(changes.length, 2);
  assert.match(validatePullRequestResearch(exemption, changes).join(" "), /ordinary Markdown/u);
});

test("keeps NUL-delimited unusual paths distinct and rejects unsafe automatic scope", (t) => {
  const fixture = fixtureRepository(t);
  fixture.write("docs/multiple\nlines.md", "Text");
  const head = fixture.commit();
  const changes = readPullRequestChanges(
    { pull_request: { base: { sha: fixture.base }, head: { sha: head } } },
    fixture,
  );
  assert.equal(changes[0]?.path, "docs/multiple\nlines.md");
  assert.match(validatePullRequestResearch(exemption, changes).join(" "), /ordinary Markdown/u);
});

test("the actual CLI accepts a documented correction and rejects a code change", (t) => {
  const fixture = fixtureRepository(t);
  fixture.write("README.md", "Welcome.\n");
  let head = fixture.commit();
  const eventPath = join(fixture.cwd, "event.json");
  const run = () => {
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { body: exemption, base: { sha: fixture.base }, head: { sha: head } },
      }),
    );
    return spawnSync(process.execPath, [resolve("scripts/check-pr-research.ts")], {
      cwd: fixture.cwd,
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
      encoding: "utf8",
    });
  };
  assert.equal(run().status, 0);
  rmSync(eventPath);
  fixture.write("apps/server/src/change.ts", "export const changed = true;");
  head = fixture.commit();
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /ordinary Markdown/u);
});

test("fails closed on invalid or unavailable Git objects without exposing subprocess output", (t) => {
  const fixture = fixtureRepository(t);
  assert.throws(
    () =>
      readPullRequestChanges(
        { pull_request: { base: { sha: "--output=/tmp/file" }, head: { sha: fixture.base } } },
        fixture,
      ),
    /valid pull-request/u,
  );
  assert.throws(
    () =>
      readPullRequestChanges(
        { pull_request: { base: { sha: "f".repeat(40) }, head: { sha: fixture.base } } },
        fixture,
      ),
    /^Error: Cannot verify research changes\./u,
  );
});

const reuse = `## Open-source research

- Research reuse: docs/research/channel-member-layout.md
- Reuse scope: Restore focus after the existing member menu closes.
- Unchanged assumptions: Same React event contract; no dependency, public protocol, authority, persistence or architecture change.
- Source copied or substantially adapted: no
`;
const repair = (overrides: Partial<ResearchChange> = {}) =>
  documentationChange('export const label = "Before";', 'export const label = "After";', {
    path: "apps/web/src/components/ChannelMembersMenu.tsx",
    ...overrides,
  });

test("ordinary UI and core repairs reuse the decision without repeating upstream research", () => {
  assert.deepEqual(validatePullRequestResearch(reuse, [repair()]), []);
  assert.deepEqual(
    validatePullRequestResearch(
      reuse.replace("docs/research/channel-member-layout.md", "packages/harness/RESEARCH.md"),
      [repair({ path: "packages/harness/src/openbot_agent_runtime/catalog.py" })],
    ),
    [],
  );
});

test("reuse needs a concrete decision, assumptions, no copying and immutable diff evidence", () => {
  for (const body of [
    reuse.replace("docs/research/channel-member-layout.md", "TODO"),
    reuse.replace(/Unchanged assumptions:.*/u, "Unchanged assumptions: TBD"),
    reuse.replace("adapted: no", "adapted: yes"),
    `${reuse}\n- Research artifact: docs/research/example.md`,
    `${reuse}\n- Research exemption: spelling`,
  ])
    assert.ok(validatePullRequestResearch(body, [repair()]).length > 0);
  assert.ok(validatePullRequestResearch(reuse).length > 0);
  assert.ok(validatePullRequestResearch(reuse, []).length > 0);
  assert.ok(validatePullRequestResearch(reuse, Array(101).fill(repair())).length > 0);
});

test("repair label cannot hide dependencies, authorization, persistence, protocols or workflow rules", () => {
  for (const path of [
    "package.json",
    "package-lock.json",
    "packages/harness/pyproject.toml",
    "packages/harness/requirements.lock",
    "packages/protocol/src/frames.ts",
    "apps/server-python/src/openbot_server/auth_store.py",
    "packages/policy/src/index.ts",
    "apps/server-python/src/openbot_server/work_store.py",
    "packages/db/migrations/0099.sql",
    "packages/harness/src/openbot_agent_runtime/contracts.py",
    "packages/harness/src/openbot_agent_runtime/guard.py",
    "AGENTS.md",
    "apps/web/AGENTS.md",
    ".agents/skills/openbot-change/SKILL.md",
    ".github/workflows/ci.yml",
    "scripts/check-pr-research.ts",
    "apps/web/src/helpers/authorization.ts",
    "other/credential-store.py",
    "deploy/app.entitlements",
    "api/wire.schema.json",
  ])
    assert.ok(validatePullRequestResearch(reuse, [repair(), repair({ path })]).length > 0, path);
  for (const overrides of [{ afterMode: "100755" }, { afterMode: "120000" }, { after: "binary\0" }])
    assert.ok(validatePullRequestResearch(reuse, [repair(overrides)]).length > 0);
});

test("skills and prompts are not ordinary prose even under docs", () => {
  for (const path of [
    "docs/skills/example/SKILL.md",
    "docs/prompts/model.md",
    "docs/SKILL.md",
    ".agents/skills/example/SKILL.md",
  ])
    assert.ok(
      validatePullRequestResearch(exemption, [documentationChange("before", "after", { path })])
        .length > 0,
      path,
    );
});

test("reuse CLI reads actual blobs and refuses a mixed dependency or permission change", (t) => {
  const fixture = fixtureRepository(t);
  const source = "apps/web/src/components/Menu.tsx";
  fixture.write(source, 'export const label = "Before";');
  const base = fixture.commit();
  fixture.write(source, 'export const label = "After";');
  let head = fixture.commit();
  const eventPath = join(tmpdir(), `openbot-reuse-${process.pid}.json`);
  t.after(() => rmSync(eventPath, { force: true }));
  const run = () => {
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { body: reuse, base: { sha: base }, head: { sha: head } } }),
    );
    return spawnSync(process.execPath, [resolve("scripts/check-pr-research.ts")], {
      cwd: fixture.cwd,
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
      encoding: "utf8",
    });
  };
  fixture.write(source, 'import unexpected from "working-tree-lie";');
  assert.equal(run().status, 0);
  fixture.write("package.json", '{"dependencies":{"new":"1.0.0"}}');
  head = fixture.commit();
  assert.equal(run().status, 1);
  fixture.git("reset", "--hard", base);
  fixture.write(source, 'export const label = "After";');
  fixture.write("apps/server-python/src/openbot_server/auth_store.py", "allow = True");
  head = fixture.commit();
  assert.equal(run().status, 1);
});

test("ordinary internal repairs reuse decisions across languages and directories", () => {
  for (const path of [
    "apps/web/src/format.ts",
    "apps/desktop/src/format.ts",
    "apps/node/src/text.ts",
    "apps/server-python/src/openbot_server/text.py",
    "packages/harness/src/openbot_agent_runtime/text.py",
    "providers/docker/src/text.ts",
    "scripts/format.mjs",
    "deploy/server/healthcheck.py",
    "experiments/example/render.ts",
    "unknown/helper.py",
    "docs/guide.md",
    "apps/web/src/themes.css",
  ])
    assert.deepEqual(validatePullRequestResearch(reuse, [repair({ path })]), [], path);
});

test("internal extraction can add, import and retire source in the same reviewed change", () => {
  assert.deepEqual(
    validatePullRequestResearch(reuse, [
      repair({
        path: "scripts/text.ts",
        beforeMode: "000000",
        before: "",
        after: "export const label = 'After';",
      }),
      repair({ path: "scripts/text.mjs", afterMode: "000000", after: "" }),
      repair({
        path: "scripts/print.ts",
        after: "import { label } from './text.ts'; console.log(label);",
      }),
      repair({ path: "scripts/print.test.ts", beforeMode: "000000", before: "" }),
    ]),
    [],
  );
});

test("manifest script wiring can reuse a decision, but dependencies, runtime and public exports cannot", () => {
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    scripts: { check: "node check.mjs" },
    dependencies: { existing: "1.0.0" },
    engines: { node: ">=22.22.2" },
  };
  const change = repair({
    path: "tools/example/package.json",
    before: JSON.stringify(manifest),
    after: JSON.stringify({ ...manifest, scripts: { check: "node check.ts" } }),
  });
  assert.deepEqual(validatePullRequestResearch(reuse, [change]), []);
  for (const override of [
    { dependencies: { existing: "2.0.0" } },
    { devDependencies: { added: "1.0.0" } },
    { engines: { node: ">=26" } },
    { exports: "./new.ts" },
    { workspaces: ["extra"] },
    { bin: "./run.ts" },
    { scripts: { postinstall: "node new-side-effect.ts" } },
  ])
    assert.match(
      validatePullRequestResearch(reuse, [
        { ...change, after: JSON.stringify({ ...manifest, ...override }) },
      ]).join(" "),
      /package contract changed/u,
    );
  for (const after of ["broken", "null", "[]"])
    assert.match(
      validatePullRequestResearch(reuse, [{ ...change, after }]).join(" "),
      /unreadable package manifest/u,
    );
});

test("boundary artifacts stay protected even under test or previously eligible UI paths", () => {
  for (const path of [
    "apps/web/src/components/permission.ts",
    "apps/web/src/components/identity.ts",
    "fixtures/new.proto",
    "fixtures/new.sql",
    "fixtures/test.schema.json",
    "tools/requirements-dev.txt",
    "tools/Cargo.lock",
    "tools/go.mod",
    "apps/desktop/app.entitlements",
    "other/prompts/model.md",
    ".github/CODEOWNERS",
  ])
    assert.ok(validatePullRequestResearch(reuse, [repair({ path })]).length > 0, path);
  for (const overrides of [
    { beforeMode: "100755", afterMode: "100644" },
    { beforeMode: "000000", afterMode: "100755" },
    { beforeMode: "100755", afterMode: "000000" },
    { path: "docs/../other.py" },
    { path: "space\nname.ts" },
  ])
    assert.ok(validatePullRequestResearch(reuse, [repair(overrides)]).length > 0);
});

test("actual Git inventory reads retired source and manifest blobs before deciding reuse", (t) => {
  const f = fixtureRepository(t);
  f.write("scripts/text.mjs", "export const label = 'Before';");
  f.write(
    "package.json",
    JSON.stringify({ scripts: { check: "node scripts/text.mjs" }, dependencies: { old: "1.0.0" } }),
  );
  const base = f.commit();
  f.git("mv", "scripts/text.mjs", "scripts/text.ts");
  f.write(
    "package.json",
    JSON.stringify({ scripts: { check: "node scripts/text.ts" }, dependencies: { old: "1.0.0" } }),
  );
  const head = f.commit();
  const changes = readPullRequestChanges(
    { pull_request: { base: { sha: base }, head: { sha: head } } },
    f,
  );
  assert.equal(changes.length, 3);
  assert.deepEqual(validatePullRequestResearch(reuse, changes), []);
  f.write(
    "package.json",
    JSON.stringify({ scripts: { check: "node scripts/text.ts" }, dependencies: { old: "2.0.0" } }),
  );
  const rejectedHead = f.commit();
  f.write("package.json", "{}");
  const rejected = readPullRequestChanges(
    { pull_request: { base: { sha: base }, head: { sha: rejectedHead } } },
    f,
  );
  assert.match(validatePullRequestResearch(reuse, rejected).join(" "), /package contract changed/u);
});
