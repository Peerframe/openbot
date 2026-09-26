// Fixed product build/runtime lock projections; the existing resolver remains authoritative.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectProductionPackageGraph } from "../../scripts/node-linux-release.mjs";

const ENTRY = "packages/python-node-runtime";
const WORKSPACES = ["packages/db", ENTRY, "packages/domain", "packages/protocol", "apps/web"];
export function project(lock, profile) {
  if (!["runtime", "build"].includes(profile)) throw new Error("Unknown product projection.");
  const selected = structuredClone(lock);
  const packages = selected.packages;
  if (profile === "build") {
    const rootTools = ["typescript", "@types/node"];
    const webTools = ["@types/react", "@types/react-dom", "@vitejs/plugin-react", "vite"];
    for (const [owner, names] of [
      ["", rootTools],
      ["apps/web", webTools],
    ]) {
      for (const name of names) {
        const version = packages[owner]?.devDependencies?.[name];
        if (!version || packages[`node_modules/${name}`]?.version !== version)
          throw new Error("Product build tool differs from the fixed lock.");
        packages[ENTRY].dependencies[name] = version;
      }
    }
    packages[ENTRY].dependencies["@openbot/web"] = packages["apps/web"].version;
    // The same resolver now traverses explicit build roots; only selected output loses dev flags.
    for (const entry of Object.values(packages)) delete entry.dev;
  }
  const graph = collectProductionPackageGraph(selected, ENTRY);
  const allowed = profile === "runtime" ? WORKSPACES.slice(0, 2) : WORKSPACES;
  if (
    graph.workspaceKeys.some((key) => !allowed.includes(key)) ||
    graph.workspaceKeys.length !== allowed.length
  )
    throw new Error("Unexpected product workspace dependency.");
  const root = {
    name: "openbot-python-product-" + profile,
    version: "0.0.0",
    private: true,
    type: "module",
    license: "MIT",
    workspaces: graph.workspaceKeys,
  };
  const entries = { "": root };
  for (const key of graph.workspaceKeys) {
    const { name, version, dependencies } = packages[key];
    entries[key] = { name, version, dependencies };
    entries["node_modules/" + name] = { link: true, resolved: key };
  }
  for (const key of graph.packageKeys) entries[key] = packages[key];
  return {
    graph,
    manifest: root,
    lock: {
      name: root.name,
      version: root.version,
      lockfileVersion: 3,
      requires: true,
      packages: entries,
    },
  };
}

export async function writeProjection(source, output, profile) {
  const result = project(
    JSON.parse(await readFile(join(source, "package-lock.json"), "utf8")),
    profile,
  );
  await mkdir(output, { recursive: true });
  for (const key of result.graph.workspaceKeys) {
    const manifest = JSON.parse(await readFile(join(source, key, "package.json"), "utf8"));
    const entry = result.lock.packages[key];
    if (manifest.name !== entry.name || manifest.version !== entry.version)
      throw new Error("Workspace manifest differs from the lock.");
    const clean = { ...manifest, dependencies: entry.dependencies };
    delete clean.scripts;
    delete clean.devDependencies;
    await mkdir(join(output, key), { recursive: true });
    await writeFile(join(output, key, "package.json"), JSON.stringify(clean, null, 2) + "\n");
  }
  await writeFile(join(output, "package.json"), JSON.stringify(result.manifest, null, 2) + "\n");
  await writeFile(join(output, "package-lock.json"), JSON.stringify(result.lock, null, 2) + "\n");
  return result.graph;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, output, profile] = process.argv.slice(2);
  if (process.argv.length !== 5)
    throw new Error("Usage: product-node-project <source> <new-output> runtime|build");
  await writeProjection(resolve(source), resolve(output), profile);
}
