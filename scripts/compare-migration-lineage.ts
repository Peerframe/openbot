import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { validateMigrationManifest } from "./migration-manifest.ts";

const subtree = "packages/db/migrations/";
const journalPath = `${subtree}meta/_journal.json`;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const preservedGitVariables: readonly string[] = ["GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH"];
const regularFileModes: readonly string[] = ["100644", "100755"];

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}
type GitTree = ReadonlyMap<string, GitTreeEntry>;

export interface MigrationHistoryEntry {
  readonly index: number;
  readonly tag: string;
  readonly timestamp: number;
  readonly sha256: string;
}
export interface MigrationHistory {
  readonly commit: string;
  readonly migrations: readonly MigrationHistoryEntry[];
}
export type MigrationLineageClassification =
  | "identical"
  | "source_prefix"
  | "target_prefix"
  | "diverged";
export interface MigrationLineageDifference {
  readonly index: number;
  readonly source: MigrationHistoryEntry | null;
  readonly target: MigrationHistoryEntry | null;
}
export interface MigrationLineageReport {
  readonly schemaVersion: 1;
  readonly classification: MigrationLineageClassification;
  readonly sourceHistoryIsTargetPrefix: boolean;
  readonly commonPrefixLength: number;
  readonly source: { readonly commit: string; readonly count: number };
  readonly target: { readonly commit: string; readonly count: number };
  readonly firstDifference: MigrationLineageDifference | null;
  readonly sourceSuffix: readonly MigrationHistoryEntry[];
  readonly targetSuffix: readonly MigrationHistoryEntry[];
  readonly limitation: string;
}

function git(repository: string, args: readonly string[]): Buffer {
  // Read object bytes only. Filters, hooks and a partial clone's lazy network fetch are unnecessary.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && !preservedGitVariables.includes(key)) {
      delete env[key];
    }
  }
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", resolve(repository), ...args], {
      env,
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "Cannot read bounded committed migration objects from the selected repository.",
    );
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function readMigrationTree(repository: string, commit: string): GitTree {
  const listing = git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", subtree]);
  const entries = new Map<string, GitTreeEntry>();
  for (const line of listing.toString("utf8").split("\0").filter(Boolean)) {
    const [, mode, type, oid, path] = /^(\d{6}) (\w+) ([a-f0-9]+)\t(.+)$/u.exec(line) ?? [];
    if (
      mode === undefined ||
      type === undefined ||
      oid === undefined ||
      path === undefined ||
      !objectId.test(oid)
    ) {
      throw new Error("Invalid Git migration tree entry.");
    }
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

function readRegularBlob(repository: string, tree: GitTree, path: string): Buffer {
  const entry = tree.get(path);
  if (entry?.type !== "blob" || !regularFileModes.includes(entry.mode)) {
    throw new Error(`Migration source is missing or is not a regular committed file: ${path}.`);
  }
  return git(repository, ["cat-file", "blob", entry.oid]);
}

function assertReviewedJournalFormat(journal: unknown): void {
  if (
    journal === null ||
    typeof journal !== "object" ||
    !("version" in journal) ||
    !("dialect" in journal) ||
    journal.version !== "7" ||
    journal.dialect !== "postgresql"
  ) {
    throw new Error("Expected the reviewed version-7 PostgreSQL migration journal.");
  }
}

export function readCommittedMigrationHistory(
  repository: unknown,
  commit: unknown,
): MigrationHistory {
  if (
    typeof repository !== "string" ||
    repository.length === 0 ||
    typeof commit !== "string" ||
    !objectId.test(commit)
  ) {
    throw new Error("Supply a local repository and a full lowercase commit object ID.");
  }
  if (git(repository, ["cat-file", "-t", commit]).toString("utf8").trim() !== "commit") {
    throw new Error("Migration reference must identify a commit, not a tree, tag or blob.");
  }
  const tree = readMigrationTree(repository, commit);
  const journalText = decodeUtf8(readRegularBlob(repository, tree, journalPath));
  let journal: unknown;
  try {
    journal = JSON.parse(journalText);
  } catch {
    // SyntaxError messages can echo source contents into CLI diagnostics.
    throw new Error("Invalid committed migration journal JSON.");
  }
  assertReviewedJournalFormat(journal);
  const sqlFiles = [...tree.keys()]
    .filter((path) => path.startsWith(subtree) && !path.slice(subtree.length).includes("/"))
    .map((path) => path.slice(subtree.length));
  validateMigrationManifest(journal, sqlFiles);
  if (journal.entries.length === 0 || journal.entries.length > 1000) {
    throw new Error("Expected between 1 and 1000 migration entries.");
  }
  const migrations = journal.entries.map((entry): MigrationHistoryEntry => {
    if (entry.version !== "7" || entry.breakpoints !== true) {
      throw new Error(`Unsupported migration metadata at index ${entry.idx}.`);
    }
    const bytes = readRegularBlob(repository, tree, `${subtree}${entry.tag}.sql`);
    const sql = decodeUtf8(bytes);
    if (sql.trim().length === 0) throw new Error(`Empty migration: ${entry.tag}.`);
    return {
      index: entry.idx,
      tag: entry.tag,
      timestamp: entry.when,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return { commit, migrations };
}

export function compareMigrationHistories(
  source: MigrationHistory,
  target: MigrationHistory,
): MigrationLineageReport {
  let commonPrefixLength = 0;
  while (commonPrefixLength < Math.min(source.migrations.length, target.migrations.length)) {
    const from = source.migrations[commonPrefixLength];
    const to = target.migrations[commonPrefixLength];
    if (from === undefined || to === undefined) throw new Error("Invalid migration history entry.");
    if (from.tag !== to.tag || from.timestamp !== to.timestamp || from.sha256 !== to.sha256) break;
    commonPrefixLength += 1;
  }
  const sourceComplete = commonPrefixLength === source.migrations.length;
  const targetComplete = commonPrefixLength === target.migrations.length;
  const classification: MigrationLineageClassification = sourceComplete
    ? targetComplete
      ? "identical"
      : "source_prefix"
    : targetComplete
      ? "target_prefix"
      : "diverged";
  return {
    schemaVersion: 1,
    classification,
    sourceHistoryIsTargetPrefix: sourceComplete,
    commonPrefixLength,
    source: { commit: source.commit, count: source.migrations.length },
    target: { commit: target.commit, count: target.migrations.length },
    firstDifference:
      classification === "identical"
        ? null
        : {
            index: commonPrefixLength,
            source: source.migrations[commonPrefixLength] ?? null,
            target: target.migrations[commonPrefixLength] ?? null,
          },
    sourceSuffix: source.migrations.slice(commonPrefixLength),
    targetSuffix: target.migrations.slice(commonPrefixLength),
    limitation:
      "Committed source history only; no database, assets, credentials or upgrade executed or certified.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "source-repo": { type: "string" },
        "source-ref": { type: "string" },
        "target-repo": { type: "string" },
        "target-ref": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (Object.values(values).length !== 4) {
      throw new Error(
        "Required: --source-repo --source-ref --target-repo --target-ref (full commit IDs).",
      );
    }
    const source = readCommittedMigrationHistory(values["source-repo"], values["source-ref"]);
    const target = readCommittedMigrationHistory(values["target-repo"], values["target-ref"]);
    const report = compareMigrationHistories(source, target);
    console.info(JSON.stringify(report, null, 2));
    process.exitCode = report.sourceHistoryIsTargetPrefix ? 0 : 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "Migration lineage audit failed.");
    process.exitCode = 2;
  }
}
