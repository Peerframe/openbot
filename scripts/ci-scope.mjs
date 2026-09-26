import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This is a check selection policy, not a second workspace graph or a release qualification.
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
];
const PYTHON_CONSUMERS = [
  "harness",
  "python-runtime",
  "temporal-qualification",
  "browser-product",
  "python-product-container",
  "python-desktop-preview",
  "synthetic-migration",
];
const ROOT_CHECKS = [
  "oracle:check",
  "docs:check",
  "research:check",
  "security:config-check",
  "ci:check",
];

export function workspaceGraph(lock) {
  const nodes = Object.entries(lock.packages ?? {}).filter(
    ([path, item]) => path && !path.includes("node_modules") && item.name?.startsWith("@openbot/"),
  );
  if (!nodes.length) throw new Error("No existing npm workspace graph found.");
  return nodes.map(([path, item]) => ({
    path,
    name: item.name,
    dependencies: Object.keys({
      ...item.dependencies,
      ...item.devDependencies,
      ...item.optionalDependencies,
    }),
  }));
}

function dependents(names, graph) {
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

export function selectChecks(files, graph, { full = false } = {}) {
  const selected = new Set(["security", "validate"]);
  const rootChecks = new Set(ROOT_CHECKS);
  const workspaces = new Set();
  const reasons = [];
  let mode = "focused";
  const broaden = (reason) => {
    full = true;
    reasons.push(reason);
  };
  const python = () => {
    for (const job of PYTHON_CONSUMERS) selected.add(job);
  };
  if (!files.length) broaden("No change paths: conservative full qualification.");
  for (const file of files) {
    if (typeof file !== "string" || !file || file.startsWith("/") || file.split("/").includes(".."))
      throw new Error("Changed paths must be repository-relative.");
    if (
      /(^|\/)AGENTS(?:\.[^/]+)?\.md$/.test(file) ||
      file.startsWith(".agents/") ||
      /(^|\/)prompts?\//.test(file) ||
      file === ".github/PULL_REQUEST_TEMPLATE.md"
    ) {
      reasons.push(`Contributor behavior: ${file}`);
      continue;
    }
    if (/\.md$/.test(file) && !file.startsWith(".github/")) continue;
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
      /^apps\/web\/src\/(?:work-api(?:\.test)?|api)\.ts$/.test(file) ||
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

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trimEnd();
}
function paths(output) {
  return output.split("\0").filter(Boolean);
}
function revision(root, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? ""))
    throw new Error("An immutable 40-character commit is required.");
  if (git(root, ["rev-parse", "--verify", `${sha}^{commit}`]) !== sha)
    throw new Error("Commit identity mismatch.");
  return sha;
}
export function changedFiles(root, { base, head, local = false } = {}) {
  if (local && (base || head))
    throw new Error("Local working changes and committed PR ranges are separate inputs.");
  if (local) {
    return {
      source: "local",
      head: git(root, ["rev-parse", "HEAD"]),
      tracked: paths(git(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"])),
      untracked: paths(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
    };
  }
  revision(root, base);
  revision(root, head);
  const mergeBase = git(root, ["merge-base", base, head]);
  return {
    source: "commits",
    base,
    head,
    mergeBase,
    tracked: paths(
      git(root, ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"]),
    ),
    untracked: [],
  };
}

export async function makePlan(root, args) {
  let input;
  let full = args.full;
  if (args.event) {
    const event = JSON.parse(await readFile(args.event, "utf8"));
    if (event.pull_request)
      input = changedFiles(root, {
        base: event.pull_request.base.sha,
        head: event.pull_request.head.sha,
      });
    else {
      full = true;
      input = {
        source: "push",
        head: git(root, ["rev-parse", "HEAD"]),
        tracked: [],
        untracked: [],
      };
    }
  } else if (full)
    input = { source: "full", head: git(root, ["rev-parse", "HEAD"]), tracked: [], untracked: [] };
  else input = changedFiles(root, args);
  const graph = workspaceGraph(
    JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8")),
  );
  return { ...selectChecks([...input.tracked, ...input.untracked], graph, { full }), input };
}

export function argumentsFor(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--local", "--full"].includes(arg)) options[arg.slice(2)] = true;
    else if (["--base", "--head", "--event", "--github-output"].includes(arg) && argv[i + 1])
      options[arg.slice(2)] = argv[++i];
    else throw new Error(`Unsupported scope argument: ${arg}`);
  }
  const sources =
    Number(Boolean(options.local)) +
    Number(Boolean(options.full)) +
    Number(Boolean(options.event)) +
    Number(Boolean(options.base || options.head));
  if (sources !== 1)
    throw new Error("Choose --local, --base SHA --head SHA, --event FILE, or --full.");
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = argumentsFor(process.argv.slice(2));
  const plan = await makePlan(process.cwd(), args);
  const serialized = JSON.stringify(plan);
  if (args["github-output"]) await appendFile(args["github-output"], `plan=${serialized}\n`);
  console.log(serialized);
}
