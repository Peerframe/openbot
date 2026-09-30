import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateMigrationManifest } from "./migration-manifest.ts";

const journal = {
  entries: [
    { idx: 0, when: 1000, tag: "0000_foundation", breakpoints: true },
    { idx: 1, when: 2000, tag: "0001_channels", breakpoints: true },
  ],
};

test("accepts an ordered journal with an exact SQL file set", () => {
  assert.doesNotThrow(() =>
    validateMigrationManifest(journal, ["0001_channels.sql", "0000_foundation.sql"]),
  );
});

test("rejects journal, timestamp, and filename drift", () => {
  assert.throws(
    () =>
      validateMigrationManifest({ entries: [journal.entries[1], journal.entries[0]] }, [
        "0000_foundation.sql",
        "0001_channels.sql",
      ]),
    /out of sequence/,
  );
  assert.throws(
    () =>
      validateMigrationManifest(
        {
          entries: [journal.entries[0], { ...journal.entries[1], when: 1000 }],
        },
        ["0000_foundation.sql", "0001_channels.sql"],
      ),
    /strictly increasing/,
  );
  assert.throws(
    () => validateMigrationManifest(journal, ["0000_foundation.sql"]),
    /missing from disk/,
  );
  assert.throws(
    () =>
      validateMigrationManifest(journal, [
        "0000_foundation.sql",
        "0001_channels.sql",
        "0002_untracked.sql",
      ]),
    /missing from the migration journal/,
  );
});

test("malformed JSON journals cannot enter the validated manifest contract", () => {
  for (const invalid of [
    null,
    undefined,
    true,
    1,
    [],
    {},
    { entries: null },
    { entries: [null] },
  ]) {
    assert.throws(() => validateMigrationManifest(invalid, ["0000_foundation.sql"]));
  }
  for (const when of [NaN, Infinity, 1.5, "1000"]) {
    assert.throws(
      () =>
        validateMigrationManifest({ entries: [{ idx: 0, when, tag: "0000_base" }] }, [
          "0000_base.sql",
        ]),
      /timestamp/,
    );
  }
});

test("importing the checker from a different same-name entry does not execute its CLI", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-check-import-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "check-migrations.ts");
  await writeFile(
    entry,
    `import ${JSON.stringify(new URL("./check-migrations.ts", import.meta.url).href)};\n`,
  );
  assert.equal(execFileSync(process.execPath, [entry], { encoding: "utf8" }), "");
});
