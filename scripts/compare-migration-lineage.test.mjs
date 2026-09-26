import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareMigrationHistories,
  readCommittedMigrationHistory,
} from "./compare-migration-lineage.mjs";

const command = fileURLToPath(new URL("./compare-migration-lineage.mjs", import.meta.url));
function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "openbot-lineage-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Lineage fixture");
  git("config", "user.email", "fixture@example.invalid");
  const directory = join(repo, "packages/db/migrations");
  mkdirSync(join(directory, "meta"), { recursive: true });
  const entries = [];
  function append(tag, sql) {
    entries.push({
      idx: entries.length,
      version: "7",
      when: 1000 + entries.length,
      tag,
      breakpoints: true,
    });
    writeFileSync(join(directory, `${tag}.sql`), sql);
    writeFileSync(
      join(directory, "meta/_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries }),
    );
  }
  function commit() {
    git("add", "packages");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  }
  append("0000_base", "\ufeffCREATE TABLE preserved (name text);\r\n");
  return { repo, git, directory, append, commit, base: commit() };
}

function run(repo, source, target) {
  return spawnSync(
    process.execPath,
    [
      command,
      "--source-repo",
      repo,
      "--source-ref",
      source,
      "--target-repo",
      repo,
      "--target-ref",
      target,
    ],
    { encoding: "utf8" },
  );
}

test("real committed prefix passes; reverse direction fails; dirty and staged files are ignored", (t) => {
  const f = fixture(t);
  f.append("0001_add", "ALTER TABLE preserved ADD COLUMN count integer;\n");
  const next = f.commit();
  writeFileSync(join(f.directory, "0000_base.sql"), "UNCOMMITTED PRIVATE CONTENT");
  writeFileSync(join(f.directory, "0099_untracked.sql"), "PRIVATE");
  writeFileSync(join(f.directory, "meta/_journal.json"), "malformed staged journal");
  f.git("add", "packages/db/migrations/meta/_journal.json");
  const before = f.git("status", "--porcelain");
  const good = run(f.repo, f.base, next);
  assert.equal(good.status, 0, good.stderr);
  const report = JSON.parse(good.stdout);
  assert.equal(report.classification, "source_prefix");
  assert.equal(report.commonPrefixLength, 1);
  assert.equal(report.target.count, 2);
  assert.doesNotMatch(good.stdout, /PRIVATE/);
  const reverse = run(f.repo, next, f.base);
  assert.equal(reverse.status, 1);
  assert.equal(JSON.parse(reverse.stdout).classification, "target_prefix");
  assert.equal(f.git("status", "--porcelain"), before);
});

test("changed SQL at the same timestamp cannot masquerade as compatible history", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, "0000_base.sql"), "CREATE TABLE different (name text);\n");
  const other = f.commit();
  const result = run(f.repo, f.base, other);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, "diverged");
  assert.equal(report.commonPrefixLength, 0);
  assert.equal(report.firstDifference.source.timestamp, report.firstDifference.target.timestamp);
  assert.notEqual(report.firstDifference.source.sha256, report.firstDifference.target.sha256);
});

test("identical history matches Drizzle's installed SQL hash convention", async (t) => {
  const f = fixture(t);
  const { readMigrationFiles } = await import("drizzle-orm/migrator");
  const history = readCommittedMigrationHistory(f.repo, f.base);
  assert.equal(
    history.migrations[0].sha256,
    readMigrationFiles({ migrationsFolder: f.directory })[0].hash,
  );
  assert.equal(compareMigrationHistories(history, history).classification, "identical");
  assert.equal(run(f.repo, f.base, f.base).status, 0);
});

test("rejects committed symlinks without following a private target", (t) => {
  const f = fixture(t);
  const sqlPath = join(f.directory, "0000_base.sql");
  rmSync(sqlPath);
  symlinkSync(join(f.repo, "private-secret"), sqlPath);
  writeFileSync(join(f.repo, "private-secret"), "PRIVATE");
  const bad = f.commit();
  const result = run(f.repo, f.base, bad);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a regular committed file/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/);
});

test("rejects malformed journals, unlisted committed SQL and non-commit references", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, "0001_unlisted.sql"), "SELECT 1;\n");
  const unlisted = f.commit();
  assert.throws(
    () => readCommittedMigrationHistory(f.repo, unlisted),
    /missing from the migration journal/,
  );
  writeFileSync(
    join(f.directory, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }),
  );
  const malformed = f.commit();
  assert.equal(run(f.repo, f.base, malformed).status, 2);
  assert.throws(() => readCommittedMigrationHistory(f.repo, "HEAD"), /full lowercase commit/);
  assert.throws(
    () => readCommittedMigrationHistory(f.repo, f.git("rev-parse", `${f.base}^{tree}`)),
    /not a tree/,
  );
});
