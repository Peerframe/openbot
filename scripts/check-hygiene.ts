// Repository hygiene guards (docs/research/repository-hygiene-guards.md). They turn the October 2026
// cleanup into checks, so docs that nothing uses, dated plans, stale paths, untracked translations
// and undocumented files are refused when they are added instead of being found months later.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Chinese translations kept on purpose (AGENTS.md, "Working rules"). */
export const TRANSLATED = [
  /^README\.zh-CN\.md$/u,
  /^AGENTS\.zh-CN\.md$/u,
  /^CONTRIBUTING\.zh-CN\.md$/u,
  /^THIRD_PARTY_NOTICES\.zh-CN\.md$/u,
  /^\.agents\/README\.zh-CN\.md$/u,
  /^docs\/(?:CROSS_PLATFORM|DESKTOP_INSTALLATION|DESKTOP_ONBOARDING|NODE_ENROLLMENT|PLUGINS|WINDOWS_DESKTOP)\.zh-CN\.md$/u,
  /^docs\/design\/.+\.zh-CN\.md$/u,
  // Packaging hashes or copies these notices.
  /^licenses\/.+\.zh-CN\.md$/u,
];

/** Plans, status reports and handoffs belong in PRs and issues, where they can close. */
const DATED_DOC = /(?:PLAN|ROADMAP|STATUS|WORKLOG|HANDOFF|CLEANUP|TODO)[^/]*\.md$/u;

export const NESTED_RULES_MAX_LINES = 60;

/** Paths written in backticks in living docs must exist. ADRs and research records are dated evidence. */
const PATH_ROOTS = "apps|packages|providers|plugins|scripts|docs|experiments|tests|deploy";
const GENERATED = new Set([
  "dist",
  "dist-demo",
  "out",
  "build",
  "node_modules",
  ".venv",
  ".worker-venv",
]);
const BACKTICK_PATH = new RegExp(`\`((?:${PATH_ROOTS})/[A-Za-z0-9_.@/-]+)\``, "gu");

export interface HygieneBaseline {
  /** Nested AGENTS.md files allowed above the budget, at most at their recorded length. */
  readonly nestedRules: Readonly<Record<string, number>>;
  /** Per area, the number of source files that do not open with a comment saying what they are. */
  readonly undocumentedFiles: Readonly<Record<string, number>>;
}

/** Source areas whose files should open with a comment that says what the file is for. */
export const DOCUMENTED_AREAS: Readonly<Record<string, RegExp>> = {
  "apps/web": /^apps\/web\/src\/.+\.tsx?$/u,
  "apps/server-ts": /^apps\/server-ts\/src\/.+\.ts$/u,
  "apps/desktop": /^apps\/desktop\/src\/.+\.ts$/u,
  packages: /^packages\/[^/]+\/src\/.+\.tsx?$/u,
  scripts: /^scripts\/[^/]+\.ts$/u,
};

export interface HygieneInput {
  readonly files: readonly string[];
  read(path: string): string;
  exists(path: string): boolean;
  /** Generated or local-only paths (build output, virtualenvs, runtime data) that git ignores. */
  ignored(path: string): boolean;
  readonly baseline: HygieneBaseline;
}

function isSourceFile(path: string): boolean {
  return !/\.(?:test|spec)\.tsx?$|\.d\.ts$|\/test\//u.test(path);
}

/** A file is documented when its first non-blank line is a comment. */
export function opensWithComment(source: string): boolean {
  const first = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#!"));
  return first !== undefined && (first.startsWith("//") || first.startsWith("/*"));
}

export function checkHygiene(input: HygieneInput): string[] {
  const failures: string[] = [];
  const { files, read, exists, ignored, baseline } = input;
  const markdown = files.filter((file) => file.endsWith(".md"));

  // 1. Translations only where the rule keeps them.
  for (const file of markdown.filter((path) => path.endsWith(".zh-CN.md")))
    if (!TRANSLATED.some((pattern) => pattern.test(file)))
      failures.push(
        `${file}: Chinese translations are kept only for the user-facing set in AGENTS.md; write the English doc only`,
      );

  // 2. No dated plans or status logs among the living docs.
  for (const file of markdown)
    if (/^docs\/[^/]+\.md$/u.test(file) && DATED_DOC.test(basename(file)))
      failures.push(
        `${file}: plans, status reports and handoffs go in a PR or issue, not a permanent doc`,
      );

  // 3. Every research record is load-bearing: something other than an index links or names it.
  const indexes = new Set([
    "docs/OPEN_SOURCE_REUSE.md",
    "docs/research/README.md",
    "docs/research/TEMPLATE.md",
  ]);
  const records = files.filter(
    (file) => /^docs\/research\/[^/]+\.md$/u.test(file) && !indexes.has(file),
  );
  const referrers = files.filter(
    (file) =>
      !indexes.has(file) &&
      !file.startsWith("docs/research/") &&
      /\.(?:md|ts|tsx|js|mjs|py|json|ya?ml|sh|toml|txt|c)$/u.test(file),
  );
  const corpus = referrers.map((file) => read(file)).join("\n");
  for (const record of records) {
    const name = basename(record, ".md");
    if (!corpus.includes(name))
      failures.push(
        `${record}: no ADR, code, README or doc refers to this research record; link it from the decision it supports or delete it`,
      );
  }

  // 4. Living docs name only paths that exist, from the root, the doc's folder or its package.
  // Python control and its harness leave whole in P5, so their docs are not chased path by path.
  const living = markdown.filter(
    (file) =>
      !/^(?:docs\/decisions|docs\/research|apps\/server-python|packages\/harness)\//u.test(file),
  );
  for (const file of living) {
    const folder = dirname(file);
    const workspace = file.split("/").slice(0, 2).join("/");
    for (const match of read(file).matchAll(BACKTICK_PATH)) {
      const path = (match[1] ?? "").replace(/[.:]+$/u, "");
      // Build output and local environments are named in docs but never committed.
      if (path.split("/").some((segment) => GENERATED.has(segment))) continue;
      const candidates = [path, join(folder, path), join(workspace, path)];
      if (!candidates.some((candidate) => exists(candidate) || ignored(candidate)))
        failures.push(`${file}: \`${path}\` does not exist; update or remove the reference`);
    }
  }

  // 5. Nested rules stay short; detail lives in READMEs. Recorded exceptions may only shrink.
  for (const file of files.filter((path) => /\/AGENTS\.md$/u.test(path))) {
    const lines = read(file).trimEnd().split("\n").length;
    const allowed = baseline.nestedRules[file] ?? NESTED_RULES_MAX_LINES;
    if (lines > allowed)
      failures.push(
        `${file}: ${lines} lines exceeds ${allowed}; keep local rules short and move detail into the README`,
      );
    else if (allowed > NESTED_RULES_MAX_LINES && lines < allowed)
      failures.push(
        `${file}: now ${lines} lines; lower its entry in scripts/hygiene-baseline.json to ${Math.max(lines, NESTED_RULES_MAX_LINES)}`,
      );
  }

  // 6. Experiments must still be run by something, or they are deleted.
  const experiments = [
    ...new Set(
      files
        .filter((file) => file.startsWith("experiments/"))
        .map((file) => file.split("/")[1] ?? ""),
    ),
  ];
  const runners = files.filter(
    (file) =>
      !file.startsWith("experiments/") &&
      !file.startsWith("docs/") &&
      !file.endsWith(".md") &&
      /\.(?:ts|mjs|js|py|json|ya?ml|sh|txt|toml)$/u.test(file),
  );
  const runnerText = runners.map((file) => read(file)).join("\n");
  const experimentText = files
    .filter((file) => file.startsWith("experiments/") && !file.endsWith(".md"))
    .map((file) => ({ file, text: read(file) }));
  for (const name of experiments) {
    const used =
      runnerText.includes(`experiments/${name}`) ||
      experimentText.some(
        ({ file, text }) => !file.startsWith(`experiments/${name}/`) && text.includes(`../${name}`),
      );
    if (!used)
      failures.push(
        `experiments/${name}: nothing in code, scripts, package.json or CI runs it; delete it (history keeps it)`,
      );
  }

  // 7. Files say what they are for. Existing gaps are recorded per area and may only shrink.
  for (const [area, pattern] of Object.entries(DOCUMENTED_AREAS)) {
    const missing = files.filter(
      (file) => pattern.test(file) && isSourceFile(file) && !opensWithComment(read(file)),
    );
    const allowed = baseline.undocumentedFiles[area] ?? 0;
    if (missing.length > allowed)
      failures.push(
        `${area}: ${missing.length} source files lack an opening comment (allowed ${allowed}). Start each new file with a comment saying what it is for. Newest gaps: ${missing.slice(-3).join(", ")}`,
      );
    else if (missing.length < allowed)
      failures.push(
        `${area}: only ${missing.length} files lack an opening comment now; lower undocumentedFiles["${area}"] in scripts/hygiene-baseline.json to ${missing.length}`,
      );
  }

  return failures;
}

export function repositoryInput(root: string): HygieneInput {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.length > 0 && existsSync(join(root, file)));
  const cache = new Map<string, string>();
  return {
    files,
    read(path) {
      let text = cache.get(path);
      if (text === undefined) {
        text = readFileSync(join(root, path), "utf8");
        cache.set(path, text);
      }
      return text;
    },
    exists: (path) => existsSync(join(root, path)),
    ignored(path) {
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: root });
        return true;
      } catch {
        return false;
      }
    },
    baseline: JSON.parse(
      readFileSync(join(root, "scripts/hygiene-baseline.json"), "utf8"),
    ) as HygieneBaseline,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = checkHygiene(repositoryInput(root));
  if (failures.length > 0) {
    console.error(
      ["Repository hygiene checks failed:", ...failures.map((f) => `- ${f}`)].join("\n"),
    );
    process.exitCode = 1;
  } else console.log("Repository hygiene checks passed.");
}
