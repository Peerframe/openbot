import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDatabase } from "../../packages/db/dist/index.js";
import { FileArtifactStorage } from "../../apps/server/dist/artifact-storage.js";
import { materializeHistory, readJson, root, sha256, verifySources } from "./sources.mjs";

// This entry point has no database URL or input-archive option: it owns every tested destination.
const image =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const tables = ["bots", "channels", "channel_bots", "messages", "runs", "artifacts"];
const { values } = parseArgs({ options: { report: { type: "string" } }, allowPositionals: false });
const histories = await verifySources();
const temporary = await mkdtemp(join(tmpdir(), "openbot-s7-"));
const container = `openbot-s7-${randomUUID()}`;
const clients = [];
const cases = [];
let started = false;
let port;
let databaseIndex = 0;

function docker(args, input) {
  return execFileSync("docker", args, {
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function pgTool(command, args, input) {
  return docker(["exec", "-i", container, command, ...args], input);
}

async function check(name, action) {
  const start = performance.now();
  await action();
  cases.push({ name, result: "passed", durationMs: Math.round(performance.now() - start) });
  console.error(`PASS ${name}`);
}

function connect(name) {
  const url = `postgres://postgres:s7-synthetic-only@127.0.0.1:${port}/${name}`;
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 3 });
  clients.push(sql);
  return { name, url, sql };
}

async function newDatabase(admin) {
  const name = `s7_${++databaseIndex}_test`;
  await admin.sql.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);
  return connect(name);
}

async function upgrade(database) {
  const db = createDatabase(database.url);
  try {
    await db.migrate();
  } finally {
    await db.close();
  }
}

async function snapshot(sql) {
  const unsupported = await sql`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('public', 'information_schema')
      AND left(table_schema, 3) <> 'pg_'
      AND NOT (table_schema = 'drizzle' AND table_name = '__drizzle_migrations')
  `;
  assert.equal(unsupported.length, 0, "Unsupported table outside fixture schemas");
  const names = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name
  `;
  const result = {};
  for (const { table_name: name } of names) {
    const rows = await sql`SELECT to_jsonb(t) AS row FROM ${sql(name)} t`;
    result[name] = rows
      .map(({ row }) => row)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  }
  const [relation] = await sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`;
  const ledger = relation.name
    ? Array.from(
        await sql`SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`,
      )
    : [];
  return { tables: result, ledger };
}

async function insertRows(sql, name, rows) {
  for (const row of rows) {
    const columns = Object.keys(row);
    // Drizzle changes Postgres.js JSON serializers on historical-bootstrap clients. Bind text
    // explicitly so the same insert works with both bootstrap and ordinary restored clients.
    await sql`
      INSERT INTO ${sql(name)} (${sql(columns)})
      SELECT ${sql(columns)} FROM json_populate_record(NULL::${sql(name)}, ${JSON.stringify(row)}::text::json)
    `;
  }
}

async function seed(database, label, objects) {
  const fixture = await readJson(join(root, "fixtures", label, "seed.json"));
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.history, label);
  assert.deepEqual(Object.keys(fixture.tables), tables);
  await database.sql.begin(async (sql) => {
    for (const name of tables) await insertRows(sql, name, fixture.tables[name]);
  });
  const artifact = fixture.tables.artifacts[0];
  const bytes = await readFile(join(root, "fixtures", label, "report.md"));
  assert.equal(sha256(bytes), artifact.sha256);
  const path = join(objects, artifact.storage_key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
}

async function verifyFiles(state, objects) {
  const storage = new FileArtifactStorage(objects);
  for (const artifact of state.tables.artifacts ?? []) {
    const bytes = await storage.read(artifact.storage_key);
    assert.equal(sha256(bytes), artifact.sha256, "Artifact checksum mismatch");
    assert.equal(bytes.length, artifact.metadata.sizeBytes, "Artifact size mismatch");
  }
}

function verifyReferences(state) {
  const data = state.tables;
  const has = (name, id) => data[name].some((row) => row.id === id);
  for (const row of data.channel_bots) {
    assert.ok(has("bots", row.bot_id) && has("channels", row.channel_id), "Membership orphan");
  }
  for (const row of data.channels) {
    if (row.direct_bot_id) assert.ok(has("bots", row.direct_bot_id), "Direct Bot orphan");
  }
  for (const row of data.runs) {
    assert.ok(has("bots", row.bot_id) && has("channels", row.channel_id), "Run identity orphan");
    assert.ok(has("messages", row.source_message_id), "Run source message orphan");
    const message = data.messages.find(({ id }) => id === row.source_message_id);
    assert.equal(message.channel_id, row.channel_id, "Run source channel mismatch");
  }
  for (const row of data.messages) {
    assert.ok(has("channels", row.channel_id), "Message channel orphan");
    if (row.author_type === "bot") assert.ok(has("bots", row.author_id), "Message Bot orphan");
    if (row.run_id) assert.ok(has("runs", row.run_id), "Message Run orphan");
    if (row.reply_to_message_id) {
      assert.ok(has("messages", row.reply_to_message_id), "Message reply orphan");
    }
  }
  for (const row of data.artifacts) assert.ok(has("runs", row.run_id), "Artifact Run orphan");
}

function assertPreserved(before, after) {
  for (const name of tables) {
    assert.equal(after.tables[name].length, before.tables[name].length, `${name}: row count`);
    for (const row of before.tables[name]) {
      const actual = after.tables[name].find((candidate) =>
        row.id
          ? candidate.id === row.id
          : candidate.channel_id === row.channel_id && candidate.bot_id === row.bot_id,
      );
      assert.ok(actual, `${name}: retained identity`);
      for (const [key, value] of Object.entries(row)) {
        if (name === "runs" && key === "model_selection" && value === null) continue;
        assert.deepEqual(actual[key], value, `${name}.${key}: retained value`);
      }
    }
  }
  verifyReferences(after);
  for (const name of ["work_tasks", "work_runs", "work_artifacts"]) {
    assert.deepEqual(after.tables[name], [], "Legacy work must not be silently reclassified");
  }
}

async function transferFeature(source, target, objects) {
  const state = await snapshot(source);
  assert.equal(state.ledger.length, histories.feature.migrations.length, "Unknown source history");
  for (const [index, row] of state.ledger.entries()) {
    assert.equal(row.hash, histories.feature.migrations[index].sha256, "Unknown source history");
    assert.equal(
      Number(row.created_at),
      histories.feature.migrations[index].timestamp,
      "Unknown source history",
    );
  }
  for (const [name, rows] of Object.entries(state.tables)) {
    assert.ok(tables.includes(name) || rows.length === 0, `Unsupported nonempty table: ${name}`);
    assert.ok(rows.length <= 4, "Fixture row bound exceeded");
  }
  for (const row of state.tables.runs) {
    assert.equal(row.execution_profile, "none", "Unsupported execution profile");
    assert.equal(row.status, "completed", "Unsupported active work");
    assert.equal(row.node_id, null, "Unsupported Worker reference");
    assert.equal(row.model_selection, null, "Unsupported model selection");
  }
  verifyReferences(state);
  await verifyFiles(state, objects);
  // Only this disposable target is written. Its current ledger was produced by the real migrator.
  await target.sql.begin(async (sql) => {
    const destination = await snapshot(sql);
    assert.ok(
      Object.values(destination.tables).every((rows) => rows.length === 0),
      "Target is not empty",
    );
    for (const name of tables) {
      const columns = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${name}
      `;
      const allowed = new Set(columns.map(({ column_name }) => column_name));
      const rows = state.tables[name].map((row) => {
        const copy = { ...row };
        if (name === "runs") delete copy.model_selection;
        assert.ok(
          Object.keys(copy).every((key) => allowed.has(key)),
          "Unsupported source column",
        );
        return copy;
      });
      await insertRows(sql, name, rows);
    }
  });
}

async function backup(database, objects, label) {
  const destination = join(temporary, `backup-${label}`);
  await mkdir(destination);
  const bytes = pgTool("pg_dump", [
    "-U",
    "postgres",
    "-d",
    database.name,
    "--format=custom",
    "--no-owner",
    "--no-privileges",
  ]);
  await writeFile(join(destination, "database.dump"), bytes, { mode: 0o600 });
  await cp(objects, join(destination, "objects"), { recursive: true });
  const state = await snapshot(database.sql);
  const manifest = {
    synthetic: true,
    label,
    databaseSha256: sha256(bytes),
    stateSha256: sha256(JSON.stringify(state)),
  };
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest));
  await verifyFiles(state, join(destination, "objects"));
  return { destination, state, manifest };
}

async function restore(bundle, database, objects) {
  const bytes = await readFile(join(bundle.destination, "database.dump"));
  const manifest = await readJson(join(bundle.destination, "manifest.json"));
  assert.deepEqual(manifest, bundle.manifest, "Backup manifest mismatch");
  assert.equal(sha256(bytes), manifest.databaseSha256, "Backup checksum mismatch");
  assert.deepEqual(
    await snapshot(database.sql),
    { tables: {}, ledger: [] },
    "Restore target is not empty",
  );
  pgTool(
    "pg_restore",
    [
      "-U",
      "postgres",
      "-d",
      database.name,
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
    ],
    bytes,
  );
  await cp(join(bundle.destination, "objects"), objects, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const state = await snapshot(database.sql);
  assert.deepEqual(state, bundle.state);
  assert.equal(sha256(JSON.stringify(state)), manifest.stateSha256);
  verifyReferences(state);
  await verifyFiles(state, objects);
}

async function rejectedMutation(source, target, objects, mutate, expected) {
  const before = await snapshot(source.sql);
  const targetBefore = await snapshot(target.sql);
  const rollback = new Error("rollback synthetic mutation");
  await assert.rejects(
    source.sql.begin(async (sql) => {
      await mutate(sql);
      await assert.rejects(transferFeature(sql, target, objects), expected);
      assert.deepEqual(await snapshot(target.sql), targetBefore, "Rejected import mutated target");
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.deepEqual(await snapshot(source.sql), before);
}

try {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--label",
    "openbot.fixture=s7",
    "--memory",
    "1g",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=512m",
    "--env",
    "POSTGRES_PASSWORD=s7-synthetic-only",
    "--publish",
    "127.0.0.1::5432",
    image,
  ]);
  started = true;
  const inspection = JSON.parse(docker(["inspect", container]).toString())[0];
  port = inspection.NetworkSettings.Ports["5432/tcp"][0].HostPort;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      // The image briefly starts a socket-only bootstrap server before the final TCP server.
      pgTool("pg_isready", ["-h", "127.0.0.1", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await setTimeout(250);
    }
  }
  assert.ok(ready, "Disposable PostgreSQL did not become ready");
  const admin = connect("postgres");
  const [version] = await admin.sql`SHOW server_version_num`;
  assert.equal(version.server_version_num, "170011");
  const pgDumpVersion = pgTool("pg_dump", ["--version"]).toString().trim();

  for (const label of ["architecture", "feature"]) {
    const source = await newDatabase(admin);
    const objects = join(temporary, `${label}-objects`);
    const migrationFolder = join(temporary, `${label}-migrations`);
    await check(`${label}: historical bootstrap and linked fixture`, async () => {
      await materializeHistory(label, histories[label], migrationFolder);
      await migrate(drizzle(source.sql), { migrationsFolder: migrationFolder });
      await seed(source, label, objects);
      const state = await snapshot(source.sql);
      assert.equal(state.ledger.length, histories[label].migrations.length);
      verifyReferences(state);
      await verifyFiles(state, objects);
    });
    const original = await snapshot(source.sql);
    const bundle = await backup(source, objects, label);
    const restored = await newDatabase(admin);
    const restoredObjects = join(temporary, `${label}-restored-objects`);
    await check(`${label}: nonempty restore destination rejected`, async () => {
      await assert.rejects(restore(bundle, source, restoredObjects), /Restore target is not empty/);
      assert.deepEqual(await snapshot(source.sql), original);
    });
    await check(`${label}: damaged backup rejected before restore`, async () => {
      const dumpPath = join(bundle.destination, "database.dump");
      const bytes = await readFile(dumpPath);
      const corrupted = Buffer.from(bytes);
      corrupted[0] ^= 1;
      try {
        await writeFile(dumpPath, corrupted);
        await assert.rejects(
          restore(bundle, restored, restoredObjects),
          /Backup checksum mismatch/,
        );
        assert.deepEqual(await snapshot(restored.sql), { tables: {}, ledger: [] });
      } finally {
        await writeFile(dumpPath, bytes);
      }
    });
    await check(`${label}: full old database and file restore`, () =>
      restore(bundle, restored, restoredObjects),
    );
    let target = restored;
    if (label === "architecture") {
      await check("architecture: guarded additive upgrade preserves records", async () => {
        await upgrade(target);
        assertPreserved(original, await snapshot(target.sql));
      });
    } else {
      await check("feature: direct upgrade rejects divergence without mutation", async () => {
        await assert.rejects(upgrade(restored), /diverges.*index 17/);
        assert.deepEqual(await snapshot(restored.sql), original);
      });
      target = await newDatabase(admin);
      await upgrade(target);
      await check("feature: unknown nonempty table rejected", () =>
        rejectedMutation(
          restored,
          target,
          restoredObjects,
          async (sql) => {
            await sql`CREATE TABLE s7_unmapped (value text)`;
            await sql`INSERT INTO s7_unmapped VALUES ('synthetic')`;
          },
          /Unsupported nonempty table/,
        ),
      );
      for (const schema of ["s7_extra", "drizzle"]) {
        await check(`feature: unsupported ${schema} schema table rejected`, () =>
          rejectedMutation(
            restored,
            target,
            restoredObjects,
            async (sql) => {
              if (schema === "s7_extra") await sql`CREATE SCHEMA s7_extra`;
              await sql`CREATE TABLE ${sql(`${schema}.unmapped`)} (value text)`;
              await sql`INSERT INTO ${sql(`${schema}.unmapped`)} VALUES ('synthetic')`;
            },
            /Unsupported table outside fixture schemas/,
          ),
        );
      }
      await check("feature: model connection rejected", () =>
        rejectedMutation(
          restored,
          target,
          restoredObjects,
          async (sql) => {
            await sql`INSERT INTO model_connections (id,name,preset_id,base_url,protocol,encrypted_api_key)
          VALUES ('synthetic','Synthetic','custom','https://example.invalid','openai-chat','synthetic-unusable-ciphertext')`;
          },
          /Unsupported nonempty table: model_connections/,
        ),
      );
      await check("feature: unmapped source column rejected", () =>
        rejectedMutation(
          restored,
          target,
          restoredObjects,
          (sql) => sql`ALTER TABLE bots ADD COLUMN s7_unknown text DEFAULT 'synthetic'`,
          /Unsupported source column/,
        ),
      );
      await check("feature: model Run with null selection rejected", () =>
        rejectedMutation(
          restored,
          target,
          restoredObjects,
          (sql) => sql`UPDATE runs SET execution_profile = 'model'`,
          /Unsupported execution profile/,
        ),
      );
      await check("feature: active work rejected", () =>
        rejectedMutation(
          restored,
          target,
          restoredObjects,
          (sql) => sql`UPDATE runs SET status = 'queued'`,
          /Unsupported active work/,
        ),
      );
      await check("feature: unprotected message reference orphan rejected", () =>
        rejectedMutation(
          restored,
          target,
          restoredObjects,
          (sql) =>
            sql`UPDATE messages SET reply_to_message_id = 'missing' WHERE author_type = 'bot'`,
          /Message reply orphan/,
        ),
      );
      await check("feature: drifted source ledger rejected", () =>
        rejectedMutation(
          restored,
          target,
          restoredObjects,
          (sql) => sql`UPDATE drizzle.__drizzle_migrations SET hash = repeat('0',64) WHERE id = 1`,
          /Unknown source history/,
        ),
      );
      await check("feature: late insert failure rolls back the whole transfer", async () => {
        await target.sql`ALTER TABLE artifacts ADD CONSTRAINT s7_reject CHECK (false)`;
        try {
          const before = await snapshot(target.sql);
          await assert.rejects(transferFeature(restored.sql, target, restoredObjects), {
            code: "23514",
            constraint_name: "s7_reject",
          });
          assert.deepEqual(await snapshot(target.sql), before);
          assert.deepEqual(await snapshot(restored.sql), original);
        } finally {
          await target.sql`ALTER TABLE artifacts DROP CONSTRAINT s7_reject`;
        }
      });
      await check("feature: bounded transfer preserves identities and references", async () => {
        await transferFeature(restored.sql, target, restoredObjects);
        assertPreserved(original, await snapshot(target.sql));
        assert.deepEqual(await snapshot(restored.sql), original);
      });
      await check("feature: duplicate transfer rejected without mutation", async () => {
        const before = await snapshot(target.sql);
        await assert.rejects(
          transferFeature(restored.sql, target, restoredObjects),
          /Target is not empty/,
        );
        assert.deepEqual(await snapshot(target.sql), before);
      });
    }
    await check(`${label}: repeat guarded startup is idempotent`, async () => {
      const before = await snapshot(target.sql);
      await upgrade(target);
      assert.deepEqual(await snapshot(target.sql), before);
    });
    const targetBundle = await backup(target, restoredObjects, `${label}-target`);
    await check(`${label}: target backup restores database and file references`, async () => {
      const recovered = await newDatabase(admin);
      const recoveredObjects = join(temporary, `${label}-target-restored-objects`);
      await restore(targetBundle, recovered, recoveredObjects);
      await upgrade(recovered);
      assertPreserved(original, await snapshot(recovered.sql));
    });
    const state = await snapshot(target.sql);
    const artifact = state.tables.artifacts[0];
    const artifactPath = join(restoredObjects, artifact.storage_key);
    const artifactBytes = await readFile(artifactPath);
    await check(`${label}: same-size corrupted file rejected`, async () => {
      const corrupted = Buffer.from(artifactBytes);
      corrupted[0] ^= 1;
      await writeFile(artifactPath, corrupted);
      await assert.rejects(verifyFiles(state, restoredObjects), /checksum mismatch/);
      await writeFile(artifactPath, artifactBytes);
    });
    await check(`${label}: missing file rejected`, async () => {
      await rm(artifactPath);
      await assert.rejects(verifyFiles(state, restoredObjects), { code: "ENOENT" });
      await writeFile(artifactPath, artifactBytes);
    });
    for (const kind of ["hash", "timestamp", "missing", "ahead"]) {
      await check(`${label}: ${kind} history failure leaves database unchanged`, async () => {
        // Damage only a fresh negative-test copy; never reset or repair the source/target ledger.
        const damaged = await newDatabase(admin);
        pgTool(
          "pg_restore",
          [
            "-U",
            "postgres",
            "-d",
            damaged.name,
            "--single-transaction",
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
          ],
          await readFile(join(targetBundle.destination, "database.dump")),
        );
        if (kind === "hash")
          await damaged.sql`UPDATE drizzle.__drizzle_migrations SET hash = repeat('0',64) WHERE id = 1`;
        if (kind === "timestamp")
          await damaged.sql`UPDATE drizzle.__drizzle_migrations SET created_at = created_at + 1 WHERE id = 1`;
        if (kind === "missing")
          await damaged.sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = 2`;
        if (kind === "ahead")
          await damaged.sql`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (repeat('f',64),9999999999999)`;
        const changed = await snapshot(damaged.sql);
        await assert.rejects(upgrade(damaged), /diverges|ahead/);
        assert.deepEqual(await snapshot(damaged.sql), changed);
        assert.deepEqual(await snapshot(target.sql), state);
      });
    }
    await check(`${label}: native restore failure rolls back all DDL`, async () => {
      const conflict = await newDatabase(admin);
      await conflict.sql`CREATE TABLE bots (marker text)`;
      await conflict.sql`INSERT INTO bots VALUES ('synthetic sentinel')`;
      const before = await snapshot(conflict.sql);
      assert.throws(
        () =>
          pgTool(
            "pg_restore",
            [
              "-U",
              "postgres",
              "-d",
              conflict.name,
              "--single-transaction",
              "--exit-on-error",
              "--no-owner",
              "--no-privileges",
            ],
            pgTool("pg_dump", [
              "-U",
              "postgres",
              "-d",
              source.name,
              "--format=custom",
              "--no-owner",
              "--no-privileges",
            ]),
          ),
        (error) => /relation "bots" already exists/.test(error.stderr?.toString() ?? ""),
      );
      assert.deepEqual(await snapshot(conflict.sql), before);
    });
    assert.deepEqual(await snapshot(source.sql), original, "Original source was mutated");
  }
  const report = {
    schemaVersion: 1,
    syntheticOnly: true,
    result: "passed",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    image,
    pgDumpVersion,
    histories: Object.fromEntries(
      Object.entries(histories).map(([label, history]) => [
        label,
        {
          commit: history.commit,
          migrationCount: history.migrations.length,
          digest: sha256(JSON.stringify(history.migrations)),
        },
      ]),
    ),
    cases,
    limitations: [
      "Fixture-only feature transfer; no general divergent-history upgrade",
      "Legacy runs retained; no work_tasks conversion",
      "No settings/key/plugin/attachment/Temporal restore",
      "No production migration, default switch, release, or S7 completion",
    ],
  };
  if (values.report)
    await writeFile(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`);
  console.info(JSON.stringify(report, null, 2));
} finally {
  await Promise.allSettled(clients.map((sql) => sql.end({ timeout: 2 })));
  try {
    if (started) docker(["rm", "--force", container]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
