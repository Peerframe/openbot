import { collectProductionPackageGraph } from "../../../scripts/production-package-graph.ts";

export interface NativeRuntimeLock {
  packages?: Record<
    string,
    {
      name?: string;
      dependencies?: Record<string, string>;
      optional?: boolean;
      os?: unknown;
      cpu?: unknown;
    }
  >;
}

export function pythonCandidateGraph(lock: NativeRuntimeLock) {
  const entryPoint = "packages/python-node-runtime";
  const runtime = lock.packages?.[entryPoint];
  for (const name of [
    "@openbot/db",
    "pdfjs-dist",
    "officeparser",
    "tesseract.js",
    "@tesseract.js-data/eng",
    "@tesseract.js-data/chi_sim",
  ]) {
    if (typeof runtime?.dependencies?.[name] !== "string")
      throw new Error("Retained Python parser dependency is missing.");
  }
  // The metadata-only workspace owns these pins independently of the retired business Server.
  const graph = collectProductionPackageGraph(lock, entryPoint);
  return {
    ...graph,
    workspaceKeys: graph.workspaceKeys.filter((key) => key !== entryPoint),
  };
}

/** Follow the pinned npm package's declared OS/CPU filter, not the build host's directory inventory. */
export function nativeOptionalPackageApplies(
  entry: unknown,
  platform: string,
  arch: string,
): boolean {
  if (!entry || typeof entry !== "object") throw new Error("Missing locked native package entry.");
  const accepts = (rules: unknown, value: string): boolean => {
    if (rules === undefined) return true;
    if (!Array.isArray(rules) || !rules.every((rule) => typeof rule === "string"))
      throw new Error("Invalid native platform restriction.");
    if (rules.includes(`!${value}`)) return false;
    const positive = rules.filter((rule) => !rule.startsWith("!"));
    return positive.length === 0 || positive.includes("any") || positive.includes(value);
  };
  const restrictions = entry as { os?: unknown; cpu?: unknown };
  return accepts(restrictions.os, platform) && accepts(restrictions.cpu, arch);
}
