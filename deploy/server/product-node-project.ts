import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectProductionPackageGraph,
  type ProductionPackageGraph,
} from "../../scripts/production-package-graph.ts";

export type ProductProfile = "runtime" | "build";
type Json = Record<string, unknown>;
type ProfileSpec = {
  readonly workspaces: readonly string[];
  readonly tools: readonly (readonly [owner: string, names: readonly string[]])[];
};
type WorkspaceLockEntry = { name: string; version: unknown; dependencies: Json };
type ProductManifest = {
  name: string;
  version: "0.0.0";
  private: true;
  type: "module";
  license: "MIT";
  workspaces: string[];
};
export type ProductProjection = {
  graph: ProductionPackageGraph;
  manifest: ProductManifest;
  workspaces: Record<string, WorkspaceLockEntry>;
  lock: {
    name: string;
    version: string;
    lockfileVersion: 3;
    requires: true;
    packages: Record<string, unknown>;
  };
};
const ENTRY = "packages/python-node-runtime";
const RUNTIME_WORKSPACES = ["packages/db", ENTRY] as const;
const PROFILES: Readonly<Record<ProductProfile, ProfileSpec>> = {
  runtime: { workspaces: RUNTIME_WORKSPACES, tools: [] },
  build: {
    workspaces: [...RUNTIME_WORKSPACES, "packages/domain", "packages/protocol", "apps/web"],
    tools: [
      ["", ["typescript", "@types/node"]],
      ["apps/web", ["@types/react", "@types/react-dom", "@vitejs/plugin-react", "vite"]],
    ],
  },
};
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isProfile = (value: unknown): value is ProductProfile =>
  value === "runtime" || value === "build";
function entryAt(packages: Json, key: string, message: string): Json {
  const entry = packages[key];
  if (!isRecord(entry)) throw new Error(message);
  return entry;
}
function dependenciesOf(entry: Json): Json {
  if (!isRecord(entry.dependencies)) throw new Error("Malformed product lock dependencies.");
  return entry.dependencies;
}
function addBuildTools(packages: Json, spec: ProfileSpec): void {
  const entryDeps = dependenciesOf(entryAt(packages, ENTRY, "Product entry is missing."));
  for (const [owner, names] of spec.tools) {
    const ownerEntry = packages[owner];
    const declared =
      isRecord(ownerEntry) && isRecord(ownerEntry.devDependencies)
        ? ownerEntry.devDependencies
        : {};
    for (const name of names) {
      const version = declared[name];
      const installed = packages[`node_modules/${name}`];
      if (
        typeof version !== "string" ||
        !version ||
        !isRecord(installed) ||
        installed.version !== version
      )
        throw new Error("Product build tool differs from the fixed lock.");
      entryDeps[name] = version;
    }
  }
  const web = entryAt(packages, "apps/web", "Product Web workspace is missing.");
  if (typeof web.version !== "string") throw new Error("Product Web workspace is missing.");
  entryDeps["@openbot/web"] = web.version;
  for (const entry of Object.values(packages)) if (isRecord(entry)) delete entry.dev;
}
function assertOwnedWorkspaces(graph: ProductionPackageGraph, spec: ProfileSpec): void {
  const allowed = new Set(spec.workspaces);
  if (
    graph.workspaceKeys.length !== allowed.size ||
    graph.workspaceKeys.some((key) => !allowed.has(key))
  )
    throw new Error("Unexpected product workspace dependency.");
}

/** Project fixed runtime/build roots; dependency traversal belongs to the shared graph owner. */
export function project(lock: unknown, profile: unknown): ProductProjection {
  if (!isProfile(profile)) throw new Error("Unknown product projection.");
  const spec = PROFILES[profile];
  if (!isRecord(lock) || !isRecord(lock.packages)) throw new Error("Malformed product lock.");
  const packages = structuredClone(lock.packages);
  const selected = { ...lock, packages };
  if (spec.tools.length > 0) addBuildTools(packages, spec);
  const graph = collectProductionPackageGraph(selected, ENTRY);
  assertOwnedWorkspaces(graph, spec);
  const name = `openbot-python-product-${profile}`;
  const manifest: ProductManifest = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    license: "MIT",
    workspaces: graph.workspaceKeys,
  };
  const entries: Record<string, unknown> = { "": manifest };
  const workspaces: Record<string, WorkspaceLockEntry> = {};
  for (const key of graph.workspaceKeys) {
    const source = entryAt(packages, key, "Product workspace is missing.");
    if (typeof source.name !== "string") throw new Error("Product workspace is missing a name.");
    const entry: WorkspaceLockEntry = {
      name: source.name,
      version: source.version,
      dependencies: dependenciesOf(source),
    };
    workspaces[key] = entry;
    entries[key] = entry;
    entries[`node_modules/${entry.name}`] = { link: true, resolved: key };
  }
  for (const key of graph.packageKeys) entries[key] = packages[key];
  return {
    graph,
    manifest,
    workspaces,
    lock: {
      name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: entries,
    },
  };
}
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

export async function writeProjection(
  source: string,
  output: string,
  profile: unknown,
): Promise<ProductionPackageGraph> {
  const result = project(await readJson(join(source, "package-lock.json")), profile);
  await mkdir(output, { recursive: true });
  for (const key of result.graph.workspaceKeys) {
    const manifest = await readJson(join(source, key, "package.json"));
    const entry = result.workspaces[key];
    if (
      !entry ||
      !isRecord(manifest) ||
      manifest.name !== entry.name ||
      manifest.version !== entry.version
    )
      throw new Error("Workspace manifest differs from the lock.");
    const clean: Json = { ...manifest, dependencies: entry.dependencies };
    delete clean.scripts;
    delete clean.devDependencies;
    await mkdir(join(output, key), { recursive: true });
    await writeJson(join(output, key, "package.json"), clean);
  }
  await writeJson(join(output, "package.json"), result.manifest);
  await writeJson(join(output, "package-lock.json"), result.lock);
  return result.graph;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const [source, output, profile] = args;
  if (args.length !== 3 || !source || !output || !isProfile(profile))
    throw new Error("Usage: product-node-project <source> <new-output> runtime|build");
  await writeProjection(resolve(source), resolve(output), profile);
}
