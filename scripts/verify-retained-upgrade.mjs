import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = join(root, "packages/db/migrations");
export const fixtureFolder = join(root, "scripts/fixtures/retained-upgrade");
const tables = [
  "channels",
  "bots",
  "channel_bots",
  "nodes",
  "messages",
  "runs",
  "artifacts",
  "approvals",
  "run_events",
  "employee_evolution_events",
  "skills",
  "employee_skills",
  "employee_memories",
  "employee_import_receipts",
  "automations",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validateUpgradeTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    /* Use a bounded error without connection details. */
  }
  assert(
    target &&
      ["postgres:", "postgresql:"].includes(target.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
      /^\/openbot_upgrade_test_[a-z0-9_]+$/.test(target.pathname) &&
      !target.search &&
      !target.hash,
    "Set OPENBOT_UPGRADE_TEST_DATABASE_URL to an empty loopback PostgreSQL database named openbot_upgrade_test_* without URL parameters. No suite is skipped.",
  );
  return target.href;
}

export function validateFixture(manifest, journal, sources, seed) {
  assert(
    manifest?.version === 1 && Array.isArray(manifest.migrations),
    "Unsupported upgrade fixture manifest.",
  );
  assert(
    manifest.migrations.length > 0 && manifest.migrations.length < journal.entries.length,
    "Upgrade fixture must describe a non-empty historical prefix with pending migrations.",
  );
  assert.equal(
    manifest.migrations.at(-1).tag,
    manifest.through,
    "Fixture endpoint differs from prefix.",
  );
  assert.equal(
    digest(seed),
    manifest.seedSha256,
    "Upgrade seed digest changed; review fixture changes explicitly.",
  );
  for (const [index, expected] of manifest.migrations.entries()) {
    const actual = journal.entries[index];
    assert.equal(actual?.idx, index, `Migration index drift at ${index}.`);
    assert.equal(actual?.tag, expected.tag, `Migration tag drift at ${index}.`);
    assert.equal(actual?.when, expected.when, `Migration timestamp drift at ${index}.`);
    assert.equal(
      digest(sources[index]),
      expected.sha256,
      `Historical SQL changed: ${expected.tag}.`,
    );
  }
}

export async function loadUpgradeFixture(directory = fixtureFolder) {
  let manifest, journal, seed, sources;
  try {
    manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
    seed = await readFile(join(directory, "seed.sql"), "utf8");
    // File names come only from the repository journal, never the fixture override.
    sources = await Promise.all(
      journal.entries
        .slice(0, manifest.migrations?.length)
        .map((entry) => readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8")),
    );
  } catch {
    throw new Error(
      "Required retained-upgrade fixture is missing or unreadable; restore scripts/fixtures/retained-upgrade and the migration journal. No database was opened.",
    );
  }
  validateFixture(manifest, journal, sources, seed);
  return { manifest, journal, seed, sources };
}

async function snapshot(connection) {
  const result = {};
  for (const table of tables) {
    const rows = await connection`select to_jsonb(t) as value from ${connection(table)} t`;
    result[table] = rows.map((row) => row.value);
    assert(result[table].length > 0, `Fixture failed to populate ${table}.`);
  }
  return result;
}

function assertRetained(before, after) {
  for (const table of tables) {
    const columns = Object.keys(before[table][0]).sort();
    const project = (rows) =>
      rows
        .map((row) => JSON.stringify(Object.fromEntries(columns.map((key) => [key, row[key]]))))
        .sort();
    assert.deepEqual(
      project(after[table]),
      project(before[table]),
      `Retained columns changed in ${table}.`,
    );
  }
}

async function history(connection) {
  const rows =
    await connection`select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id`;
  return rows.map((row) => ({ hash: row.hash, createdAt: Number(row.createdAt) }));
}

async function verifyConstraints(connection) {
  const reject = (operation, code) =>
    assert.rejects(connection.begin(operation), (error) => error.code === code);
  await reject((tx) => tx`update bots set profile_revision = 0 where id = 'upgrade-bot'`, "23514");
  await reject(
    (tx) =>
      tx`update automations set interval_minutes = 1 where id = 'upgrade-automation-submitted'`,
    "23514",
  );
  await reject(
    (tx) =>
      tx`update employee_import_receipts set package_digest = 'invalid' where id = 'upgrade-receipt'`,
    "23514",
  );
  await reject(
    (tx) =>
      tx`insert into employee_import_receipts select 'duplicate-receipt', package_id, package_digest, employee_id, 'duplicate-import', request_fingerprint, signature_status, publisher_key_id, reviewed_by, reviewed_at, imported_skill_count, created_at from employee_import_receipts where id = 'upgrade-receipt'`,
    "23505",
  );
  await reject((tx) => tx`delete from bots where id = 'upgrade-bot'`, "23503");
  await reject(
    (tx) =>
      tx`update employee_memories set model_use_enabled = true where id = 'upgrade-restricted-memory'`,
    "23514",
  );
  await reject(
    (tx) => tx`update skills set skill_markdown = 'unreviewed content' where id = 'upgrade-skill'`,
    "23514",
  );
  await reject(
    (tx) =>
      tx`update automations set last_outcome = 'unknown' where id = 'upgrade-automation-submitted'`,
    "23514",
  );
  const rollback = new Error("fixture transaction rollback");
  await assert.rejects(
    connection.begin(async (tx) => {
      await tx`update automations set last_outcome = 'attachment_unavailable' where id = 'upgrade-automation-submitted'`;
      throw rollback;
    }),
    (error) => error === rollback,
  );
}

export async function verifyRetainedUpgrade(value, directory = fixtureFolder) {
  const url = validateUpgradeTarget(value);
  const fixture = await loadUpgradeFixture(directory);
  const { createDatabase, assertMigrationHistory } = await import("../packages/db/dist/index.js");
  const connection = postgres(url, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
    connection: {
      application_name: "openbot-retained-upgrade",
      statement_timeout: 15000,
      lock_timeout: 5000,
    },
  });
  let temporary, first, second;
  let stage = "empty database check";
  try {
    const existing =
      await connection`select nspname from pg_namespace where nspname not in ('public', 'information_schema') and nspname not like 'pg_%'
      union all select schemaname from pg_tables where schemaname = 'public'
      union all select n.nspname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'`;
    assert.equal(
      existing.length,
      0,
      "Upgrade verification requires an empty database. Existing schemas/data are never removed; create a new fixture database.",
    );
    temporary = await mkdtemp(join(tmpdir(), "openbot-upgrade-prefix-"));
    await mkdir(join(temporary, "meta"));
    await writeFile(
      join(temporary, "meta/_journal.json"),
      JSON.stringify({
        ...fixture.journal,
        entries: fixture.journal.entries.slice(0, fixture.manifest.migrations.length),
      }),
    );
    for (const [index, entry] of fixture.manifest.migrations.entries()) {
      await writeFile(join(temporary, `${entry.tag}.sql`), fixture.sources[index]);
    }
    stage = "historical prefix migration";
    await migrate(drizzle(connection), { migrationsFolder: temporary });
    // The seed is repository-owned SQL whose digest was verified before opening the database.
    stage = "historical fixture population";
    await connection.begin((tx) => tx.unsafe(fixture.seed));
    const before = await snapshot(connection);
    assertMigrationHistory(
      readMigrationFiles({ migrationsFolder: temporary }),
      await history(connection),
      true,
    );
    console.info(
      `Retained-upgrade fixture populated at ${fixture.manifest.through}: ${tables.length} tables.`,
    );
    first = createDatabase(url);
    second = createDatabase(url);
    stage = "concurrent production upgrade";
    const upgrades = await Promise.allSettled([first.migrate(), second.migrate()]);
    for (const result of upgrades) if (result.status === "rejected") throw result.reason;
    await first.migrate();
    stage = "retained rows and safe defaults";
    const upgradedHistory = await history(connection);
    const expected = readMigrationFiles({ migrationsFolder });
    assertMigrationHistory(expected, upgradedHistory, true);
    assertRetained(before, await snapshot(connection));
    const defaults = await connection`select model_use_enabled from employee_memories`;
    assert(
      defaults.every((row) => row.model_use_enabled === false),
      "Old memory must not gain model authority.",
    );
    const skills = await connection`select skill_markdown, content_sha256 from skills`;
    assert(skills.every((row) => row.skill_markdown === null && row.content_sha256 === null));
    const reviews = await connection`select reviewed_content_sha256, revision from employee_skills`;
    assert(reviews.every((row) => row.reviewed_content_sha256 === null && row.revision === 1));
    stage = "constraint probes";
    await verifyConstraints(connection);
    stage = "history drift and application rollback boundary";
    const initial = upgradedHistory[0];
    await connection`update drizzle.__drizzle_migrations set hash = ${"0".repeat(64)} where created_at = ${initial.createdAt}`;
    try {
      await assert.rejects(first.migrate(), /history diverges/);
      assertRetained(before, await snapshot(connection));
    } finally {
      await connection`update drizzle.__drizzle_migrations set hash = ${initial.hash} where created_at = ${initial.createdAt}`;
    }
    // An application behavior revert retains the complete journal. A genuinely old build refuses
    // an ahead history; deleting migration rows is never a rollback mechanism.
    assert.throws(
      () =>
        assertMigrationHistory(
          readMigrationFiles({ migrationsFolder: temporary }),
          upgradedHistory,
        ),
      /ahead of this OpenBot build/,
    );
    await second.migrate();
    assert.deepEqual(await history(connection), upgradedHistory);
    assertRetained(before, await snapshot(connection));
    console.info(
      `Retained upgrade passed: ${upgradedHistory.length} migrations; concurrent/repeated startup, old rows, constraints, safe defaults and preserved rollback history. Fixture database retained for inspection.`,
    );
  } catch (error) {
    error.upgradeStage = stage;
    throw error;
  } finally {
    await Promise.allSettled([connection.end(), first?.close(), second?.close()]);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyRetainedUpgrade(process.env.OPENBOT_UPGRADE_TEST_DATABASE_URL).catch((error) => {
    // Connection errors must not expose a supplied URL, SQL or a server-provided detail.
    console.error(
      error instanceof assert.AssertionError ||
        /^(Required retained-upgrade|Unsupported upgrade fixture)/.test(error.message)
        ? error.message
        : `Retained-upgrade verification failed at ${error.upgradeStage ?? "fixture loading/build"} (${typeof error.code === "string" && /^[A-Z0-9_]{1,24}$/.test(error.code) ? error.code : "check failure"}); check the dedicated fixture database and build @openbot/db first.`,
    );
    process.exitCode = 1;
  });
}
