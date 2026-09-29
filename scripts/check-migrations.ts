import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateMigrationManifest } from "./migration-manifest.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(repositoryRoot, "packages/db/migrations");
const journalPath = join(migrationsDirectory, "meta/_journal.json");

export async function checkMigrationManifest(): Promise<number> {
  const [journalSource, directoryEntries] = await Promise.all([
    readFile(journalPath, "utf8"),
    readdir(migrationsDirectory, { withFileTypes: true }),
  ]);
  const journal: unknown = JSON.parse(journalSource);
  const sqlFiles = directoryEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  validateMigrationManifest(journal, sqlFiles);

  for (const fileName of sqlFiles.filter((name) => name.endsWith(".sql"))) {
    const contents = await readFile(join(migrationsDirectory, fileName), "utf8");
    if (contents.trim().length === 0) throw new Error(`Migration file is empty: ${fileName}.`);
  }
  return journal.entries.length;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkMigrationManifest()
    .then((count) => console.info(`Migration manifest check passed for ${count} files.`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
