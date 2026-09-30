import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareMigrationHistories,
  type MigrationHistory,
  type MigrationHistoryEntry,
} from "../../scripts/compare-migration-lineage.ts";
import { validateMigrationManifest } from "../../scripts/migration-manifest.ts";

export const root = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(root, "../..");
/** Snapshot entries below this index are shared by both lineages under histories/common. */
const FIRST_DIVERGENT_INDEX = 17;

export type HistoryLabel = "feature" | "architecture" | "target";
/** Lineages materialized from checked-in snapshots; the target is read from the working tree. */
export type SnapshotLabel = Exclude<HistoryLabel, "target">;
type DirectoryLabel = "common" | SnapshotLabel;

/** A checked-in history, kept as parsed so reports hash its exact JSON order. */
export interface S7History extends MigrationHistory {
  readonly commitRole?: string;
  readonly qualificationInput?: unknown;
}
export type S7Histories = { readonly [label in HistoryLabel]: S7History };

export interface S7JournalEntry {
  readonly idx: number;
  readonly version: "7";
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: true;
}
export interface S7Journal {
  readonly version: "7";
  readonly dialect: "postgresql";
  readonly entries: readonly S7JournalEntry[];
}

type HashInput = Parameters<ReturnType<typeof createHash>["update"]>[0];
export const sha256 = (bytes: HashInput): string =>
  createHash("sha256").update(bytes).digest("hex");
export const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHistoryEntry(value: unknown): value is MigrationHistoryEntry {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.index) &&
    typeof value.tag === "string" &&
    Number.isSafeInteger(value.timestamp) &&
    typeof value.sha256 === "string"
  );
}

// Narrow in place rather than rebuild: qualify.mjs digests `history.migrations` as parsed.
function isHistory(value: unknown): value is S7History {
  if (!isRecord(value)) return false;
  const { commit, commitRole, migrations } = value;
  if (typeof commit !== "string") return false;
  if (commitRole !== undefined && typeof commitRole !== "string") return false;
  if (!Array.isArray(migrations)) return false;
  const entries: readonly unknown[] = migrations;
  return entries.every(isHistoryEntry);
}

export function journalFor(history: MigrationHistory): S7Journal {
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

function snapshotPath(label: SnapshotLabel, entry: MigrationHistoryEntry): string {
  const directory: DirectoryLabel = entry.index < FIRST_DIVERGENT_INDEX ? "common" : label;
  return join(root, "histories", directory, `${entry.tag}.sql`);
}

function pinnedPath(label: HistoryLabel, entry: MigrationHistoryEntry): string {
  return label === "target"
    ? join(repository, "packages/db/migrations", `${entry.tag}.sql`)
    : snapshotPath(label, entry);
}

/** Read one pinned history and prove every referenced SQL file still has its recorded bytes. */
async function loadHistory(label: HistoryLabel): Promise<S7History> {
  const history = await readJson(join(root, `${label}-history.json`));
  assert(isHistory(history), `${label}: invalid history snapshot`);
  assert.match(history.commit, /^[a-f0-9]{40}$/);
  validateMigrationManifest(
    journalFor(history),
    history.migrations.map(({ tag }) => `${tag}.sql`),
  );
  for (const entry of history.migrations) {
    const path = pinnedPath(label, entry);
    assert.equal(sha256(await readFile(path)), entry.sha256, `${label}: ${entry.tag} changed`);
  }
  return history;
}

export async function verifySources(): Promise<S7Histories> {
  const histories: S7Histories = {
    feature: await loadHistory("feature"),
    architecture: await loadHistory("architecture"),
    target: await loadHistory("target"),
  };
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
  const directories: readonly DirectoryLabel[] = ["common", "feature", "architecture"];
  for (const directory of directories) {
    const history = histories[directory === "common" ? "feature" : directory];
    const expected = history.migrations
      .filter(({ index }) =>
        directory === "common" ? index < FIRST_DIVERGENT_INDEX : index >= FIRST_DIVERGENT_INDEX,
      )
      .map(({ tag }) => `${tag}.sql`)
      .sort();
    assert.deepEqual((await readdir(join(root, "histories", directory))).sort(), expected);
  }
  return histories;
}

/** Copy one snapshot lineage into a caller-owned directory; sources are only read. */
export async function materializeHistory(
  label: SnapshotLabel,
  history: MigrationHistory,
  destination: string,
): Promise<void> {
  await mkdir(join(destination, "meta"), { recursive: true });
  await writeFile(join(destination, "meta/_journal.json"), JSON.stringify(journalFor(history)));
  for (const entry of history.migrations) {
    const bytes = await readFile(snapshotPath(label, entry));
    assert.equal(sha256(bytes), entry.sha256);
    await writeFile(join(destination, `${entry.tag}.sql`), bytes);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifySources();
  console.info("S7 source snapshots, baseline and target pin verified.");
}
