/**
 * ci-selection.ts
 *
 * Pure CI check-selection policy: workspace graph, dependency propagation, and
 * selectChecks. This is not a second workspace graph or a release qualification.
 * Git / event / CLI ownership lives in ci-scope.ts.
 */

export const JOBS = [
  "security",
  "validate",
  "portable",
  "windows-worker-host",
  "harness",
  "python-runtime",
  "temporal-qualification",
  "browser-product",
  "browser-egress",
  "python-product-container",
  "python-desktop-preview",
  "synthetic-migration",
] as const;

export type JobName = (typeof JOBS)[number];

const PYTHON_CONSUMERS = [
  "harness",
  "python-runtime",
  "temporal-qualification",
  "browser-product",
  "python-product-container",
  "python-desktop-preview",
  "synthetic-migration",
] as const;

const ROOT_CHECKS = [
  "oracle:check",
  "docs:check",
  "research:check",
  "security:config-check",
  "ci:check",
] as const;

export type WorkspaceNode = {
  readonly path: string;
  readonly name: string;
  readonly dependencies: readonly string[];
};

export type SelectChecksOptions = {
  readonly full?: boolean;
};

export type SelectionPlan = {
  readonly version: 1;
  readonly mode: "focused" | "workspace" | "full";
  readonly workspaces: readonly string[];
  readonly rootChecks: readonly string[];
  readonly required: readonly JobName[];
  readonly notApplicable: readonly JobName[];
  readonly reasons: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageDependencyKeys(item: Record<string, unknown>, path: string): string[] {
  const merge: Record<string, unknown> = {};
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const section = item[key];
    if (section === undefined) continue;
    if (!isRecord(section)) throw new Error(`Invalid ${key} for workspace package ${path}.`);
    Object.assign(merge, section);
  }
  return Object.keys(merge);
}

export function workspaceGraph(lock: unknown): WorkspaceNode[] {
  if (!isRecord(lock)) throw new Error("No existing npm workspace graph found.");
  const packages = lock.packages;
  if (!isRecord(packages)) throw new Error("No existing npm workspace graph found.");
  const nodes: WorkspaceNode[] = [];
  for (const [path, item] of Object.entries(packages)) {
    if (!path || path.includes("node_modules")) continue;
    if (!isRecord(item)) throw new Error(`Invalid package entry for ${path || "(root)"}.`);
    const name = item.name;
    if (typeof name !== "string" || !name.startsWith("@openbot/")) continue;
    nodes.push({
      path,
      name,
      dependencies: packageDependencyKeys(item, path),
    });
  }
  if (!nodes.length) throw new Error("No existing npm workspace graph found.");
  return nodes;
}

function dependents(names: Iterable<string>, graph: readonly WorkspaceNode[]): string[] {
  const affected = new Set(names);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph) {
      // Desktop staging loads these packages dynamically; all other edges come from npm.
      const dynamic =
        node.name === "@openbot/desktop" ? ["@openbot/db", "@openbot/python-node-runtime"] : [];
      if (
        !affected.has(node.name) &&
        [...node.dependencies, ...dynamic].some((name) => affected.has(name))
      ) {
        affected.add(node.name);
        changed = true;
      }
    }
  }
  return [...affected].sort();
}

export function selectChecks(
  files: readonly unknown[],
  graph: readonly WorkspaceNode[],
  options: SelectChecksOptions = {},
): SelectionPlan {
  let full = options.full === true;
  const selected = new Set<string>(["security", "validate"]);
  const rootChecks = new Set<string>(ROOT_CHECKS);
  const workspaces = new Set<string>();
  const reasons: string[] = [];
  let mode: SelectionPlan["mode"] = "focused";
  const broaden = (reason: string): void => {
    full = true;
    reasons.push(reason);
  };
  const python = (): void => {
    for (const job of PYTHON_CONSUMERS) selected.add(job);
  };
  if (!files.length) broaden("No change paths: conservative full qualification.");
  for (const file of files) {
    if (typeof file !== "string" || !file || file.startsWith("/") || file.split("/").includes(".."))
      throw new Error("Changed paths must be repository-relative.");
    if (
      file === ".agents/README.md" ||
      file === ".agents/README.zh-CN.md" ||
      /^(?:(?:apps|packages|providers)\/[^/]+\/|tests\/oracles\/legacy-server\/)?AGENTS(?:\.[^/]+)?\.md$/.test(
        file,
      ) ||
      /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(file) ||
      /^docs\/prompts?\/[^/]+\.md$/.test(file) ||
      file === ".github/PULL_REQUEST_TEMPLATE.md"
    ) {
      reasons.push(`Contributor behavior: ${file}`);
      continue;
    }
    // Prose has explicit locations. Markdown below runtime/resource/generator roots is an input.
    // New executable skill helpers and unknown paths fail conservatively into the full lane.
    if (
      /^docs\/(?!prompts?\/).*\.md$/.test(file) ||
      /^[^/]+\.md$/.test(file) ||
      /^(?:apps|packages|providers|experiments|deploy)\/[^/]+\/(?:README(?:\.[^/]+)?|RESEARCH|THIRD_PARTY_NOTICES)\.md$/.test(
        file,
      )
    )
      continue;
    if (
      /(^|\/)(package(?:-lock)?\.json|pyproject\.toml|requirements[^/]*\.(?:lock|txt)|distribution\.lock|[^/]*config[^/]*|Dockerfile[^/]*)$/.test(
        file,
      ) ||
      file.startsWith(".github/") ||
      file.startsWith("scripts/") ||
      file.startsWith("packages/work-contract-generator/") ||
      /\/generated\//.test(file)
    ) {
      broaden(`Check, contract, lock or build input: ${file}`);
      continue;
    }
    if (file.startsWith("packages/harness/")) {
      python();
      continue;
    }
    if (file.startsWith("apps/server-python/")) {
      python();
      if (file === "apps/server-python/src/openbot_server/parser_worker.ts")
        rootChecks.add("typecheck:parsers");
      if (/work_(models|values|routes)|runtime_wire|input_models/.test(file))
        broaden(`Cross-language authority: ${file}`);
      continue;
    }
    if (file.startsWith("experiments/browser-execution/")) {
      rootChecks.add("test:browser:boundary");
      selected.add("browser-egress");
      selected.add("browser-product");
      continue;
    }
    if (
      file.startsWith("experiments/work-journey/") ||
      file.startsWith("experiments/linux-execution/")
    ) {
      // browser_a1 imports these sibling helpers and its boundary suite verifies their hashes.
      if (file.startsWith("experiments/linux-execution/")) rootChecks.add("test:browser:boundary");
      python();
      continue;
    }
    if (file.startsWith("experiments/s7-migration/")) {
      selected.add("synthetic-migration");
      continue;
    }
    if (file.startsWith("apps/worker-host-windows/")) {
      selected.add("windows-worker-host");
      selected.add("portable");
      continue;
    }
    if (file.startsWith("apps/worker-host-macos/")) {
      selected.add("portable");
      continue;
    }
    // These Web files participate in the actual Python HTTP → TypeScript qualification.
    if (
      /^apps\/web\/src\/(?:work-api(?:\.test)?|native-task-api(?:\.test)?|api)\.ts$/.test(file) ||
      file.startsWith("apps/web/conformance/")
    )
      selected.add("harness");
    const owner = graph.find((node) => file.startsWith(`${node.path}/`));
    if (!owner) {
      broaden(`Unmapped input: ${file}`);
      continue;
    }
    if (file.startsWith("tests/")) {
      broaden(`Test evidence input: ${file}`);
      continue;
    }
    workspaces.add(owner.name);
  }
  const affected = dependents(workspaces, graph);
  // Qualify consumers reached through the npm graph as well as the directly edited owner.
  for (const name of affected) {
    if (["@openbot/protocol", "@openbot/db", "@openbot/domain"].includes(name)) {
      python();
      selected.add("portable");
    } else if (name === "@openbot/node" || /provider|windows-secret/.test(name)) {
      selected.add("portable");
      selected.add("browser-product");
      selected.add("temporal-qualification");
    } else if (name === "@openbot/desktop" || name === "@openbot/python-node-runtime") {
      selected.add("portable");
      selected.add("python-desktop-preview");
      if (name === "@openbot/python-node-runtime") selected.add("python-product-container");
    } else if (name === "@openbot/employee-publisher") {
      selected.add("python-runtime");
    }
  }
  if (affected.length) mode = "workspace";
  if (full) {
    mode = "full";
    for (const job of JOBS) selected.add(job);
  }
  return {
    version: 1,
    mode,
    workspaces: affected,
    rootChecks: [...rootChecks],
    required: JOBS.filter((job) => selected.has(job)),
    notApplicable: JOBS.filter((job) => !selected.has(job)),
    reasons,
  };
}
