/**
 * ci-scope.test.ts — selection, git inputs, and aggregate closure tests.
 * Run with: node --test scripts/ci-scope.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkResults } from "./ci-results.ts";
import { argumentsFor, changedFiles, makePlan } from "./ci-scope.ts";
import { JOBS, type JobName, selectChecks, workspaceGraph } from "./ci-selection.ts";

const graph = workspaceGraph(
  JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as unknown,
);
const select = (...paths: string[]) => selectChecks(paths, graph);
test("prose only keeps repository and security duties without binaries", () => {
  const plan = select("docs/INTERFACE.md", "README.zh-CN.md");
  assert.deepEqual(plan.required, ["security", "validate"]);
  assert.equal(plan.mode, "focused");
  assert(plan.rootChecks.includes("security:config-check"));
});
test("instructions, skills and prompts retain behavioral workflow gates", () => {
  for (const file of [
    "AGENTS.md",
    "apps/web/AGENTS.md",
    ".agents/skills/openbot-check/SKILL.md",
    "docs/prompts/review.md",
    ".github/pull_request_template.md",
  ]) {
    const plan = select(file);
    assert(
      plan.reasons.some((reason) => reason.startsWith("Contributor behavior:")),
      file,
    );
    assert(plan.rootChecks.includes("ci:check"));
    assert(plan.rootChecks.includes("docs:check"));
    assert(plan.rootChecks.includes("research:check"));
  }
});
test("developer navigation READMEs retain behavioral gates without runtime qualification", () => {
  for (const file of [".agents/README.md", ".agents/README.zh-CN.md"]) {
    const plan = select(file);
    assert.equal(plan.mode, "focused", file);
    assert.deepEqual(plan.required, ["security", "validate"], file);
    assert(plan.reasons.includes(`Contributor behavior: ${file}`), file);
    for (const gate of ["ci:check", "docs:check", "research:check", "security:config-check"])
      assert(plan.rootChecks.includes(gate), `${file}: ${gate}`);
  }
});
test("developer navigation paths do not exempt helpers, resources or near matches", () => {
  for (const file of [
    ".agents/README.en.md",
    ".agents/README.zh-cn.md",
    ".agents/readme.md",
    ".agents/README.md.mjs",
    ".agents/README.md/resource.json",
    ".agents/skills/README.md",
    ".agents/scripts/check.mjs",
    ".agents/assets/README.md",
  ])
    assert.deepEqual(select(file).required, JOBS, file);
});
test("developer navigation cannot narrow mixed changes or forced full qualification", () => {
  for (const file of [
    "scripts/ci-scope.ts",
    ".agents/skills/openbot-check/scripts/check.py",
    "apps/server-python/src/openbot_server/work_models.py",
    "unknown.file",
  ])
    assert.deepEqual(select(".agents/README.md", file).required, JOBS, file);
  assert.deepEqual(selectChecks([".agents/README.zh-CN.md"], graph, { full: true }).required, JOBS);
});
test("harness includes real installed and persistent consumers", () => {
  for (const file of [
    "packages/harness/src/openbot_agent_runtime/catalog.py",
    "packages/harness/scripts/build.sh",
  ]) {
    const plan = select(file);
    for (const job of [
      "contracts",
      "control-runtime",
      "temporal-qualification",
      "server-container",
      "desktop-product",
      "browser-product",
    ] as const satisfies readonly JobName[])
      assert(plan.required.includes(job), `${file}: ${job}`);
  }
});

test("runtime Markdown and prompt resources follow actual consumers", () => {
  for (const file of [
    "packages/harness/src/openbot_agent_runtime/prompts/system.md",
    "apps/server-python/src/openbot_server/prompts/work.md",
  ]) {
    const plan = select(file);
    assert(plan.required.includes("control-runtime"), file);
    assert(plan.required.includes("server-container"), file);
  }
  const web = select("apps/web/src/prompts/tool.md");
  assert(web.workspaces.includes("@openbot/web"));
  assert(web.workspaces.includes("@openbot/desktop"));
  assert.deepEqual(select("packages/work-contract-generator/schema.md").required, JOBS);
  assert.deepEqual(select("unknown/prompt.md").required, JOBS);
});

test("executable skill inputs cannot inherit a prose exemption", () => {
  for (const file of [
    ".agents/skills/openbot-check/scripts/check.py",
    ".agents/skills/openbot-check/assets/template.json",
    "docs/prompts/scripts/verify.mjs",
  ])
    assert.deepEqual(select(file).required, JOBS, file);
  assert.equal(select(".agents/skills/openbot-check/SKILL.md").mode, "focused");
  assert.equal(select("packages/harness/README.md").mode, "focused");
});
test("contracts, generators, locks and config conservatively include every qualification", () => {
  for (const file of [
    "apps/server-python/src/openbot_server/work_models.py",
    "packages/work-contract-generator/generate.ts",
    "scripts/argument-pairs.ts",
    "scripts/argument-pairs.test.ts",
    "scripts/tsconfig.json",
    "scripts/ci-selection.ts",
    "apps/web/src/generated/work-contract.ts",
    "package-lock.json",
    "packages/harness/pyproject.toml",
    "apps/server-python/requirements-product.lock",
    "apps/web/vite.config.ts",
    "deploy/server/Dockerfile",
  ]) {
    assert.deepEqual(select(file).required, JOBS, file);
  }
});
test("workspace selection follows transitive and dynamic consumers", () => {
  const web = select("apps/web/src/components/ChannelMembersMenu.tsx");
  assert.deepEqual(web.workspaces, ["@openbot/desktop", "@openbot/web"]);
  assert(!web.required.includes("temporal-qualification"));
  const protocol = select("packages/protocol/src/index.ts");
  for (const name of [
    "@openbot/domain",
    "@openbot/web",
    "@openbot/desktop",
    "@openbot/node",
    "@openbot/provider-docker",
  ])
    assert(protocol.workspaces.includes(name), name);
  assert(select("packages/db/src/index.ts").workspaces.includes("@openbot/desktop"));
});
test("unmapped, selector, mixed and empty changes never produce an empty green", () => {
  for (const files of [
    [],
    ["unknown.file"],
    ["scripts/ci-scope.ts"],
    ["README.md", "unknown.file"],
    [".github/workflows/ci.yml"],
  ])
    assert.deepEqual(selectChecks(files, graph).required, JOBS);
  assert.throws(() => select("../outside"), /relative/);
  assert.throws(() => workspaceGraph({}), /graph/);
});
test("immutable PR ranges and local tracked/untracked changes are separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-ci-scope-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Synthetic CI fixture");
    git("config", "user.email", "fixture@invalid.example");
    await writeFile(join(root, "README.md"), "one\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(root, "README.md"), "two\n");
    git("commit", "--quiet", "-am", "head");
    const head = git("rev-parse", "HEAD");
    await writeFile(join(root, "README.md"), "three\n");
    await mkdir(join(root, "apps"));
    await writeFile(join(root, "apps/new.py"), "pass\n");
    const committed = changedFiles(root, { base, head });
    assert.deepEqual(committed.tracked, ["README.md"]);
    assert.deepEqual(committed.untracked, []);
    assert.equal(committed.base, base);
    assert.equal(committed.head, head);
    const local = changedFiles(root, { local: true });
    assert.deepEqual(local.tracked, ["README.md"]);
    assert.deepEqual(local.untracked, ["apps/new.py"]);
    assert.throws(() => changedFiles(root, { base: "origin/main", head }), /immutable/);
    assert.throws(() => changedFiles(root, { base, head, local: true }), /separate/);
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({ packages: { "apps/web": { name: "@openbot/web" } } }),
    );
    const event = join(root, "event.json");
    await writeFile(
      event,
      JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }),
    );
    assert.equal((await makePlan(root, { event })).mode, "focused");
    assert.deepEqual((await makePlan(root, { local: true })).required, JOBS);
    await writeFile(event, JSON.stringify({ after: head }));
    assert.deepEqual((await makePlan(root, { event })).required, JOBS);
    for (const payload of [
      null,
      [],
      "push",
      { pull_request: null },
      { pull_request: {} },
      { pull_request: { base: { sha: base }, head: {} } },
      { pull_request: { base: {}, head: { sha: head } } },
      { pull_request: { base: { sha: base }, head: { sha: 1 } } },
      { pull_request: { base: { sha: null }, head: { sha: head } } },
    ]) {
      await writeFile(event, JSON.stringify(payload));
      await assert.rejects(() => makePlan(root, { event }), Error, JSON.stringify(payload));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("scope CLI never guesses a remote or silently combines input modes", () => {
  for (const args of [
    [],
    ["--local", "--full"],
    ["--what"],
    ["--base"],
    ["--event", "x", "--local"],
    ["--local", "--github-output", ""],
    ["--github-output", ""],
    ["--event", ""],
    ["--base", "", "--head", "abc"],
  ] as const)
    assert.throws(() => argumentsFor(args));
  const sparse = ["--local"] as string[];
  sparse.length = 3;
  sparse[2] = "--full";
  assert.throws(() => argumentsFor(sparse));
  assert.deepEqual(argumentsFor(["--local", "--github-output", "out.txt"]), {
    local: true,
    "github-output": "out.txt",
  });
});
const results = (plan: { required: readonly string[]; notApplicable: readonly string[] }) =>
  Object.fromEntries(
    ["scope", ...JOBS].map((job) => [
      job,
      { result: plan.notApplicable.includes(job) ? "skipped" : "success" },
    ]),
  );
test("each required job rejects failure, cancellation, missing, unknown and unexpected skip", () => {
  const plan = select("scripts/ci-scope.ts");
  assert.match(checkResults(plan, results(plan)), /satisfied/);
  for (const job of ["scope", ...JOBS]) {
    for (const result of ["failure", "cancelled", "skipped", "", "unknown", undefined] as const) {
      const needs: Record<string, { result?: unknown }> = results(plan);
      needs[job] = { result };
      assert.throws(
        () => checkResults(plan, needs),
        (error: unknown) => error instanceof Error,
        `${job}: ${result}`,
      );
    }
    const needs: Record<string, { result?: unknown }> = results(plan);
    delete needs[job];
    assert.throws(() => checkResults(plan, needs));
  }
});
test("only explicit non-applicability can skip; omissions and hidden failures fail", () => {
  const plan = select("README.md");
  assert.match(checkResults(plan, results(plan)), /satisfied/);
  for (const result of ["failure", "cancelled", undefined] as const) {
    const needs: Record<string, { result?: unknown }> = results(plan);
    needs.portable = { result };
    assert.throws(() => checkResults(plan, needs));
  }
  for (const changed of [
    null,
    { ...plan, required: [] },
    { ...plan, notApplicable: [] },
    { ...plan, required: [...plan.required, "portable"] },
  ])
    assert.throws(() => checkResults(changed, results(plan)));
});
test("actual aggregate command fails closed with missing input and accepts a valid selection", () => {
  const plan = select("README.md");
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(
      process.execPath,
      [...process.execArgv, new URL("./ci-results.ts", import.meta.url).pathname],
      {
        env,
        encoding: "utf8",
      },
    );
  assert.equal(
    run({ OPENBOT_CI_PLAN: JSON.stringify(plan), OPENBOT_CI_NEEDS: JSON.stringify(results(plan)) })
      .status,
    0,
  );
  assert.notEqual(run({}).status, 0);
});

const aggregate = (env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [new URL("./ci-results.ts", import.meta.url).pathname], {
    env,
    encoding: "utf8",
  });

test("aggregate CLI explains cancellation before parsing an unavailable scope plan", () => {
  const plan = select("scripts/ci-results.ts");
  for (const job of ["scope", ...JOBS]) {
    const needs = results(plan);
    needs[job] = { result: "cancelled" };
    for (const source of [undefined, "", " \n", "{", JSON.stringify(plan)]) {
      const result = aggregate({
        OPENBOT_CI_PLAN: source,
        OPENBOT_CI_NEEDS: JSON.stringify(needs),
      });
      assert.equal(result.status, 1, `${job}: ${source}`);
      assert.match(result.stderr, /CI cancelled:/);
      assert(result.stderr.includes(job), result.stderr);
      assert.doesNotMatch(result.stderr, /SyntaxError|AssertionError|JSON|satisfied/);
      assert.equal(result.stdout, "");
    }
    assert.throws(() => checkResults(null, needs), /CI cancelled:/);
  }
});

test("aggregate CLI keeps real failures visible when another job was cancelled", () => {
  const plan = select("scripts/ci-results.ts");
  const needs = results(plan);
  needs.scope = { result: "cancelled" };
  needs.security = { result: "failure" };
  const result = aggregate({ OPENBOT_CI_PLAN: "", OPENBOT_CI_NEEDS: JSON.stringify(needs) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CI failed:.*security.*cancelled.*scope/);
  assert.doesNotMatch(result.stderr, /SyntaxError|AssertionError/);
});

test("aggregate CLI explains scope failure, missing plans and malformed inputs", () => {
  const plan = select("README.md");
  const needs = results(plan);
  needs.scope = { result: "failure" };
  const failed = aggregate({ OPENBOT_CI_PLAN: "", OPENBOT_CI_NEEDS: JSON.stringify(needs) });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /CI failed:.*scope/);

  needs.scope = { result: "skipped" };
  const skipped = aggregate({ OPENBOT_CI_PLAN: "", OPENBOT_CI_NEEDS: JSON.stringify(needs) });
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /scope.*skipped/);

  needs.scope = { result: "success" };
  for (const source of [undefined, "", " \n", "{", "null", "[]", "{}"]) {
    const result = aggregate({ OPENBOT_CI_PLAN: source, OPENBOT_CI_NEEDS: JSON.stringify(needs) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CI scope|OPENBOT_CI_PLAN/);
    assert.doesNotMatch(result.stderr, /SyntaxError|AssertionError|cancelled|satisfied/);
  }
  for (const source of [undefined, "", "{", "null", "[]", "{}"]) {
    const result = aggregate({ OPENBOT_CI_PLAN: JSON.stringify(plan), OPENBOT_CI_NEEDS: source });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /job must report|OPENBOT_CI_NEEDS/);
    assert.doesNotMatch(result.stderr, /SyntaxError|AssertionError|cancelled|satisfied/);
  }
});

test("transitive runtime consumers keep platform, browser and Python qualifications", () => {
  for (const path of ["packages/config/src/index.ts", "packages/logging/src/index.ts"]) {
    const plan = select(path);
    for (const job of [
      "portable",
      "browser-product",
      "temporal-qualification",
    ] as const satisfies readonly JobName[])
      assert(plan.required.includes(job), `${path}: ${job}`);
  }
  assert(select("packages/employee-publisher/src/index.ts").required.includes("control-runtime"));
});

test("actual Work HTTP consumers and conformance inputs retain the cross-language gate", () => {
  const mixed = select("apps/server/src/app.ts");
  assert(mixed.required.includes("contracts"));
  assert(mixed.required.includes("control-runtime"));
  assert(mixed.workspaces.includes("@openbot/server"));
  assert.deepEqual(select("packages/contract-tests/src/work.ts").required, JOBS);
  for (const path of [
    "apps/web/src/work-api.ts",
    "apps/web/src/work-api.test.ts",
    "apps/web/src/api.ts",
    "apps/web/conformance/work-contract.acceptance.ts",
  ]) {
    const plan = select(path);
    assert(plan.required.includes("contracts"), path);
    assert(plan.workspaces.includes("@openbot/web"));
    assert(plan.workspaces.includes("@openbot/desktop"));
  }
  assert(!select("apps/web/src/components/ChannelMembersMenu.tsx").required.includes("contracts"));
});

test("browser probe and boundary test edits execute their actual regression suite", () => {
  for (const file of [
    "experiments/browser-execution/probe.ts",
    "experiments/browser-execution/probe-contract.ts",
    "experiments/browser-execution/probe-transport.ts",
    "experiments/browser-execution/probe-artifacts.ts",
    "experiments/browser-execution/egress_probe.ts",
    "experiments/browser-execution/probe.test.ts",
    "experiments/browser-execution/qualify-egress.ts",
  ]) {
    const plan = select(file);
    assert(plan.rootChecks.includes("test:browser:boundary"), file);
    assert(plan.required.includes("browser-egress"));
    assert(plan.required.includes("browser-product"));
    assert(!plan.required.includes("control-runtime"));
  }
  assert(!select("README.md").rootChecks.includes("test:browser:boundary"));
});

test("shared browser helpers and Work request schemas select their actual consumers", () => {
  for (const file of [
    "experiments/linux-execution/native-unit.ts",
    "experiments/linux-execution/command-sandbox.ts",
    "experiments/linux-execution/output-capacity.ts",
  ]) {
    const plan = select(file);
    assert(plan.rootChecks.includes("test:browser:boundary"), file);
    assert(plan.required.includes("browser-product"));
  }
  assert(select("apps/web/src/native-task-api.ts").required.includes("contracts"));
  assert(!select("apps/web/src/components/ChannelMembersMenu.tsx").required.includes("contracts"));
});

test("runtime-nested AGENTS resources cannot impersonate contributor rules", () => {
  assert(
    select("packages/harness/src/openbot_agent_runtime/prompts/AGENTS.md").required.includes(
      "control-runtime",
    ),
  );
  assert(select("apps/web/src/resources/AGENTS.md").workspaces.includes("@openbot/web"));
});

test("workspace graph rejects malformed package dependencies", () => {
  assert.throws(
    () =>
      workspaceGraph({
        packages: { "apps/web": { name: "@openbot/web", dependencies: 1 } },
      }),
    /Invalid dependencies/,
  );
  assert.throws(
    () =>
      workspaceGraph({
        packages: { "apps/web": { name: "@openbot/web", devDependencies: "x" } },
      }),
    /Invalid devDependencies/,
  );
  assert.throws(
    () =>
      workspaceGraph({
        packages: { "apps/web": { name: "@openbot/web", optionalDependencies: [] } },
      }),
    /Invalid optionalDependencies/,
  );
  assert.throws(() => workspaceGraph({ packages: { "apps/web": null } }), /Invalid package entry/);
  assert.throws(
    () => workspaceGraph({ packages: { "apps/web": ["@openbot/web"] } }),
    /Invalid package entry/,
  );
});

test("the native parser source keeps types and installed Python consumers", () => {
  const plan = select("apps/server-python/src/openbot_server/parser_worker.ts");
  assert(plan.rootChecks.includes("typecheck"));
  for (const job of [
    "control-runtime",
    "server-container",
    "desktop-product",
  ] as const)
    assert(plan.required.includes(job), job);
});

test("TS Work retains Python coexistence, real Temporal and package consumers", () => {
  const plan = select("packages/work/src/workflows.ts");
  assert(plan.workspaces.includes("@openbot/work"));
  assert(plan.workspaces.includes("@openbot/server"));
  for (const job of [
    "contracts",
    "control-runtime",
    "temporal-qualification",
    "desktop-product",
  ] as const)
    assert(plan.required.includes(job));
});
