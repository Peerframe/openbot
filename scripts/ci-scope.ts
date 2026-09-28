/**
 * ci-scope.ts
 *
 * Git fixed-revision / changed-files / event input / makePlan / argumentsFor / CLI.
 * Pure selection lives in ci-selection.ts.
 */

import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { selectChecks, workspaceGraph, type SelectionPlan } from "./ci-selection.ts";

export type ChangedFilesInput = {
  readonly source: "local" | "commits" | "push" | "full";
  readonly head: string;
  readonly base?: string;
  readonly mergeBase?: string;
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
};

export type ScopeCliOptions = {
  readonly local?: boolean;
  readonly full?: boolean;
  readonly base?: string;
  readonly head?: string;
  readonly event?: string;
  readonly "github-output"?: string;
};

export type MakePlanArgs = {
  readonly local?: boolean;
  readonly full?: boolean;
  readonly base?: string;
  readonly head?: string;
  readonly event?: string;
};

export type CiPlan = SelectionPlan & {
  readonly input: ChangedFilesInput;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trimEnd();
}

function paths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function revision(root: string, sha: unknown): string {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
    throw new Error("An immutable 40-character commit is required.");
  if (git(root, ["rev-parse", "--verify", `${sha}^{commit}`]) !== sha)
    throw new Error("Commit identity mismatch.");
  return sha;
}

export function changedFiles(
  root: string,
  options: { readonly base?: string; readonly head?: string; readonly local?: boolean } = {},
): ChangedFilesInput {
  const { base, head, local = false } = options;
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
  const baseSha = revision(root, base);
  const headSha = revision(root, head);
  const mergeBase = git(root, ["merge-base", baseSha, headSha]);
  return {
    source: "commits",
    base: baseSha,
    head: headSha,
    mergeBase,
    tracked: paths(
      git(root, ["diff", "--name-only", "--no-renames", "-z", `${baseSha}...${headSha}`, "--"]),
    ),
    untracked: [],
  };
}

function pullRequestShas(event: unknown): { base: string; head: string } | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event))
    throw new Error("CI event must be a JSON object.");
  if (!Object.prototype.hasOwnProperty.call(event, "pull_request")) return undefined;
  const pullRequest = (event as Record<string, unknown>).pull_request;
  if (!isRecord(pullRequest))
    throw new Error("CI pull_request must be an object with base and head shas.");
  const base = pullRequest.base;
  const head = pullRequest.head;
  if (!isRecord(base) || !isRecord(head))
    throw new Error("CI pull_request must include base and head objects.");
  if (typeof base.sha !== "string" || typeof head.sha !== "string")
    throw new Error("CI pull_request base.sha and head.sha must be strings.");
  return { base: base.sha, head: head.sha };
}

export async function makePlan(root: string, args: MakePlanArgs): Promise<CiPlan> {
  let input: ChangedFilesInput;
  let full = args.full === true;
  if (args.event) {
    const event: unknown = JSON.parse(await readFile(args.event, "utf8"));
    const shas = pullRequestShas(event);
    if (shas)
      input = changedFiles(root, {
        base: shas.base,
        head: shas.head,
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
  const lock: unknown = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  const graph = workspaceGraph(lock);
  return { ...selectChecks([...input.tracked, ...input.untracked], graph, { full }), input };
}

export function argumentsFor(argv: readonly string[]): ScopeCliOptions {
  const options: {
    local?: boolean;
    full?: boolean;
    base?: string;
    head?: string;
    event?: string;
    "github-output"?: string;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local" || arg === "--full") options[arg.slice(2) as "local" | "full"] = true;
    else if (
      (arg === "--base" || arg === "--head" || arg === "--event" || arg === "--github-output") &&
      argv[i + 1]
    ) {
      const key = arg.slice(2) as "base" | "head" | "event" | "github-output";
      options[key] = argv[++i] as string;
    } else throw new Error(`Unsupported scope argument: ${arg}`);
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
  const githubOutput = args["github-output"];
  if (githubOutput) await appendFile(githubOutput, `plan=${serialized}\n`);
  console.log(serialized);
}
