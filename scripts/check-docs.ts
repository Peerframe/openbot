import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateDeveloperEntrypoints } from "./check-developer-entrypoints.ts";
import { requiredResearchFields } from "./check-pr-research.ts";
import { reuseFields } from "./check-research-reuse.ts";

const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  ".venv",
  ".worker-venv",
  ".build-venv",
  ".quality-venv",
  ".pytest_cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "native-runtime",
  "out",
]);
export interface DocumentationResult {
  markdownFiles: string[];
  failures: string[];
}

// The CLI and fixtures use the same checks. The supplied root owns all links and policy reads.
export function validateDocumentation(repositoryRoot: string): DocumentationResult {
  const markdownFiles = collectMarkdownFiles(repositoryRoot);
  const failures: string[] = [];

  for (const file of markdownFiles) {
    const source = readFileSync(file, "utf8");
    validateLocalLinks(file, source);
  }

  validateResearchPolicy();
  failures.push(...validateDeveloperEntrypoints(repositoryRoot));

  for (const name of ["README.md", "README.zh-CN.md"]) {
    const file = resolve(repositoryRoot, name);
    const source = readFileSync(file, "utf8");
    if (/```mermaid\b/u.test(source)) {
      failures.push(
        `${name}: root READMEs must link to architecture docs instead of embedding Mermaid.`,
      );
    }
    const imageCount = Array.from(source.matchAll(/!\[[^\]]*\]\([^)]+\)/gu)).length;
    if (imageCount > 5) {
      failures.push(`${name}: contains ${imageCount} images; keep the root README lightweight.`);
    }
  }

  function collectMarkdownFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          files.push(...collectMarkdownFiles(resolve(directory, entry.name)));
        }
        continue;
      }
      if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        files.push(resolve(directory, entry.name));
      }
    }
    return files;
  }

  function validateLocalLinks(file: string, source: string): void {
    for (const match of source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const rawTarget = match[1];
      if (rawTarget === undefined || isExternalTarget(rawTarget)) continue;
      const pathPart = rawTarget.replace(/^<|>$/gu, "").split("#", 1)[0]?.split("?", 1)[0];
      if (!pathPart) continue;
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(pathPart);
      } catch {
        failures.push(`${relativePath(file)}: link has invalid percent encoding: ${rawTarget}`);
        continue;
      }
      const target = resolve(dirname(file), decodedPath);
      if (!existsSync(target)) {
        failures.push(`${relativePath(file)}: local link does not exist: ${rawTarget}`);
      }
    }
  }

  function isExternalTarget(target: string): boolean {
    return /^(?:https?:|mailto:|tel:|#)/u.test(target);
  }

  function relativePath(file: string): string {
    return file.slice(repositoryRoot.length + 1);
  }

  function validateResearchPolicy(): void {
    const contracts = [
      {
        name: ".github/pull_request_template.md",
        headings: [
          "## Open-source research",
          ...requiredResearchFields.map((field) => `- ${field}:`),
          ...reuseFields.map((field) => `- ${field}:`),
          "- Research exemption:",
          "- Exemption reason:",
        ],
      },
      {
        name: "AGENTS.md",
        headings: ["## Research before implementation", "## Product and security boundaries"],
      },
      {
        name: "docs/research/TEMPLATE.md",
        headings: [
          "## Search evidence",
          "## Candidate comparison",
          "## Reuse decision",
          "## Source incorporation",
          "## Verification plan",
        ],
      },
      {
        name: "docs/decisions/TEMPLATE.md",
        // ADR structure follows the decision; reviewers assess reasons, consequences and evidence.
        headings: [],
      },
    ];

    for (const contract of contracts) {
      const file = resolve(repositoryRoot, contract.name);
      if (!existsSync(file)) {
        failures.push(`${contract.name}: required research-policy file is missing.`);
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const heading of contract.headings) {
        if (!source.includes(heading)) failures.push(`${contract.name}: missing '${heading}'.`);
      }
    }

    const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    for (const action of ["actions/checkout", "actions/setup-node"]) {
      if (!new RegExp(`uses: ${action}@[0-9a-f]{40}(?:\\s|$)`, "u").test(workflow)) {
        failures.push(`.github/workflows/ci.yml: ${action} must be pinned to a full commit.`);
      }
    }
  }

  return { markdownFiles, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateDocumentation(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (result.failures.length > 0) {
    console.error(
      ["Documentation checks failed:", ...result.failures.map((failure) => `- ${failure}`)].join(
        "\n",
      ),
    );
    process.exitCode = 1;
  } else {
    console.info(`Documentation checks passed for ${result.markdownFiles.length} Markdown files.`);
  }
}
