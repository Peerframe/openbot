import { isDeepStrictEqual } from "node:util";

// A conservative shortcut for repairs within an already reviewed contract, not semantic approval.
const placeholder = /^(?:-|n\/?a|none|not sure|tbd|todo|<.*>|\.\.\.)$/iu;
export interface ResearchChange {
  path: string;
  beforeMode: string;
  afterMode: string;
  before: string;
  after: string;
}

export const reuseFields = ["Research reuse", "Reuse scope", "Unchanged assumptions"];

// Read immutable content before classifying it. Never use a placeholder blob to decide eligibility.
export function researchTextChange(change: ResearchChange): boolean {
  if (typeof change.path !== "string" || !/^[\w./-]+$/u.test(change.path)) return false;
  if (change.path.split("/").some((part) => part === "." || part === "..")) return false;
  return (
    [change.beforeMode, change.afterMode].every((mode) =>
      ["000000", "100644", "100755"].includes(mode),
    ) &&
    !(change.beforeMode === "000000" && change.afterMode === "000000") &&
    (change.beforeMode === change.afterMode ||
      (["000000", "100644"].includes(change.beforeMode) &&
        ["000000", "100644"].includes(change.afterMode)))
  );
}

export function researchReviewReason(change: ResearchChange): string | undefined {
  if (!researchTextChange(change)) return "unsupported path, file type or executable-mode change";
  if (
    ![change.before, change.after].every(
      (value) => typeof value === "string" && !value.includes("\0"),
    )
  )
    return "missing or binary committed content";
  const name = change.path.split("/").at(-1) ?? "";
  if (name === "package.json") {
    try {
      // Script wiring/prose may reuse a design; all other package metadata remains protected.
      const contract = (source: string) => {
        const value: unknown = JSON.parse(source);
        if (!value || Array.isArray(value) || typeof value !== "object")
          throw new Error("manifest");
        const {
          scripts,
          description: _description,
          keywords: _keywords,
          ...rest
        } = value as Record<string, unknown>;
        if (
          scripts !== undefined &&
          (!scripts || Array.isArray(scripts) || typeof scripts !== "object")
        )
          throw new Error("manifest scripts");
        const scriptMap = scripts as Record<string, unknown> | undefined;
        const lifecycle = Object.fromEntries(
          [
            "preinstall",
            "install",
            "postinstall",
            "prepare",
            "prepublish",
            "prepublishOnly",
            "prepack",
            "postpack",
            "publish",
            "postpublish",
            "preuninstall",
            "uninstall",
            "postuninstall",
          ].map((key) => [key, scriptMap?.[key]]),
        );
        return [rest, lifecycle];
      };
      return isDeepStrictEqual(contract(change.before), contract(change.after))
        ? undefined
        : "dependency, runtime or public package contract changed";
    } catch {
      return "new, removed or unreadable package manifest";
    }
  }
  if (
    /^(?:.*\.lock(?:\.json)?|package-lock\.json|npm-shrinkwrap\.json|requirements[^/]*\.(?:txt|in)|pyproject\.toml|Cargo\.toml|go\.(?:mod|sum)|.*\.csproj|Package\.(?:swift|resolved))$/u.test(
      name,
    )
  )
    return "dependency or runtime specification changed";
  if (/\.(?:sql|proto|graphql|gql)$|\.schema\.json$/u.test(name))
    return "persistence or public schema artifact changed";
  if (/\.(?:entitlements|mobileconfig)$|^(?:CODEOWNERS|SECURITY(?:\.[\w-]+)?\.md)$/u.test(name))
    return "security or review-authority artifact changed";
  if (
    /^(?:AGENTS|CLAUDE|SKILL)(?:\.[\w-]+)?\.md$/u.test(name) ||
    /(?:^|\/)(?:skills|prompts)(?:\/|\.)/u.test(change.path)
  )
    return "instructions or prompts changed";
  if (
    /^\.github\/workflows\//u.test(change.path) ||
    /^scripts\/(?:check-(?:research|pr-research|docs|security|.*workflow)|workflow-policy)/u.test(
      change.path,
    )
  )
    return "CI or review policy changed";
  // These are known owners, not a classifier of arbitrary program semantics. Review must still
  // trace consumers and require targeted evidence for a new boundary hidden in any other file.
  const test = /(?:^|\/)test_[^/]+\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(change.path);
  if (
    !test &&
    (/^packages\/(?:protocol|domain|db|policy)\//u.test(change.path) ||
      /(?:^|[/_.-])(?:auth(?:ority|orization)?|approvals?|budgets?|permissions?|credentials?|secrets?|sandbox|security|guard|store|contracts?|recovery|polic(?:y|ies)|identity|leases?|revok(?:e|ation)|cancel(?:lation)?)(?:[/_.-]|$)/iu.test(
        change.path,
      ))
  )
    return "authority, persistence, recovery or public-contract owner changed";
  return undefined;
}

export function validateResearchReuse(
  fields: Record<string, string | undefined>,
  changes?: ResearchChange[],
): string[] {
  const failures: string[] = [];
  for (const name of reuseFields) {
    const value = fields[name];
    if (!value || placeholder.test(value))
      failures.push(`complete '- ${name}:' for the existing decision`);
  }
  const reference = fields["Research reuse"] ?? "";
  if (
    !/^(?:(?:docs\/(?:research|decisions)\/[\w/-]+\.md|docs\/OPEN_SOURCE_REUSE\.md|(?:apps|packages|providers)\/[\w-]+\/RESEARCH\.md)(?:#[\w-]+)?|https:\/\/github\.com\/Peerframe\/openbot\/(?:issues|pull)\/\d+(?:#[\w-]+)?)$/u.test(
      reference,
    )
  )
    failures.push("'Research reuse' must link an existing repository decision or OpenBot issue/PR");
  if (fields["Source copied or substantially adapted"] !== "no")
    failures.push(
      "the reuse shortcut requires no copied/adapted source; otherwise use the full evidence form",
    );
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
    failures.push("research reuse requires 1–100 actual committed pull-request changes");
  } else {
    for (const change of changes) {
      const reason = researchReviewReason(change);
      if (reason)
        failures.push(
          `${change.path}: ${reason}; use targeted evidence in the full form (existing decisions may be cited)`,
        );
    }
  }
  return failures;
}
