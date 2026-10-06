/** Shared lock traversal for Linux release, Desktop staging and product containers. */
export interface ProductionPackageGraph {
  workspaceKeys: string[];
  packageKeys: string[];
}

export function collectProductionPackageGraph(
  lockfile: unknown,
  entryPoint = "apps/node",
): ProductionPackageGraph {
  if (
    !["apps/node", "apps/server", "apps/server-ts", "packages/python-node-runtime"].includes(
      entryPoint,
    )
  ) {
    throw new Error("Unsupported production entry point.");
  }
  if (!isRecord(lockfile) || lockfile.lockfileVersion !== 3 || !isRecord(lockfile.packages)) {
    throw new Error("Release packaging requires an npm lockfileVersion 3 package graph.");
  }
  const packages = lockfile.packages;
  const workspaceByName = new Map<string, string>();
  for (const [packageKey, entry] of Object.entries(packages)) {
    if (packageKey !== "" && !packageKey.includes("node_modules") && isRecord(entry)) {
      if (typeof entry.name !== "string" || workspaceByName.has(entry.name)) {
        throw new Error("Workspace package names must be present and unique.");
      }
      workspaceByName.set(entry.name, packageKey);
    }
  }

  const workspaceKeys = new Set<string>();
  const packageKeys = new Set<string>();
  const visit = (packageKey: string): void => {
    // Mark before following edges: npm dependency cycles share an already selected package.
    if (workspaceKeys.has(packageKey) || packageKeys.has(packageKey)) return;
    const entry = packages[packageKey];
    if (!isRecord(entry)) throw new Error(`Dependency lock entry is missing: ${packageKey}.`);
    if (entry.dev === true)
      throw new Error(`Production dependency is marked development-only: ${packageKey}.`);
    if (packageKey.includes("node_modules")) packageKeys.add(packageKey);
    else workspaceKeys.add(packageKey);

    for (const dependencyName of Object.keys(entry.dependencies ?? {}).sort()) {
      const workspaceKey = workspaceByName.get(dependencyName);
      if (workspaceKey !== undefined) {
        const link = packages[`node_modules/${dependencyName}`];
        if (!isRecord(link) || link.link !== true || link.resolved !== workspaceKey) {
          throw new Error(`Workspace dependency link is invalid: ${dependencyName}.`);
        }
        visit(workspaceKey);
        continue;
      }
      const dependencyKey = resolvePackageKey(packages, packageKey, dependencyName);
      if (dependencyKey === undefined) {
        throw new Error(`Production dependency is unresolved: ${packageKey} -> ${dependencyName}.`);
      }
      visit(dependencyKey);
    }

    for (const dependencyName of Object.keys(entry.optionalDependencies ?? {}).sort()) {
      const dependencyKey = resolvePackageKey(packages, packageKey, dependencyName);
      if (dependencyKey !== undefined) visit(dependencyKey);
    }
  };

  visit(entryPoint);
  return {
    workspaceKeys: [...workspaceKeys].sort(),
    packageKeys: [...packageKeys].sort(),
  };
}

function resolvePackageKey(
  packages: Record<string, unknown>,
  fromKey: string,
  dependencyName: string,
): string | undefined {
  let cursor = fromKey;
  while (cursor !== "") {
    const nested = `${cursor}/node_modules/${dependencyName}`;
    const entry = packages[nested];
    if (isRecord(entry) && entry.link !== true) return nested;
    const marker = cursor.lastIndexOf("/node_modules/");
    if (marker === -1) break;
    cursor = cursor.slice(0, marker);
  }
  const root = `node_modules/${dependencyName}`;
  const entry = packages[root];
  return isRecord(entry) && entry.link !== true ? root : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
