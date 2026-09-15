import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const requiredFields = [
  "Research artifact",
  "Selected upstream/standard",
  "Version or commit",
  "License",
  "Decision",
  "OpenBot-specific gap",
  "Source copied or substantially adapted",
];

const placeholderPattern = /^(?:-|n\/?a|none|not sure|tbd|todo|<.*>|\.\.\.|no\s*\/\s*yes.*)$/iu;
const exemptionCategories = new Set(["spelling", "translation", "mechanical-formatting"]);
const maximumEvidenceBytes = 1024 * 1024;
const maximumChangedFiles = 100;

export function validatePullRequestResearch(body, changes) {
  const section = extractSection(body.replace(/<!--[\s\S]*?-->/gu, ""), "Open-source research");
  if (section === undefined) return ["missing the 'Open-source research' section"];

  const exemption = extractListField(section, "Research exemption");
  if (exemption !== undefined) return validateExemption(section, exemption, changes);

  const failures = [];
  for (const label of requiredFields) {
    const value = extractListField(section, label);
    if (value === undefined) {
      failures.push(`missing '- ${label}:'`);
      continue;
    }
    if (placeholderPattern.test(value)) failures.push(`'${label}' still contains a placeholder`);
  }
  return failures;
}

function validateExemption(section, exemption, changes) {
  const failures = [];
  if (!exemptionCategories.has(exemption)) {
    failures.push("'Research exemption' must be spelling, translation, or mechanical-formatting");
  }
  const reason = extractListField(section, "Exemption reason");
  if (!reason || placeholderPattern.test(reason)) {
    failures.push("explain the specific correction and why behavior and claims are unchanged");
  }
  if (requiredFields.some((label) => extractListField(section, label) !== undefined)) {
    failures.push("choose either the exemption fields or the seven research fields, not both");
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    failures.push("an exemption requires the actual committed pull-request changes");
    return failures;
  }
  if (changes.length > maximumChangedFiles) {
    failures.push(
      "automatic exemption is limited to 100 changed files; use existing research evidence",
    );
    return failures;
  }
  for (const change of changes) {
    if (!isOrdinaryDocumentation(change)) {
      failures.push(
        "automatic exemption only covers ordinary Markdown documentation, not code or policy",
      );
      break;
    }
    const before = protectedMarkdownContent(change.before);
    const after = protectedMarkdownContent(change.after);
    if (before === undefined || after === undefined || before !== after) {
      failures.push(
        "commands, code blocks, link destinations, markup, or metadata changed; use research evidence",
      );
      break;
    }
  }
  return failures;
}

function isOrdinaryDocumentation(change) {
  if (
    typeof change.path !== "string" ||
    [...change.path].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "\\",
    )
  )
    return false;
  if (change.path.split("/").some((part) => part === "." || part === "..")) return false;
  const allowedPath =
    /^(?:README(?:\.[\w-]+)?\.md|docs\/.+\.md|(?:apps|packages|providers)\/[^/]+\/README(?:\.[\w-]+)?\.md)$/u;
  const policyPath =
    /(?:^|\/)(?:AGENTS|CLAUDE|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|LICENSE|TEMPLATE|OPEN_SOURCE_REUSE)(?:\.[\w-]+)?\.md$/u;
  return (
    allowedPath.test(change.path) &&
    !policyPath.test(change.path) &&
    !/^docs\/(?:decisions|research)\//u.test(change.path) &&
    ["000000", "100644"].includes(change.beforeMode) &&
    ["000000", "100644"].includes(change.afterMode) &&
    typeof change.before === "string" &&
    typeof change.after === "string" &&
    !change.before.includes("\0") &&
    !change.after.includes("\0")
  );
}

function protectedMarkdownContent(source) {
  // This conservatively protects technical content; prose semantics remain a normal review concern.
  const tokens = [];
  const prose = [];
  let fence;
  let metadata = false;
  for (const [index, line] of source.replace(/\r\n/gu, "\n").split("\n").entries()) {
    if (index === 0 && line === "---") metadata = true;
    if (metadata) {
      tokens.push(line);
      if (index > 0 && line === "---") metadata = false;
      continue;
    }
    const marker = line.match(/(`{3,}|~{3,})/u)?.[1];
    if (fence) {
      tokens.push(line);
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (marker) {
      fence = marker;
      tokens.push(line);
    } else if (/^(?: {4}|\t)/u.test(line) || /^ {0,3}\[[^\]]+\]:/u.test(line)) {
      tokens.push(line);
    } else {
      prose.push(line);
    }
  }
  if (fence || metadata) return undefined;
  const sourceText = prose.join("\n");
  const textParts = [];
  let previousEnd = 0;
  const inline = /`+/gu;
  for (let match = inline.exec(sourceText); match !== null; match = inline.exec(sourceText)) {
    const end = new RegExp(`(?<!\x60)${match[0]}(?!\x60)`, "gu");
    end.lastIndex = inline.lastIndex;
    const closing = end.exec(sourceText);
    if (closing === null) return undefined;
    tokens.push(sourceText.slice(match.index, end.lastIndex));
    textParts.push(sourceText.slice(previousEnd, match.index), " ");
    previousEnd = end.lastIndex;
    inline.lastIndex = end.lastIndex;
  }
  textParts.push(sourceText.slice(previousEnd));
  const text = textParts.join("");
  for (const block of text.matchAll(
    /<(script|style|pre|textarea|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
  ))
    tokens.push(block[0]);
  for (const markup of text.matchAll(/<!--[\s\S]*?-->|<[^>]*>/gu)) tokens.push(markup[0]);
  for (const url of text.matchAll(/(?:https?:\/\/|mailto:)[^\s<>()]+/gu)) tokens.push(url[0]);
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    const labelEnd = closingDelimiter(text, start, "[", "]");
    if (labelEnd === undefined) return undefined;
    const kind = text[start - 1] === "!" ? "image" : "link";
    if (text[labelEnd + 1] === "(") {
      const end = closingDelimiter(text, labelEnd + 1, "(", ")");
      if (end === undefined) return undefined;
      tokens.push(kind, text.slice(labelEnd + 2, end));
      start = end;
    } else if (text[labelEnd + 1] === "[") {
      const end = closingDelimiter(text, labelEnd + 1, "[", "]");
      if (end === undefined) return undefined;
      tokens.push(kind, text.slice(labelEnd + 2, end) || text.slice(start + 1, labelEnd));
      start = end;
    } else {
      // Shortcut references can change destinations even when their definitions are untouched.
      tokens.push(kind, text.slice(start + 1, labelEnd));
      start = labelEnd;
    }
  }
  return JSON.stringify(tokens);
}

function closingDelimiter(text, start, open, close) {
  let depth = 1;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === open) depth += 1;
    else if (text[index] === close && --depth === 0) return index;
  }
  return undefined;
}

export function readPullRequestChanges(event, { cwd = process.cwd() } = {}) {
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha))) {
    throw new Error("Exemption evidence requires valid pull-request base and head commits.");
  }
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: maximumEvidenceBytes,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    // Compare the PR branch since its merge base, not unrelated additions on the target branch.
    const raw = git([
      "diff",
      "--raw",
      "--no-abbrev",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      `${base}...${head}`,
      "--",
    ]);
    const fields = raw.split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0 || fields.length / 2 > maximumChangedFiles) {
      throw new Error("Unsupported change inventory.");
    }
    const changes = [];
    for (let index = 0; index < fields.length; index += 2) {
      const header = fields[index].match(
        /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [AMDT][0-9]*$/u,
      );
      if (!header) throw new Error("Unsupported change record.");
      const [, beforeMode, afterMode, beforeId, afterId] = header;
      const change = { path: fields[index + 1], beforeMode, afterMode, before: "", after: "" };
      // Read immutable blobs only for candidate documents, never arbitrary working-tree paths.
      if (isOrdinaryDocumentation(change)) {
        change.before = beforeMode === "000000" ? "" : git(["cat-file", "blob", beforeId]);
        change.after = afterMode === "000000" ? "" : git(["cat-file", "blob", afterId]);
      }
      changes.push(change);
    }
    return changes;
  } catch {
    throw new Error(
      "Cannot verify exemption changes. Fetch complete PR history or use research evidence.",
    );
  }
}

function extractSection(body, heading) {
  const escaped = escapeRegExp(heading);
  const match = body.match(
    new RegExp(`(?:^|\\n)## ${escaped}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, "iu"),
  );
  return match?.[1]?.trim();
}

function extractListField(section, label) {
  const escaped = escapeRegExp(label);
  const match = section.match(new RegExp(`^- ${escaped}:[ \\t]*(.*?)[ \\t]*$`, "imu"));
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function run() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.info("Pull-request research check skipped outside a pull_request event.");
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required for pull_request validation.");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const body = event.pull_request?.body;
  if (typeof body !== "string") throw new Error("Pull request body is missing.");

  const section = extractSection(body.replace(/<!--[\s\S]*?-->/gu, ""), "Open-source research");
  let changes;
  if (section && extractListField(section, "Research exemption") !== undefined) {
    try {
      changes = readPullRequestChanges(event);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
  }
  const failures = validatePullRequestResearch(body, changes);
  if (failures.length > 0) {
    console.error(
      [
        "Pull-request research check failed:",
        ...failures.map((failure) => `- ${failure}`),
        "Use the research fields or the bounded documentation exemption described in CONTRIBUTING.md.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  console.info("Pull-request research evidence or bounded documentation exemption is present.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
