import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type PullRequestChange,
  readPullRequestChanges,
  researchTrigger,
  validatePullRequestResearch,
} from "./check-pr-research.ts";

const section = `## What changed

Adopt a reviewed parser.

## Open-source research

- Evidence: [parser choice](docs/research/parser.md)
- Source copied or substantially adapted: no

## Verification
`;

test("accepts a linked record, ADR, prior PR or issue with a yes/no source line", () => {
  assert.deepEqual(validatePullRequestResearch(section), []);
  for (const link of [
    "docs/decisions/0020-open-source-first-feature-gate.md",
    "docs/OPEN_SOURCE_REUSE.md#root",
    "apps/desktop/RESEARCH.md",
    "https://github.com/Peerframe/openbot/pull/108",
    "https://github.com/Peerframe/openbot/issues/12",
  ])
    assert.deepEqual(
      validatePullRequestResearch(
        section
          .replace("[parser choice](docs/research/parser.md)", link)
          .replace(": no", ": yes, notice in THIRD_PARTY_NOTICES.md"),
      ),
      [],
    );
});

test("names exactly what a missing or malformed section must add", () => {
  assert.deepEqual(validatePullRequestResearch("## What changed\n\nBump a package."), [
    "add a '## Open-source research' section to the PR body",
  ]);
  assert.deepEqual(validatePullRequestResearch("## Open-source research\n\nWe looked around."), [
    "link a research record, ADR or prior PR, e.g. docs/research/<topic>.md, " +
      "docs/decisions/<number>-<title>.md or https://github.com/Peerframe/openbot/pull/<number>",
    "add the line '- Source copied or substantially adapted: no' (or 'yes' with the notice location)",
  ]);
  assert.deepEqual(
    validatePullRequestResearch(section.replace(": no", ": no / yes — notice location")),
    [
      "'Source copied or substantially adapted:' must start with yes or no, found 'no / yes — notice location'",
    ],
  );
  // A link elsewhere in the body, or only inside a comment, does not count.
  assert.match(
    validatePullRequestResearch(
      `See docs/research/parser.md\n\n## Open-source research\n\n<!-- docs/research/x.md -->\n- Source copied or substantially adapted: no\n`,
    ).join(" "),
    /link a research record/u,
  );
});

test("the unchanged repository template does not satisfy a triggered PR", () => {
  const template = readFileSync(".github/pull_request_template.md", "utf8");
  assert.equal(validatePullRequestResearch(template).length, 2);
});

const change = (path: string, overrides: Partial<PullRequestChange> = {}): PullRequestChange => ({
  path,
  status: "modified",
  ...overrides,
});
const manifest = (fields: Record<string, unknown>) => JSON.stringify({ name: "x", ...fields });

test("dependency, lock, base-image and contract changes trigger the section", () => {
  for (const triggered of [
    change("package.json", {
      before: manifest({ dependencies: { a: "1.0.0" } }),
      after: manifest({ dependencies: { a: "1.1.0" } }),
    }),
    change("apps/web/package.json", {
      status: "added",
      after: manifest({ devDependencies: { vitest: "5.0.0" } }),
    }),
    change("packages/x/package.json", { before: "{", after: "{}" }),
    change("package-lock.json"),
    change("apps/server-python/uv.lock"),
    change("apps/server-python/requirements-dev.txt"),
    change("packages/harness/pyproject.toml"),
    change("deploy/server/Dockerfile", { before: "FROM node:22\n", after: "FROM node:24\n" }),
    change("packages/protocol/src/events.ts"),
    change("packages/db/migrations/0042_add_table.sql", { status: "added" }),
    change("apps/server-python/src/openbot_server/schema/work.schema.json"),
    change("apps/desktop/build/app.entitlements"),
  ])
    assert.ok(researchTrigger(triggered), triggered.path);
});

test("docs, tests, UI, refactors, scripts-only manifests and deletions are exempt", () => {
  for (const exempt of [
    change("README.md"),
    change("docs/research/TEMPLATE.md"),
    change("apps/web/src/App.tsx"),
    change("apps/server-python/src/openbot_server/task_store.py"),
    change("packages/protocol/src/events.test.ts"),
    change("apps/server-python/tests/test_identity_store.py"),
    change(".github/workflows/ci.yml"),
    change("package.json", {
      before: manifest({ scripts: { a: "x" }, dependencies: { a: "1.0.0" } }),
      after: manifest({ scripts: { a: "y" }, dependencies: { a: "1.0.0" } }),
    }),
    change("deploy/server/Dockerfile", {
      before: "FROM node:22\nRUN a\n",
      after: "FROM node:22\nRUN b\n",
    }),
    change("package-lock.json", { status: "deleted" }),
    change("packages/db/migrations/0001_init.sql", { status: "deleted" }),
  ])
    assert.equal(researchTrigger(exempt), undefined, exempt.path);
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
    git("add", "-A");
    git("commit", "-m", "Fixture change");
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  write("README.md", "Welcome.\n");
  write("package.json", manifest({ dependencies: { a: "1.0.0" } }));
  const base = commit();
  const event = (head: string, body: string | null, baseSha = base) => ({
    pull_request: { body, base: { sha: baseSha }, head: { sha: head } },
  });
  const check = (head: string, body: string | null, baseSha = base) => {
    const eventPath = join(cwd, "..", `${cwd.split("/").at(-1)}-event.json`);
    t.after(() => rmSync(eventPath, { force: true }));
    writeFileSync(eventPath, JSON.stringify(event(head, body, baseSha)));
    return spawnSync(process.execPath, [resolve("scripts/check-pr-research.ts")], {
      cwd,
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
      encoding: "utf8",
    });
  };
  return { cwd, git, write, commit, base, event, check };
}

test("CLI: a dependency change fails without the section and passes with it", (t) => {
  const fixture = fixtureRepository(t);
  fixture.write("package.json", manifest({ dependencies: { a: "2.0.0" } }));
  const head = fixture.commit();
  const rejected = fixture.check(head, "## What changed\n\nBump a.");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /package\.json: package\.json dependencies changed/u);
  assert.match(rejected.stderr, /add a '## Open-source research' section/u);
  assert.equal(fixture.check(head, section).status, 0);
});

test("CLI: docs-only and large deletion-only PRs pass with no section or body", (t) => {
  const fixture = fixtureRepository(t);
  for (let index = 0; index < 150; index += 1)
    fixture.write(`packages/db/migrations/${index}.sql`, "select 1;\n");
  const base = fixture.commit();
  fixture.write("README.md", "Welcome to OpenBot.\n");
  const docs = fixture.commit();
  const accepted = fixture.check(docs, null, base);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /research not required/u);

  fixture.git("rm", "-r", "-q", "packages", "package.json");
  const deletion = fixture.commit();
  const changes = readPullRequestChanges(fixture.event(deletion, null, docs), fixture);
  assert.equal(changes.length, 151);
  assert.ok(changes.every((item) => item.status === "deleted"));
  assert.ok(changes.every((item) => researchTrigger(item) === undefined));
  assert.equal(fixture.check(deletion, null, docs).status, 0);
});

test("compares the PR branch with its merge base using committed content only", (t) => {
  const fixture = fixtureRepository(t);
  fixture.git("checkout", "-q", "-b", "contribution");
  fixture.write("README.md", "Updated.\n");
  const head = fixture.commit();
  fixture.git("checkout", "-q", "main");
  fixture.write("package-lock.json", "{}\n");
  const base = fixture.commit();
  fixture.write("package.json", manifest({ dependencies: { a: "9.0.0" } }));
  assert.deepEqual(readPullRequestChanges(fixture.event(head, null, base), fixture), [
    { path: "README.md", status: "modified" },
  ]);
});

test("fails closed on invalid or unavailable commits", (t) => {
  const fixture = fixtureRepository(t);
  assert.throws(
    () => readPullRequestChanges(fixture.event(fixture.base, null, "--output=/tmp/x"), fixture),
    /no valid base and head/u,
  );
  assert.throws(
    () => readPullRequestChanges(fixture.event(fixture.base, null, "f".repeat(40)), fixture),
    /^Error: Cannot list the pull-request changes\./u,
  );
});
