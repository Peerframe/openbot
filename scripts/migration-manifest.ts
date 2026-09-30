/** Validated journal fields shared by read-only checks, planning and lineage consumers. */
export interface MigrationJournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
  readonly [key: string]: unknown;
}
export interface MigrationJournal {
  readonly entries: readonly MigrationJournalEntry[];
  readonly [key: string]: unknown;
}
const migrationTag = /^\d{4}_[a-z0-9_]+$/;

export function validateMigrationManifest(
  journal: unknown,
  sqlFileNames: readonly string[],
): asserts journal is MigrationJournal {
  const candidate: unknown =
    journal !== null && typeof journal === "object" && "entries" in journal
      ? journal.entries
      : undefined;
  if (!Array.isArray(candidate))
    throw new Error("Migration journal must contain an entries array.");
  const entries: readonly unknown[] = candidate;
  const expectedFiles: string[] = [];
  const seenTags = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const [position, entry] of entries.entries()) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`Migration journal entry ${position} must be an object.`);
    }
    const idx: unknown = "idx" in entry ? entry.idx : undefined;
    if (idx !== position) {
      throw new Error(`Migration journal index ${idx} is out of sequence at position ${position}.`);
    }
    const when: unknown = "when" in entry ? entry.when : undefined;
    if (typeof when !== "number" || !Number.isSafeInteger(when) || when <= previousTimestamp) {
      throw new Error(
        `Migration journal timestamp is not strictly increasing at index ${position}.`,
      );
    }
    const tag: unknown = "tag" in entry ? entry.tag : undefined;
    if (typeof tag !== "string" || !migrationTag.test(tag)) {
      throw new Error(`Migration journal tag is invalid at index ${position}.`);
    }
    const numericPrefix = Number(tag.slice(0, 4));
    if (numericPrefix !== position)
      throw new Error(`Migration filename prefix does not match index ${position}.`);
    if (seenTags.has(tag)) throw new Error(`Duplicate migration tag: ${tag}.`);
    seenTags.add(tag);
    expectedFiles.push(`${tag}.sql`);
    previousTimestamp = when;
  }
  const actualFiles = sqlFileNames.filter((name) => name.endsWith(".sql")).sort();
  expectedFiles.sort();
  const missing = expectedFiles.filter((name) => !actualFiles.includes(name));
  const untracked = actualFiles.filter((name) => !expectedFiles.includes(name));
  if (missing.length > 0)
    throw new Error(`Migration files missing from disk: ${missing.join(", ")}.`);
  if (untracked.length > 0)
    throw new Error(`SQL files missing from the migration journal: ${untracked.join(", ")}.`);
}
