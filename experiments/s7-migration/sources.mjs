import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareMigrationHistories } from "../../scripts/compare-migration-lineage.mjs";
import { validateMigrationManifest } from "../../scripts/check-migrations.mjs";

export const root = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(root, "../..");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export function journalFor(history) {
  return {
    version: "7",
    dialect: "postgresql",
    entries: history.migrations.map(({ index, tag, timestamp }) => ({
      idx: index,
      version: "7",
      when: timestamp,
      tag,
      breakpoints: true,
    })),
  };
}

export async function verifySources() {
  const histories = {};
  for (const label of ["feature", "architecture", "target"]) {
    const history = await readJson(join(root, `${label}-history.json`));
    assert.match(history.commit, /^[a-f0-9]{40}$/);
    validateMigrationManifest(
      journalFor(history),
      history.migrations.map(({ tag }) => `${tag}.sql`),
    );
    for (const entry of history.migrations) {
      const path =
        label === "target"
          ? join(repository, "packages/db/migrations", `${entry.tag}.sql`)
          : join(root, "histories", entry.index < 17 ? "common" : label, `${entry.tag}.sql`);
      assert.equal(sha256(await readFile(path)), entry.sha256, `${label}: ${entry.tag} changed`);
    }
    histories[label] = history;
  }
  const baseline = await readJson(join(repository, "docs/migration-lineage-baseline.json"));
  assert.deepEqual(compareMigrationHistories(histories.feature, histories.architecture), baseline);
  const targetJournal = await readJson(
    join(repository, "packages/db/migrations/meta/_journal.json"),
  );
  assert.deepEqual(
    targetJournal,
    journalFor(histories.target),
    "Target changed; requalify the pin",
  );
  for (const label of ["common", "feature", "architecture"]) {
    const history = histories[label === "common" ? "feature" : label];
    const expected = history.migrations
      .filter(({ index }) => (label === "common" ? index < 17 : index >= 17))
      .map(({ tag }) => `${tag}.sql`)
      .sort();
    assert.deepEqual((await readdir(join(root, "histories", label))).sort(), expected);
  }
  return histories;
}

export async function materializeHistory(label, history, destination) {
  await mkdir(join(destination, "meta"), { recursive: true });
  await writeFile(join(destination, "meta/_journal.json"), JSON.stringify(journalFor(history)));
  for (const entry of history.migrations) {
    const bytes = await readFile(
      join(root, "histories", entry.index < 17 ? "common" : label, `${entry.tag}.sql`),
    );
    assert.equal(sha256(bytes), entry.sha256);
    await writeFile(join(destination, `${entry.tag}.sql`), bytes);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifySources();
  console.info("S7 source snapshots, baseline and target pin verified.");
}
