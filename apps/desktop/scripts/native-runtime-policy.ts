import { collectProductionPackageGraph } from "../../../scripts/production-package-graph.ts";
import { TS_CANDIDATE } from "../src/ts-product-manifest.ts";

export interface NativeRuntimeLock {
  packages?: Record<
    string,
    {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      optional?: boolean;
      os?: unknown;
      cpu?: unknown;
    }
  >;
}

/** A single product closure owns all runtime imports, retained parsers and guarded migrations. */
export function productCandidateGraph(lock: NativeRuntimeLock) {
  const dependencies = lock.packages?.["apps/server"]?.dependencies;
  for (const [name, version] of [["fastify", TS_CANDIDATE.fastifyVersion], ["@fastify/static", TS_CANDIDATE.staticVersion]] as const)
    if (dependencies?.[name] !== version || lock.packages?.[`node_modules/${name}`]?.version !== version)
      throw new Error("Server dependency does not match its reviewed pin.");
  for (const name of ["@openbot/db", "pdfjs-dist", "officeparser", "tesseract.js", "@tesseract.js-data/eng", "@tesseract.js-data/chi_sim"])
    if (typeof dependencies?.[name] !== "string") throw new Error("Retained parser or migration dependency is missing.");
  return collectProductionPackageGraph(lock, "apps/server");
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
