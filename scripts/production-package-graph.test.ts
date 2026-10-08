import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectProductionPackageGraph } from "./production-package-graph.ts";

function lock(packages: Record<string, unknown>): {
  lockfileVersion: 3;
  packages: Record<string, unknown>;
} {
  return {
    lockfileVersion: 3,
    packages: {
      "apps/node": { name: "@openbot/node", dependencies: { parent: "1" } },
      ...packages,
    },
  };
}

test("TS entry production closure includes reviewed adapters, model SDKs and native binaries", async () => {
  const source = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const graph = collectProductionPackageGraph(source, "apps/server-ts");
  assert.deepEqual(graph.workspaceKeys, [
    "apps/server-ts",
    "packages/domain",
    "packages/employee-publisher",
    "packages/protocol",
    "packages/work",
  ]);
  assert(graph.packageKeys.includes("node_modules/fastify"));
  assert(graph.packageKeys.includes("node_modules/@fastify/reply-from"));
  for (const name of [
    "openai",
    "@anthropic-ai/sdk",
    "koffi",
    "@koromix/koffi-darwin-arm64",
    "yaml",
    "@temporalio/worker",
    "@temporalio/core-bridge",
    "@temporalio/client",
    "source-map-js",
  ]) {
    assert(graph.packageKeys.includes(`node_modules/${name}`), `${name} must be staged`);
  }
  assert(!graph.packageKeys.includes("node_modules/ws"));
  assert(!graph.workspaceKeys.includes("tests/oracles/legacy-server"));
  assert.throws(() => collectProductionPackageGraph(source, "apps/server-ts/other"), /Unsupported/);
});

test("selects the nearest nested dependency without substituting a workspace link", () => {
  const source = lock({
    "node_modules/parent": { dependencies: { "@scope/child": "1" } },
    "node_modules/parent/node_modules/@scope/child": { dependencies: { leaf: "1" } },
    "node_modules/parent/node_modules/leaf": {},
    "node_modules/@scope/child": { dev: true },
    "node_modules/leaf": { dev: true },
  });
  assert.deepEqual(collectProductionPackageGraph(source).packageKeys, [
    "node_modules/parent",
    "node_modules/parent/node_modules/@scope/child",
    "node_modules/parent/node_modules/leaf",
  ]);
  source.packages["node_modules/parent/node_modules/@scope/child"] = { link: true };
  assert.throws(() => collectProductionPackageGraph(source), /development-only/);
});

test("allows absent optional packages but requires every declared production dependency", () => {
  const source = lock({ "node_modules/parent": { optionalDependencies: { missing: "1" } } });
  assert.deepEqual(collectProductionPackageGraph(source).packageKeys, ["node_modules/parent"]);
  source.packages["node_modules/parent"] = { dependencies: { missing: "1" } };
  assert.throws(() => collectProductionPackageGraph(source), /Production dependency is unresolved/);
  source.packages["node_modules/parent"] = { optionalDependencies: { present: "1" } };
  source.packages["node_modules/present"] = { dev: true };
  assert.throws(() => collectProductionPackageGraph(source), /development-only/);
});

test("rejects ambiguous workspace names and links before producing a selected graph", () => {
  const source = lock({
    "node_modules/parent": { dependencies: { "@openbot/shared": "1" } },
    "packages/shared": { name: "@openbot/shared" },
    "node_modules/@openbot/shared": { link: true, resolved: "packages/shared" },
  });
  assert.deepEqual(collectProductionPackageGraph(source).workspaceKeys, [
    "apps/node",
    "packages/shared",
  ]);
  source.packages["node_modules/@openbot/shared"] = { link: true, resolved: "packages/foreign" };
  assert.throws(
    () => collectProductionPackageGraph(source),
    /Workspace dependency link is invalid/,
  );
  source.packages["packages/duplicate"] = { name: "@openbot/shared" };
  assert.throws(() => collectProductionPackageGraph(source), /names must be present and unique/);
});

test("selects each package once in a dependency cycle without mutating the input", () => {
  const source = lock({
    "node_modules/parent": { dependencies: { child: "1" } },
    "node_modules/child": { dependencies: { parent: "1" } },
  });
  const before = structuredClone(source);
  assert.deepEqual(collectProductionPackageGraph(source), {
    workspaceKeys: ["apps/node"],
    packageKeys: ["node_modules/child", "node_modules/parent"],
  });
  assert.deepEqual(source, before);
});

test("rejects malformed JSON lock roots and missing production entries", () => {
  for (const value of [null, 1, "lock", [], {}, { lockfileVersion: 3, packages: [] }])
    assert.throws(() => collectProductionPackageGraph(value), /npm lockfileVersion 3/);
  assert.throws(
    () => collectProductionPackageGraph({ lockfileVersion: 3, packages: {} }),
    /entry is missing/,
  );
  assert.throws(
    () => collectProductionPackageGraph(lock({}), "packages/unreviewed"),
    /Unsupported production entry point/,
  );
});
