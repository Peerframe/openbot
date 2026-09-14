import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMigrationManifest } from "./check-migrations.mjs";

const help = `OpenBot uses reviewed, hand-written SQL migrations.
Usage: npm run migration:plan --workspace @openbot/db -- --name describe_change
This prints a plan only: no files, schema changes, or database connections.
Add the reviewed SQL and journal entry together; never edit applied history or snapshots.
The proposed number is not reserved. Recalculate after rebasing concurrent migrations.
See docs/DATABASE.md#author-a-migration and run npm run migrations:check.
`;

export function planMigration(journal, sqlFiles, name, now = Date.now()) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(name)) {
    throw new Error("Use a lowercase migration name with letters, digits and underscores.");
  }
  if (journal?.version !== "7" || journal?.dialect !== "postgresql") {
    throw new Error("Unsupported migration journal. Review the migration format before planning.");
  }
  validateMigrationManifest(journal, sqlFiles);
  const idx = journal.entries.length;
  const when = Math.max(now, (journal.entries.at(-1)?.when ?? -1) + 1);
  if (idx > 9999 || !Number.isSafeInteger(when) || when < 0) {
    throw new Error("Migration number or timestamp is outside the supported range.");
  }
  const tag = `${String(idx).padStart(4, "0")}_${name}`;
  return {
    file: `packages/db/migrations/${tag}.sql`,
    sqlTemplate:
      "-- Describe the reviewed schema change, existing-data handling, and rollback boundary.\n" +
      "-- Write only required SQL; separate statements with the documented migration delimiter.\n" +
      "-- This is a planning template, not a migration ready to apply.\n",
    journalEntry: { idx, version: "7", when, tag, breakpoints: true },
  };
}

export async function migrationPlanCommand(args) {
  if (args[0] === "--reject-generate") {
    console.error("OPENBOT_MIGRATION_GENERATE_DISABLED: automatic DDL generation is disabled.");
    console.error(help);
    return 1;
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.info(help);
    return 0;
  }
  if (args.length !== 2 || args[0] !== "--name") {
    console.error(help);
    return 1;
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const directory = join(repositoryRoot, "packages/db/migrations");
  const journal = JSON.parse(await readFile(join(directory, "meta/_journal.json"), "utf8"));
  const plan = planMigration(journal, await readdir(directory), args[1]);
  console.info(JSON.stringify(plan, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrationPlanCommand(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : "Migration planning failed.");
      process.exitCode = 1;
    },
  );
}
