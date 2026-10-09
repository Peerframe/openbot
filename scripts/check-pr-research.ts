import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The PR research section is required only for the decisions AGENTS.md routes to recorded
// evidence: dependencies, public protocols, security and persistence. Everything else is exempt
// without ceremony. This is a reminder for authors, not semantic approval; review still traces
// every changed file.

export interface PullRequestChange {
  path: string;
  status: "added" | "modified" | "deleted";
  /** Committed content, read only for files whose trigger depends on it. */
  before?: string;
  after?: string;
}

const sourceLabel = "Source copied or substantially adapted";
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"];
const dependencyFile =
  /^(?:package-lock\.json|npm-shrinkwrap\.json|.+\.lock|requirements[^/]*\.(?:txt|in)|pyproject\.toml)$/u;
const containerFile = /^(?:Dockerfile|Containerfile)(?:\.[\w-]+)?$|\.Dockerfile$/u;
const contractPath =
  /^packages\/protocol\/|^packages\/db\/migrations\/|\.(?:sql|proto|graphql|entitlements)$|\.schema\.json$/u;
const testPath =
  /(?:^|\/)(?:tests?|__tests__)\/|(?:^|\/)test_[^/]+\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const evidenceLink =
  /(?:^|[\s(<[])(?:docs\/(?:research|decisions)\/[^\s)>\]]+\.md|docs\/OPEN_SOURCE_REUSE\.md|[\w./-]*RESEARCH\.md|https:\/\/github\.com\/Peerframe\/openbot\/(?:pull|issues)\/\d+)/u;

/** Returns why a change needs the research section, or undefined when it is exempt. */
export function researchTrigger(change: PullRequestChange): string | undefined {
  // Removing code or dependencies never adopts a new upstream, protocol or data boundary.
  if (change.status === "deleted") return undefined;
  const name = change.path.split("/").at(-1) ?? "";
  if (name === "package.json") {
    try {
      const before = manifestDependencies(change.before);
      const after = manifestDependencies(change.after);
      return before === after ? undefined : "package.json dependencies changed";
    } catch {
      return "package.json could not be parsed";
    }
  }
  if (dependencyFile.test(name)) return "dependency or lock file changed";
  if (containerFile.test(name)) {
    return baseImages(change.before) === baseImages(change.after)
      ? undefined
      : "container base image changed";
  }
  if (!testPath.test(change.path) && contractPath.test(change.path))
    return "public protocol, security or persistence contract changed";
  return undefined;
}

function manifestDependencies(source: string | undefined): string {
  const manifest = source ? JSON.parse(source) : {};
  return JSON.stringify(dependencyFields.map((field) => manifest?.[field] ?? null));
}

function baseImages(source: string | undefined): string {
  return JSON.stringify((source ?? "").match(/^\s*FROM\s+.+$/gimu) ?? []);
}

export function validatePullRequestResearch(body: string): string[] {
  const section = extractSection(body.replace(/<!--[\s\S]*?-->/gu, ""), "Open-source research");
  if (section === undefined) return ["add a '## Open-source research' section to the PR body"];

  const failures: string[] = [];
  if (!evidenceLink.test(section)) {
    failures.push(
      "link a research record, ADR or prior PR, e.g. docs/research/<topic>.md, " +
        "docs/decisions/<number>-<title>.md or https://github.com/Peerframe/openbot/pull/<number>",
    );
  }
  const source = section.match(
    new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${sourceLabel}:[ \\t]*(.*?)[ \\t]*$`, "imu"),
  );
  if (!source) {
    failures.push(`add the line '- ${sourceLabel}: no' (or 'yes' with the notice location)`);
  } else if (!/^(?:yes|no)\b(?!\s*\/)/iu.test(source[1] ?? "")) {
    failures.push(`'${sourceLabel}:' must start with yes or no, found '${source[1] ?? ""}'`);
  }
  return failures;
}

interface PullRequestEvent {
  pull_request?: { base?: { sha?: string }; head?: { sha?: string }; body?: unknown };
}

export function readPullRequestChanges(
  event: PullRequestEvent,
  { cwd = process.cwd() } = {},
): PullRequestChange[] {
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha))) {
    throw new Error("The pull-request event has no valid base and head commits.");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    // Compare the PR branch since its merge base, not unrelated additions on the target branch.
    const mergeBase = git(["merge-base", `${base}`, `${head}`]).trim();
    const fields = git([
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      mergeBase,
      `${head}`,
      "--",
    ]).split("\0");
    fields.pop();
    const changes: PullRequestChange[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const letter = fields[index]?.[0];
      const path = fields[index + 1] ?? "";
      const status = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
      const change: PullRequestChange = { path, status };
      // Read committed blobs, never the working tree, and only where content decides the trigger.
      const name = path.split("/").at(-1) ?? "";
      if (status !== "deleted" && (name === "package.json" || containerFile.test(name))) {
        if (status === "modified") change.before = git(["show", `${mergeBase}:${path}`]);
        change.after = git(["show", `${head}:${path}`]);
      }
      changes.push(change);
    }
    return changes;
  } catch {
    throw new Error(
      "Cannot list the pull-request changes. Check out full history (fetch-depth: 0).",
    );
  }
}

function extractSection(body: string, heading: string): string | undefined {
  const match = body.match(
    new RegExp(`(?:^|\\n)## ${heading}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, "iu"),
  );
  return match?.[1]?.trim();
}

function run(): void {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.info("Pull-request research check skipped outside a pull_request event.");
    return;
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required for pull_request validation.");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const body = typeof event.pull_request?.body === "string" ? event.pull_request.body : "";

  let triggers: string[];
  try {
    triggers = readPullRequestChanges(event).flatMap((change) => {
      const reason = researchTrigger(change);
      return reason ? [`${change.path}: ${reason}`] : [];
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cannot list the pull-request changes.");
    process.exitCode = 1;
    return;
  }
  if (triggers.length === 0) {
    console.info("No dependency, protocol, security or persistence change; research not required.");
    return;
  }
  const failures = validatePullRequestResearch(body);
  if (failures.length > 0) {
    const shown = triggers.slice(0, 10);
    if (triggers.length > shown.length) shown.push(`...and ${triggers.length - shown.length} more`);
    console.error(
      [
        "This PR needs an '## Open-source research' section because:",
        ...shown.map((trigger) => `  ${trigger}`),
        "Fix the PR body:",
        ...failures.map((failure) => `- ${failure}`),
        "Example:",
        "  ## Open-source research",
        "  - Evidence: docs/research/<topic>.md",
        `  - ${sourceLabel}: no`,
        "See CONTRIBUTING.md#research-evidence-and-documentation-exemptions.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  console.info("Pull-request research section is present.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
