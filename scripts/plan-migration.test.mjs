import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { planMigration } from "./plan-migration.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = join(root, "scripts/plan-migration.mjs");
const journal = {
  version: "7",
  dialect: "postgresql",
  entries: [{ idx: 0, version: "7", when: 2000, tag: "0000_foundation", breakpoints: true }],
};

test("plans the next unique number and monotonic timestamp without inferring SQL", () => {
  const before = structuredClone(journal);
  const plan = planMigration(journal, ["0000_foundation.sql"], "add_field", 1000);
  assert.equal(plan.file, "packages/db/migrations/0001_add_field.sql");
  assert.equal(plan.journalEntry.when, 2001);
  assert.equal(
    planMigration(journal, ["0000_foundation.sql"], "add_field", 3000).journalEntry.when,
    3000,
  );
  assert.ok(
    plan.sqlTemplate
      .trim()
      .split("\n")
      .every((line) => line.startsWith("--")),
  );
  assert.deepEqual(journal, before);
});

test("rejects invalid names, ambiguous history and out-of-range timestamps", () => {
  for (const name of ["../escape", "", "Add_field", "a;DROP TABLE bots", "x".repeat(65)]) {
    assert.throws(() => planMigration(journal, ["0000_foundation.sql"], name));
  }
  assert.throws(() => planMigration(journal, [], "missing"), /missing from disk/u);
  assert.throws(
    () => planMigration(journal, ["0000_foundation.sql", "0001_other.sql"], "conflict"),
    /missing from the migration journal/u,
  );
  assert.throws(() => planMigration(journal, ["0000_foundation.sql"], "bad_time", Infinity));
  assert.throws(() => planMigration({ ...journal, dialect: "sqlite" }, [], "wrong_format"));
});

async function snapshot(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    const path = join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await snapshot(path)
      : createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
  }
  return result;
}

test("legacy generate fails before any migration writes; plan only prints a template", async () => {
  const directory = join(root, "packages/db/migrations");
  const before = await snapshot(directory);
  const manifest = JSON.parse(await readFile(join(root, "packages/db/package.json"), "utf8"));
  assert.equal(
    manifest.scripts.generate,
    "node ../../scripts/plan-migration.mjs --reject-generate",
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [command, "--reject-generate", "--custom"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) =>
      error.status === 1 &&
      error.stderr.includes("OPENBOT_MIGRATION_GENERATE_DISABLED") &&
      error.stderr.includes("docs/DATABASE.md"),
  );
  const output = JSON.parse(
    execFileSync(process.execPath, [command, "--name", "review_only"], { encoding: "utf8" }),
  );
  assert.match(output.file, /review_only\.sql$/u);
  assert.ok(output.sqlTemplate.startsWith("--"));
  assert.deepEqual(await snapshot(directory), before);
});
