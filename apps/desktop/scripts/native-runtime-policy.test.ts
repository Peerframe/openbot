import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { collectProductionPackageGraph } from "../../../scripts/production-package-graph.ts";
import {
  mixedCandidateGraph,
  nativeOptionalPackageApplies,
  pythonCandidateGraph,
} from "./native-runtime-policy.ts";

it("selects only the target-specific optional native library and honors npm exclusions", () => {
  expect(nativeOptionalPackageApplies({ os: ["win32"], cpu: ["x64"] }, "win32", "x64")).toBe(true);
  expect(nativeOptionalPackageApplies({ os: ["darwin"], cpu: ["arm64"] }, "win32", "x64")).toBe(
    false,
  );
  expect(nativeOptionalPackageApplies({ os: ["!win32"] }, "win32", "x64")).toBe(false);
  expect(nativeOptionalPackageApplies({}, "win32", "x64")).toBe(true);
  expect(() => nativeOptionalPackageApplies({ os: "win32" }, "win32", "x64")).toThrow();
});

it("uses the retained lock graph for only DB migrations and document parser dependencies", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  );
  const graph = pythonCandidateGraph(lock);
  expect(graph.workspaceKeys).toEqual(["packages/db"]);
  for (const key of [
    "node_modules/pdfjs-dist",
    "node_modules/officeparser",
    "node_modules/tesseract.js",
    "node_modules/drizzle-orm",
    "node_modules/postgres",
  ])
    expect(graph.packageKeys).toContain(key);
  expect(graph.packageKeys.some((key) => key.includes("@ai-sdk") || key.endsWith("/hono"))).toBe(
    false,
  );
  delete lock.packages["packages/python-node-runtime"].dependencies["pdfjs-dist"];
  expect(() => pythonCandidateGraph(lock)).toThrow("missing");
});
it("resolves the same parser/migration closure after the business Server is removed", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../packages/python-node-runtime/package.json", import.meta.url),
      "utf8",
    ),
  );
  expect(lock.packages["packages/python-node-runtime"].dependencies).toEqual(manifest.dependencies);
  expect(lock.packages["node_modules/@openbot/python-node-runtime"]).toEqual({
    resolved: "packages/python-node-runtime",
    link: true,
  });
  // Preserve the former retained-root semantics solely as a regression oracle.
  const old = structuredClone(lock);
  old.packages["apps/server"] = { name: "@openbot/server", dependencies: manifest.dependencies };
  const oldGraph = collectProductionPackageGraph(old, "apps/server");
  const expected = {
    ...oldGraph,
    workspaceKeys: oldGraph.workspaceKeys.filter((key) => key !== "apps/server"),
  };
  const nodeBefore = collectProductionPackageGraph(lock);
  expect(pythonCandidateGraph(lock)).toEqual(expected);
  delete lock.packages["apps/server"];
  delete lock.packages["node_modules/@openbot/server"];
  expect(pythonCandidateGraph(lock)).toEqual(expected);
  expect(collectProductionPackageGraph(lock)).toEqual(nodeBefore);
  delete lock.packages["packages/python-node-runtime"];
  expect(() => pythonCandidateGraph(lock)).toThrow("missing");
});

it("fails closed on unresolved parser packages and invalid retained DB workspace links", async () => {
  const original = JSON.parse(
    await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  );
  const missing = structuredClone(original);
  delete missing.packages["node_modules/pdfjs-dist"];
  expect(() => pythonCandidateGraph(missing)).toThrow("unresolved");
  const link = structuredClone(original);
  link.packages["node_modules/@openbot/db"].resolved = "apps/server";
  expect(() => pythonCandidateGraph(link)).toThrow("invalid");
  expect(() => collectProductionPackageGraph(original, "packages/unreviewed")).toThrow(
    "Unsupported",
  );
});

it("adds the pinned TS entry to the Python closure without WS tests or the retired oracle", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  );
  const python = pythonCandidateGraph(lock);
  const mixed = mixedCandidateGraph(lock);
  expect(mixed.workspaceKeys).toEqual([
    "apps/server-ts",
    "packages/db",
    "packages/domain",
    "packages/employee-publisher",
    "packages/protocol",
    "packages/work",
  ]);
  for (const key of python.packageKeys) expect(mixed.packageKeys).toContain(key);
  expect(new Set(mixed.packageKeys).size).toBe(mixed.packageKeys.length);
  expect(mixed.packageKeys).toContain("node_modules/fastify");
  expect(mixed.packageKeys).toContain("node_modules/@fastify/reply-from");
  expect(mixed.packageKeys).toContain("node_modules/@temporalio/core-bridge");
  expect(mixed.packageKeys).toContain("node_modules/@temporalio/worker");
  expect(
    mixed.packageKeys.some((key) => key.endsWith("/ws") || key.includes("legacy-server")),
  ).toBe(false);
  lock.packages["node_modules/@fastify/reply-from"].version = "12.6.4";
  expect(() => mixedCandidateGraph(lock)).toThrow("reviewed pin");
});
