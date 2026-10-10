import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { collectProductionPackageGraph } from "../../../scripts/production-package-graph.ts";
import {
  productCandidateGraph,
  nativeOptionalPackageApplies,
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

it("fails closed on unresolved parser packages and invalid retained DB workspace links", async () => {
  const original = JSON.parse(
    await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  );
  const missing = structuredClone(original);
  delete missing.packages["node_modules/pdfjs-dist"];
  expect(() => productCandidateGraph(missing)).toThrow("unresolved");
  const link = structuredClone(original);
  link.packages["node_modules/@openbot/db"].resolved = "apps/server";
  expect(() => productCandidateGraph(link)).toThrow("invalid");
  expect(() => collectProductionPackageGraph(original, "packages/unreviewed")).toThrow(
    "Unsupported",
  );
});

it("resolves the complete Server, parser and Worker closure without a Python workspace", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  );
  const mixed = productCandidateGraph(lock);
  expect(mixed.workspaceKeys).toEqual([
    "apps/server",
    "packages/db",
    "packages/domain",
    "packages/employee-publisher",
    "packages/logging",
    "packages/protocol",
    "packages/work",
  ]);
  for (const name of ["pdfjs-dist", "officeparser", "tesseract.js", "drizzle-orm", "postgres"])
    expect(mixed.packageKeys).toContain(`node_modules/${name}`);
  const missingParser = structuredClone(lock);
  delete missingParser.packages["apps/server"].dependencies["pdfjs-dist"];
  expect(() => productCandidateGraph(missingParser)).toThrow("missing");
  expect(new Set(mixed.packageKeys).size).toBe(mixed.packageKeys.length);
  expect(mixed.packageKeys).toContain("node_modules/fastify");
  expect(mixed.packageKeys).toContain("node_modules/@fastify/static");
  expect(mixed.packageKeys).toContain("node_modules/@temporalio/core-bridge");
  expect(mixed.packageKeys).toContain("node_modules/@temporalio/worker");
  expect(mixed.packageKeys).toContain("node_modules/ws");
  expect(lock.packages["node_modules/ws"].version).toBe("8.21.3");
  expect(mixed.packageKeys.some((key) => key.includes("legacy-server"))).toBe(false);
  lock.packages["node_modules/@fastify/static"].version = "10.1.5";
  expect(() => productCandidateGraph(lock)).toThrow("reviewed pin");
});
