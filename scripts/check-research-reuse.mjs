// A conservative shortcut for repairs within an already reviewed contract, not semantic approval.
const placeholder = /^(?:-|n\/?a|none|not sure|tbd|todo|<.*>|\.\.\.)$/iu;
export const reuseFields = ["Research reuse", "Reuse scope", "Unchanged assumptions"];

export function reusableChange(change) {
  if (typeof change.path !== "string" || !/^[\w./-]+$/u.test(change.path)) return false;
  if (change.path.split("/").some((part) => part === "." || part === "..")) return false;
  if (!["000000", "100644"].includes(change.beforeMode) || change.afterMode !== "100644")
    return false;
  // Tests do not grant authority. Product boundary owners, new source, import changes, manifests,
  // locks, build/config, prompts and instructions deliberately stay on the evidence form.
  const test =
    /^(?:apps|packages|providers)\/[\w-]+\/(?:tests\/.*\.py|src\/.*\.test\.[cm]?[jt]sx?)$/u;
  const presentation = /^apps\/web\/src\/components\/[\w/-]+\.(?:tsx|css)$/u;
  const core =
    /^packages\/harness\/src\/openbot_agent_runtime\/(?:bounds|catalog|errors)\.py$/u;
  if (
    !test.test(change.path) &&
    !(change.beforeMode === "100644" && (presentation.test(change.path) || core.test(change.path)))
  )
    return false;
  if (
    ![change.before, change.after].every((text) => typeof text === "string" && !text.includes("\0"))
  )
    return false;
  if (test.test(change.path)) return true;
  // This is intentionally conservative (including multiline/dynamic imports). It is not a parser
  // or a claim that permission changes can be inferred from text. Review still traces consumers.
  const imports = (source) =>
    source
      .split("\n")
      .filter((line) => /\b(?:import|from|require|__import__)\b/u.test(line))
      .join("\n");
  return imports(change.before) === imports(change.after);
}

export function validateResearchReuse(fields, changes) {
  const failures = [];
  for (const name of reuseFields) {
    const value = fields[name];
    if (!value || placeholder.test(value))
      failures.push(`complete '- ${name}:' for the existing decision`);
  }
  const reference = fields["Research reuse"] ?? "";
  if (
    !/^(?:(?:docs\/(?:research|decisions)\/[\w/-]+\.md|docs\/OPEN_SOURCE_REUSE\.md|(?:apps|packages)\/[\w-]+\/RESEARCH\.md)(?:#[\w-]+)?|https:\/\/github\.com\/Peerframe\/openbot\/(?:issues|pull)\/\d+(?:#[\w-]+)?)$/u.test(
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
  } else if (changes.some((change) => !reusableChange(change))) {
    failures.push(
      "reuse shortcut excludes boundary owners, imports, new product files, dependencies, instructions and unknown paths; use the full evidence form (existing decisions may still be cited)",
    );
  }
  return failures;
}
