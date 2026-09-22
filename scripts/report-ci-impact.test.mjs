import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeImpact,
  classifyImpact,
  classifyPath,
  eventBase,
  parseDryRun,
  renderSummary,
} from "./report-ci-impact.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const turboPath = resolve(repository, "node_modules/turbo/bin/turbo");
const turboVersion = JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8"))
  .devDependencies.turbo;
const workspaces = [
  { name: "@openbot/logging", directory: "packages/logging" },
  { name: "@openbot/web", directory: "apps/web" },
  { name: "@openbot/desktop", directory: "apps/desktop" },
];
const dry = (packages = workspaces) =>
  JSON.stringify({
    turboVersion,
    packages: packages.map((item) => item.name),
    tasks: packages.flatMap((item) =>
      ["typecheck", "test", "build"].map((task) => ({
        ...item,
        package: item.name,
        task,
        taskId: `${item.name}#${task}`,
      })),
    ),
  });

for (const path of [
  "packages/protocol/src/index.ts",
  "packages/policy/src/index.ts",
  "packages/db/migrations/0001.sql",
  "packages/provider-sdk/src/index.ts",
  "apps/server/src/anything.ts",
  "apps/node/src/new-feature.ts",
  "apps/worker-host-macos/Sources/main.swift",
  "apps/desktop/src/ipc-security.ts",
  "apps/web/src/auth-session-recovery.ts",
  "providers/docker/src/approval.ts",
  "apps/web/src/session.ts",
  "package-lock.json",
  "package.json",
  "apps/web/package.json",
  "apps/web/tsconfig.json",
  "apps/web/vite.config.ts",
  "turbo.json",
  "biome.json",
  ".github/workflows/ci.yml",
  "scripts/new-check.mjs",
  "README.md",
  "docs/PROTOCOL.md",
  "apps/web/README.md",
  "new-module/src/feature.ts",
  "providers/new-provider/src/index.ts",
  "apps/web/public/new.js",
  "../apps/web/src/a.ts",
  "apps/web/src/../../secret.ts",
  "apps/web/src/malicious\n::error::.ts",
]) {
  test(`widens ${JSON.stringify(path)} to full validation`, () => {
    assert.notEqual(classifyPath(path), null);
    const report = classifyImpact({
      paths: [path],
      allPackages: workspaces,
      affectedPackages: workspaces,
    });
    assert.equal(report.scope, "full");
    assert.deepEqual(report.commands, ["npm run check"]);
  });
}

test("uses selected dependents without reimplementing a dependency graph", () => {
  const report = classifyImpact({
    paths: ["packages/logging/src/index.ts"],
    allPackages: workspaces,
    affectedPackages: workspaces,
  });
  assert.equal(report.scope, "focused");
  assert.deepEqual(report.packages, workspaces);
  assert.match(report.commands[1], /--filter=@openbot\/web/);
  assert.match(report.commands[1], /--filter=@openbot\/desktop/);
  assert.match(renderSummary(report), /All existing CI gates still run/);
});

test("omitted changed module and deleted workspace widen to full", () => {
  assert.equal(
    classifyImpact({
      paths: ["apps/web/src/index.ts"],
      allPackages: workspaces,
      affectedPackages: [],
    }).scope,
    "full",
  );
  assert.equal(
    classifyImpact({
      paths: ["apps/deleted/src/index.ts"],
      allPackages: workspaces,
      affectedPackages: workspaces,
    }).scope,
    "full",
  );
});

test("no changes never recommends skipping required checks", () => {
  const report = classifyImpact({ paths: [], allPackages: workspaces, affectedPackages: [] });
  assert.equal(report.scope, "unchanged");
  assert.deepEqual(report.commands, ["npm run check"]);
  assert.equal(
    classifyImpact({ paths: [], allPackages: workspaces, affectedPackages: workspaces }).scope,
    "full",
  );
});

test("dry-run parser validates identities and retains dependency build packages", () => {
  const value = JSON.parse(dry());
  value.packages = ["@openbot/desktop"];
  assert.equal(parseDryRun(JSON.stringify(value), turboVersion).length, 3);
  assert.throws(() => parseDryRun("invalid", turboVersion));
  assert.throws(() => parseDryRun(dry(), "999.0.0"));
  for (const mutation of [
    (data) => {
      data.packages.push("--filter=*");
    },
    (data) => {
      data.tasks[0].package = "$(touch secret)";
    },
    (data) => {
      data.tasks[0].directory = "../outside";
    },
    (data) => {
      data.tasks[0].task = "dev";
    },
    (data) => {
      data.tasks.push(data.tasks[0]);
    },
    (data) => {
      data.tasks = [];
    },
  ]) {
    const changed = JSON.parse(dry());
    mutation(changed);
    assert.throws(() => parseDryRun(JSON.stringify(changed), turboVersion));
  }
});

test("selects fork-safe event SHAs and rejects absent or untrusted history", () => {
  const sha = "a".repeat(40);
  assert.equal(
    eventBase("pull_request", { pull_request: { base: { sha }, head: { ref: "$(bad)" } } }),
    sha,
  );
  assert.equal(eventBase("push", { before: sha }), sha);
  assert.throws(() => eventBase("push", { before: "0".repeat(40) }));
  assert.throws(() => eventBase("pull_request_target", {}));
  assert.throws(() => eventBase("pull_request", { pull_request: { base: { sha: "--help" } } }));
});

function fixture(t) {
  const cwd = mkdtempSync(resolve(tmpdir(), "openbot-ci-impact-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
    writeFileSync(resolve(cwd, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=OpenBot fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  write(".gitignore", ".turbo/\nnode_modules/\n");
  write("package.json", {
    name: "impact-fixture",
    private: true,
    packageManager: "npm@10.9.9",
    workspaces: ["apps/*", "packages/*", "providers/*"],
    devDependencies: { turbo: turboVersion },
  });
  write("turbo.json", {
    tasks: {
      build: { dependsOn: ["^build"] },
      test: { dependsOn: ["^build"] },
      typecheck: { dependsOn: ["^build"] },
    },
  });
  const lock = {
    name: "impact-fixture",
    lockfileVersion: 3,
    packages: {
      "": { name: "impact-fixture", workspaces: ["apps/*", "packages/*", "providers/*"] },
    },
  };
  const items = [...workspaces, { name: "@openbot/provider-coder", directory: "providers/coder" }];
  for (const [index, item] of items.entries()) {
    const dependencies = index > 0 && index < 3 ? { [items[index - 1].name]: "0.0.0" } : {};
    const manifest = {
      name: item.name,
      version: "0.0.0",
      dependencies,
      scripts: Object.fromEntries(
        ["build", "test", "typecheck"].map((task) => [
          task,
          "node -e \"require('node:fs').writeFileSync('TASK_EXECUTED', 'bad');process.exit(99)\"",
        ]),
      ),
    };
    write(`${item.directory}/package.json`, manifest);
    write(`${item.directory}/src/index.ts`, "export const value = 1;\n");
    lock.packages[item.directory] = manifest;
    lock.packages[`node_modules/${item.name}`] = { resolved: item.directory, link: true };
  }
  write("package-lock.json", lock);
  return { cwd, write, commit, items };
}

test("real pinned Turbo reports reverse dependencies, handles rename and never runs tasks", (t) => {
  assert.ok(existsSync(turboPath), "npm ci must install the pinned Turbo before integration tests");
  const f = fixture(t);
  const base = f.commit();
  f.write("packages/logging/src/index.ts", "export const value = 2;\n");
  f.commit();
  const report = analyzeImpact({ cwd: f.cwd, base, turboPath });
  assert.equal(report.scope, "focused", JSON.stringify(report));
  assert.deepEqual(
    new Set(report.packages.map((item) => item.name)),
    new Set(workspaces.map((item) => item.name)),
  );
  assert.equal(report.changedFileCount, 1);
  for (const item of f.items)
    assert.equal(existsSync(resolve(f.cwd, item.directory, "TASK_EXECUTED")), false);

  const renameBase = report.head;
  renameSync(resolve(f.cwd, "apps/web/src/index.ts"), resolve(f.cwd, "apps/web/src/renamed.ts"));
  f.commit();
  const renamed = analyzeImpact({ cwd: f.cwd, base: renameBase, turboPath });
  assert.equal(renamed.scope, "focused");
  assert.equal(renamed.changedFileCount, 2);

  assert.equal(analyzeImpact({ cwd: f.cwd, base: "HEAD", turboPath }).scope, "unchanged");
  assert.equal(analyzeImpact({ cwd: f.cwd, base: "missing-ref", turboPath }).scope, "full");
  assert.equal(analyzeImpact({ cwd: f.cwd, base, head: base, turboPath }).scope, "full");
  assert.equal(
    analyzeImpact({ cwd: f.cwd, base, turboPath: resolve(f.cwd, "missing-turbo") }).scope,
    "full",
  );
  f.write("README.md", "# Contract claims\n");
  f.commit();
  const rootOnly = analyzeImpact({ cwd: f.cwd, base: "HEAD~1", turboPath });
  assert.equal(rootOnly.scope, "full");
  assert.equal(rootOnly.changedFileCount, 1);
  assert.equal(rootOnly.packages.length, 4);
  assert.match(rootOnly.reasons.join(), /Documentation changes/);
  assert.doesNotMatch(rootOnly.reasons.join(), /unavailable/);
  f.write("apps/web/src/uncommitted.ts", "export {};\n");
  assert.match(analyzeImpact({ cwd: f.cwd, base, turboPath }).reasons.join(), /uncommitted/);
});

test("workflow keeps every full gate and does not consume report outputs", () => {
  const workflow = readFileSync(resolve(repository, ".github/workflows/ci.yml"), "utf8");
  assert.match(
    workflow,
    /Report advisory CI impact without changing required checks\n {8}run: node scripts\/report-ci-impact\.mjs\n {6}- run: npm run check/,
  );
  assert.doesNotMatch(
    workflow,
    /pull_request_target:|secrets\.|needs\.[\w-]*impact|steps\.[\w-]*impact|--affected|--filter=/,
  );
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(
    workflow,
    /needs: \[security, validate, portable, windows-worker-host, database, server-container\]/,
  );
});
