import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TASKS = ["typecheck", "test", "build"];
const MAX_FILES = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
const FULL_REASONS = {
  authority:
    "Shared contracts, authority, persistence or native host changes require full validation.",
  config: "Dependency, build or tool configuration changes require full validation.",
  documentation:
    "Documentation changes may alter contracts or support claims; full validation remains required.",
  unknown: "At least one changed path has no reviewed focused classification.",
  failure: "Impact analysis was unavailable or incompatible; use full validation.",
  dirty: "The checkout contains uncommitted files; committed-range analysis is insufficient.",
  head: "The requested head differs from the checkout used for the workspace graph.",
};

function execute(cwd, executable, args, env = process.env) {
  return execFileSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: MAX_BYTES,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function safePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 500 &&
    /^[a-zA-Z0-9_./@+ -]+$/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function classifyPath(path) {
  if (!safePath(path)) return "unknown";
  if (/\.(md|mdx|rst|txt)$/i.test(path) || path.startsWith("docs/")) {
    return "documentation";
  }
  if (
    /(^|\/)(package(?:-lock)?\.json|[^/]*lock[^/]*|tsconfig[^/]*|turbo\.json|\.npmrc|[^/]*\.config\.[^/]+|Dockerfile[^/]*)$/i.test(
      path,
    ) ||
    /(^|\/)(scripts|\.github|deploy)\//.test(path)
  ) {
    return "config";
  }
  if (
    /^(apps\/(server|node|worker-host-[^/]+)|packages\/(domain|protocol|policy|db|config|provider-sdk|windows-secret-acl))\//.test(
      path,
    ) ||
    /(^|[/_.-])(auth(?:orization|entication)?|approval|credential|enrollment|permission|policy|routing|security|session|secret|sandbox|migration)s?([/_.-]|$)/i.test(
      path,
    )
  ) {
    return "authority";
  }
  if (
    /^(apps\/(web|desktop)|providers\/(coder|cua|docker|lume)|packages\/(logging|provider-conformance-runner|office-plugin))\/src\//.test(
      path,
    )
  ) {
    return null;
  }
  return "unknown";
}

// Consume only bounded identities from Turbo; raw commands and environment values are never reported.
export function parseDryRun(text, expectedVersion) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Oversized Turbo report");
  const result = JSON.parse(text);
  if (
    result.turboVersion !== expectedVersion ||
    !Array.isArray(result.packages) ||
    result.packages.length > 500 ||
    !Array.isArray(result.tasks) ||
    result.tasks.length > 5_000
  ) {
    throw new Error("Incompatible Turbo report");
  }
  const packages = new Set(result.packages);
  if (
    packages.size !== result.packages.length ||
    [...packages].some((name) => !/^@openbot\/[a-z0-9][a-z0-9-]{0,80}$/.test(name))
  ) {
    throw new Error("Invalid package identity");
  }
  const directories = new Map();
  const taskIds = new Set();
  for (const task of result.tasks) {
    if (
      !/^@openbot\/[a-z0-9][a-z0-9-]{0,80}$/.test(task.package) ||
      !TASKS.includes(task.task) ||
      task.taskId !== `${task.package}#${task.task}` ||
      taskIds.has(task.taskId) ||
      !safePath(task.directory) ||
      !/^(apps|packages|providers)\/[a-z0-9-]+$/.test(task.directory) ||
      (directories.has(task.package) && directories.get(task.package) !== task.directory)
    ) {
      throw new Error("Invalid task identity");
    }
    taskIds.add(task.taskId);
    directories.set(task.package, task.directory);
  }
  if (
    [...packages].some((name) => !directories.has(name)) ||
    directories.size > 500 ||
    new Set(directories.values()).size !== directories.size
  ) {
    throw new Error("Incomplete workspace identities");
  }
  return [...directories]
    .map(([name, directory]) => ({ name, directory }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fullReport(reason, details = {}) {
  return {
    version: 1,
    mode: "shadow",
    scope: "full",
    reasons: [FULL_REASONS[reason]],
    changedFileCount: null,
    packages: [],
    commands: ["npm run check"],
    ...details,
  };
}

export function classifyImpact({ paths, allPackages, affectedPackages }) {
  if (!Array.isArray(paths) || paths.length > MAX_FILES || paths.some((path) => !safePath(path))) {
    return fullReport("failure");
  }
  const reasons = new Set(paths.map(classifyPath).filter(Boolean));
  const known = new Map(allPackages.map((item) => [item.name, item.directory]));
  if (
    affectedPackages.some((item) => known.get(item.name) !== item.directory) ||
    paths.some((path) => !allPackages.some((item) => path.startsWith(`${item.directory}/`)))
  ) {
    reasons.add("unknown");
  }
  if (paths.length === 0 && affectedPackages.length !== 0) reasons.add("failure");
  // A changed leaf omitted by Turbo cannot justify a narrow recommendation.
  if (
    paths.some((path) => !affectedPackages.some((item) => path.startsWith(`${item.directory}/`)))
  ) {
    reasons.add("failure");
  }
  if (reasons.size > 0) {
    return fullReport("failure", {
      reasons: [...reasons].map((reason) => FULL_REASONS[reason]),
      changedFileCount: paths.length,
      packages: allPackages,
    });
  }
  return {
    version: 1,
    mode: "shadow",
    scope: paths.length === 0 ? "unchanged" : "focused",
    reasons: [],
    changedFileCount: paths.length,
    packages: affectedPackages,
    commands:
      paths.length === 0
        ? ["npm run check"]
        : [
            "npm run lint",
            `npm exec -- turbo run typecheck test build ${affectedPackages.map((item) => `--filter=${item.name}`).join(" ")} --concurrency=2`,
          ],
  };
}

export function eventBase(eventName, event) {
  const base =
    eventName === "pull_request"
      ? event.pull_request?.base?.sha
      : eventName === "push"
        ? event.before
        : undefined;
  if (
    typeof base !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base) ||
    /^0+$/.test(base)
  ) {
    throw new Error("Missing comparison base");
  }
  return base;
}

export function analyzeImpact({
  cwd = process.cwd(),
  base = "origin/main",
  head = "HEAD",
  turboPath = resolve(cwd, "node_modules/turbo/bin/turbo"),
} = {}) {
  try {
    const git = (...args) => execute(cwd, "git", args);
    const commit = (ref) => {
      if (typeof ref !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./~^-]{0,199}$/.test(ref))
        throw new Error("Invalid ref");
      const value = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Invalid commit");
      return value;
    };
    const baseCommit = commit(base);
    const headCommit = commit(head);
    const details = { base: baseCommit, head: headCommit };
    if (headCommit !== commit("HEAD")) return fullReport("head", details);
    if (git("status", "--porcelain=v1", "-z", "--untracked-files=all") !== "")
      return fullReport("dirty", details);
    const mergeBase = git("merge-base", baseCommit, headCommit).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeBase)) throw new Error("Missing merge base");
    const changed = git("diff", "--name-only", "--no-renames", "-z", mergeBase, headCommit, "--");
    if (changed && !changed.endsWith("\0")) throw new Error("Incomplete Git paths");
    const paths = changed === "" ? [] : changed.slice(0, -1).split("\0");
    const expectedVersion = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"))
      .devDependencies?.turbo;
    if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error("Turbo must be pinned");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("TURBO_")),
    );
    Object.assign(env, {
      TURBO_TELEMETRY_DISABLED: "1",
      TURBO_NO_UPDATE_NOTIFIER: "1",
      TURBO_SCM_BASE: mergeBase,
      TURBO_SCM_HEAD: headCommit,
    });
    const dryRun = (affected) =>
      parseDryRun(
        execute(
          cwd,
          process.execPath,
          [
            turboPath,
            "run",
            ...TASKS,
            "--dry=json",
            "--cache=local:r",
            "--no-daemon",
            ...(affected ? ["--affected"] : []),
          ],
          env,
        ),
        expectedVersion,
      );
    const allPackages = dryRun(false);
    const affectedPackages = dryRun(true);
    return { ...classifyImpact({ paths, allPackages, affectedPackages }), ...details, mergeBase };
  } catch {
    // Do not leak raw subprocess output, paths, event bodies, commands or environment values.
    return fullReport("failure");
  }
}

export function renderSummary(report) {
  return [
    "## CI impact report (shadow mode)",
    "",
    "All existing CI gates still run. These commands are advisory local feedback, not permission to omit required checks.",
    "",
    `Suggested scope: **${report.scope}**. Changed files: ${report.changedFileCount ?? "unknown"}.`,
    ...(report.base
      ? [`Comparison: \`${report.base}\` to checked-out \`${report.head}\` (merge base).`]
      : []),
    "",
    ...report.reasons.map((reason) => `- ${reason}`),
    "",
    "Workspace selection (including dependency builds):",
    "",
    ...(report.packages.length
      ? report.packages.map((item) => `- \`${item.name}\` — \`${item.directory}\``)
      : ["Not available or no changed workspaces; do not infer that checks can be skipped."]),
    "",
    "Suggested local commands after `npm ci`:",
    "",
    "```sh",
    ...report.commands,
    "```",
    "",
    "Required handoff remains `npm run check` plus the existing platform and integration CI gates.",
    "",
  ].join("\n");
}

function main() {
  let report;
  let json = false;
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--json") json = true;
      else if (args[i] === "--base" || args[i] === "--head") {
        const key = args[i].slice(2);
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error("Missing ref option");
        options[key] = value;
      } else throw new Error("Unknown option");
    }
    if (!options.base && process.env.GITHUB_EVENT_NAME) {
      const eventPath = process.env.GITHUB_EVENT_PATH;
      if (!eventPath || statSync(eventPath).size > 1024 * 1024) throw new Error("Invalid event");
      options.base = eventBase(
        process.env.GITHUB_EVENT_NAME,
        JSON.parse(readFileSync(eventPath, "utf8")),
      );
    }
    report = analyzeImpact(options);
  } catch {
    report = fullReport("failure");
  }
  const summary = renderSummary(report);
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This uncached report runs directly under Node, outside Turbo tasks.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, summary);
  console.info(json ? JSON.stringify(report, null, 2) : summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
