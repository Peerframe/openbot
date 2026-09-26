import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { validateMigrationManifest } from "./check-migrations.mjs";

const subtree = "packages/db/migrations/";
const journalPath = `${subtree}meta/_journal.json`;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function git(repository, args) {
  // Read object bytes only. Filters, hooks and a partial clone's lazy network fetch are unnecessary.
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && !["GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH"].includes(key)) {
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

export function readCommittedMigrationHistory(repository, commit) {
  if (typeof repository !== "string" || repository.length === 0 || !objectId.test(commit)) {
    throw new Error("Supply a local repository and a full lowercase commit object ID.");
  }
  if (git(repository, ["cat-file", "-t", commit]).toString("utf8").trim() !== "commit") {
    throw new Error("Migration reference must identify a commit, not a tree, tag or blob.");
  }
  const tree = git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", subtree]);
  const entries = new Map();
  for (const line of tree.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t(.+)$/u.exec(line);
    if (!match || !objectId.test(match[3])) throw new Error("Invalid Git migration tree entry.");
    entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  function readBlob(path) {
    const entry = entries.get(path);
    if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      throw new Error(`Migration source is missing or is not a regular committed file: ${path}.`);
    }
    return git(repository, ["cat-file", "blob", entry.oid]);
  }
  const journal = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readBlob(journalPath)),
  );
  if (journal.version !== "7" || journal.dialect !== "postgresql") {
    throw new Error("Expected the reviewed version-7 PostgreSQL migration journal.");
  }
  const sqlFiles = [...entries.keys()]
    .filter((path) => path.startsWith(subtree) && !path.slice(subtree.length).includes("/"))
    .map((path) => path.slice(subtree.length));
  validateMigrationManifest(journal, sqlFiles);
  if (journal.entries.length === 0 || journal.entries.length > 1000) {
    throw new Error("Expected between 1 and 1000 migration entries.");
  }
  const migrations = journal.entries.map((entry) => {
    if (entry.version !== "7" || entry.breakpoints !== true) {
      throw new Error(`Unsupported migration metadata at index ${entry.idx}.`);
    }
    const bytes = readBlob(`${subtree}${entry.tag}.sql`);
    const sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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

export function compareMigrationHistories(source, target) {
  let commonPrefixLength = 0;
  while (commonPrefixLength < Math.min(source.migrations.length, target.migrations.length)) {
    const from = source.migrations[commonPrefixLength];
    const to = target.migrations[commonPrefixLength];
    if (from.tag !== to.tag || from.timestamp !== to.timestamp || from.sha256 !== to.sha256) break;
    commonPrefixLength += 1;
  }
  const sourceComplete = commonPrefixLength === source.migrations.length;
  const targetComplete = commonPrefixLength === target.migrations.length;
  const classification = sourceComplete
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Migration lineage audit failed.");
    process.exitCode = 2;
  }
}
