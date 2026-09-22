import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createApp } from "../apps/server/dist/app.js";
import { FileArtifactStorage } from "../apps/server/dist/artifact-storage.js";
import { FileChannelAttachmentStorage } from "../apps/server/dist/channel-attachments.js";
import { bootstrapModelSettings } from "../apps/server/dist/model-settings-bootstrap.js";
import { OwnerAuthService } from "../apps/server/dist/owner-auth.js";
import { FilePluginStore } from "../apps/server/dist/plugin-store.js";
import { PostgresRequestThrottleStore } from "../apps/server/dist/postgres-request-throttle-store.js";
import { PostgresOwnerSessionStore } from "../apps/server/dist/postgres-session-store.js";
import { PostgresControlPlaneStore } from "../apps/server/dist/postgres-store.js";
import { RequestThrottle } from "../apps/server/dist/request-throttle.js";
import { artifacts as artifactsTable, createDatabase } from "../packages/db/dist/index.js";
import {
  captureFixtureFiles,
  digest,
  restoreFixtureFiles,
  verifyFixtureFiles,
} from "./paired-restore-files.mjs";
import { postgresImage, SmokeDatabase } from "./smoke-dev-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://localhost:5173";
const ownerPassword = randomBytes(24).toString("hex");
const modelCredential = `fixture-model-${randomBytes(16).toString("hex")}`;
const pluginCredential = `fixture-plugin-${randomBytes(16).toString("hex")}`;
const reportText = "# Retained report\n\nSynthetic recovery acceptance.\n";
const attachmentText = "Synthetic source: retain bytes and derived text together.\n";
let outboundRequests = 0;
const denyNetwork = async () => {
  outboundRequests += 1;
  throw new Error("Outbound network is disabled in the restore drill.");
};

function readers(database, files) {
  const store = new PostgresControlPlaneStore(database.db);
  const attachments = new FileChannelAttachmentStorage(join(files, "objects", "attachments"));
  const artifacts = new FileArtifactStorage(join(files, "objects"));
  const throttle = new RequestThrottle(new PostgresRequestThrottleStore(database.db));
  const auth = new OwnerAuthService(
    new PostgresOwnerSessionStore(database.db),
    {
      ownerName: "Restore Fixture Owner",
      ownerPassword,
      sessionTtlMs: 300_000,
    },
    throttle,
  );
  // Deliberately no runners, scheduler, PluginService connector, Node registry or listening socket.
  const app = createApp({
    store,
    attachments,
    artifactStorage: artifacts,
    auth,
    requestThrottle: throttle,
    allowedOrigins: [origin],
    secureCookies: false,
    getRemoteAddress: () => "127.0.0.1",
    listNodes: () => [],
  });
  return { store, attachments, artifacts, app };
}

async function rows(database) {
  const result = {};
  const tables =
    await database.client`select schemaname, tablename from pg_tables where schemaname in ('public', 'drizzle') order by schemaname, tablename`;
  for (const { schemaname, tablename } of tables) {
    const values =
      await database.client`select to_jsonb(t) as value from ${database.client(schemaname)}.${database.client(tablename)} t`;
    result[`${schemaname}.${tablename}`] = values.map(({ value }) => JSON.stringify(value)).sort();
  }
  return result;
}

async function seed(database, files) {
  await database.migrate();
  // Existing public synthetic rows exercise approvals, audit, learning and enabled schedules.
  // No schedule service is instantiated in this drill.
  await database.client.unsafe(
    await readFile(join(root, "scripts/fixtures/retained-upgrade/seed.sql"), "utf8"),
  );
  // The upgrade-only fixture intentionally has a metadata stub. Replace it before this drill's
  // capture so every authoritative artifact row has real bytes, not just the newly sampled row.
  await database.client`delete from artifacts where id = 'upgrade-artifact'`;
  const current = readers(database, files);
  const bot = await current.store.createBot({
    name: "Paired Restore Employee",
    role: "Research",
    description: "Synthetic fixture",
    computerProfile: "none",
  });
  const channel = await current.store.createChannel({
    name: "Paired Restore Channel",
    description: "Synthetic fixture",
    botIds: [bot.id],
  });
  const { run } = await current.store.submitTask(channel.id, {
    content: "Restore this synthetic report",
    botId: bot.id,
  });
  const [report] = await current.artifacts.persist(run.id, [
    { name: "recovery.md", mediaType: "text/markdown", text: reportText },
  ]);
  await database.db.insert(artifactsTable).values({
    id: report.artifact.id,
    runId: run.id,
    name: report.artifact.name,
    mediaType: report.artifact.mediaType,
    storageKey: report.storageKey,
    sha256: report.artifact.sha256,
    metadata: report.metadata,
    createdAt: new Date(report.artifact.createdAt),
  });
  // Fixture data, not an inference success assertion. Runtime delivery has its own acceptance.
  await database.client`update runs set status = 'completed' where id = ${run.id}`;
  const attachment = await current.attachments.persist(
    channel.id,
    "source.txt",
    Buffer.from(attachmentText),
  );
  const derived = {
    sha256: attachment.sha256,
    text: attachmentText,
    operation: "extract",
    truncated: false,
    processedAt: new Date().toISOString(),
  };
  await current.attachments.saveDerived(channel.id, attachment.id, derived);
  const settings = await bootstrapModelSettings(
    { OPENBOT_MODEL_DIRECTORY: join(files, "model") },
    async () => Response.json({ id: "restore-fixture" }),
  );
  assert(settings);
  const modelSummary = await settings.save({
    provider: "openai",
    model: "restore-fixture",
    apiKey: modelCredential,
    revision: null,
    agentEnabled: true,
  });
  const plugins = new FilePluginStore(join(files, "objects", "plugins", "state.json"));
  await plugins.transaction((state) => {
    state.plugins.push({
      id: randomUUID(),
      revision: randomUUID(),
      name: "Restore Fixture",
      endpoint: "http://127.0.0.1:1/mcp",
      digest: "a".repeat(64),
      enabled: true,
      createdAt: new Date().toISOString(),
      token: pluginCredential,
      tools: [],
      grants: [{ botId: bot.id, tools: [] }],
    });
    state.audit.push({
      at: new Date().toISOString(),
      phase: "fixture_retained",
      pluginId: state.plugins[0].id,
      botId: bot.id,
      runId: run.id,
    });
  });
  const pluginState = await plugins.read();
  const login = await current.app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  return { bot, channel, run, report, attachment, derived, modelSummary, pluginState, cookie };
}

async function corruptThenRestore(path, bytes, check) {
  const original = await readFile(path);
  try {
    if (bytes === null) await rm(path);
    else await writeFile(path, bytes, { mode: 0o600 });
    await check();
  } finally {
    await writeFile(path, original, { mode: 0o600 });
  }
}

async function verifyApplication(database, files, expected) {
  const current = readers(database, files);
  const request = (path) => current.app.request(path, { headers: { Cookie: expected.cookie } });
  const reportPath = `/api/v1/artifacts/${expected.report.artifact.id}/content`;
  const attachmentPath = `/api/v1/channels/${expected.channel.id}/attachments/${expected.attachment.id}/content`;
  for (const path of [reportPath, attachmentPath, "/api/v1/workspace"])
    assert.equal((await current.app.request(path)).status, 401);
  const workspace = await request("/api/v1/workspace");
  assert.equal(
    workspace.status,
    200,
    "Restored Owner session must authenticate on the new database.",
  );
  const snapshot = await workspace.json();
  assert(snapshot.bots.some((bot) => bot.id === expected.bot.id));
  assert(snapshot.runs.some((run) => run.id === expected.run.id && run.status === "completed"));
  const artifactRows = await database.client`select id, sha256 from artifacts order by id`;
  assert.equal(
    artifactRows.length,
    1,
    "Review new fixture artifacts instead of silently sampling.",
  );
  for (const artifact of artifactRows) {
    const response = await request(`/api/v1/artifacts/${artifact.id}/content`);
    assert.equal(response.status, 200, "Every authoritative artifact must be downloadable.");
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), artifact.sha256);
  }
  for (const [path, text] of [
    [reportPath, reportText],
    [attachmentPath, attachmentText],
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(await response.text(), text);
  }
  assert.deepEqual(
    await current.attachments.derived(expected.channel.id, expected.attachment.id),
    expected.derived,
  );
  const model = () =>
    bootstrapModelSettings({ OPENBOT_MODEL_DIRECTORY: join(files, "model") }, denyNetwork);
  const restoredModel = await model();
  assert.deepEqual(await restoredModel.summary(), expected.modelSummary);
  assert.equal((await restoredModel.agentSettings()).apiKey, modelCredential);
  const pluginPath = join(files, "objects", "plugins", "state.json");
  const plugin = () => new FilePluginStore(pluginPath).read();
  assert.deepEqual(await plugin(), expected.pluginState);
  for (const [keyPath, wrongKey, load] of [
    [join(files, "model", "encryption.key"), Buffer.from(randomBytes(32).toString("hex")), model],
    [`${pluginPath}.key`, randomBytes(32), plugin],
  ]) {
    await corruptThenRestore(keyPath, null, async () => {
      await assert.rejects(load, "Missing retained key must fail closed.");
      await assert.rejects(stat(keyPath), { code: "ENOENT" });
    });
    await corruptThenRestore(keyPath, wrongKey, async () =>
      assert.rejects(load, "Wrong key must not decrypt retained state."),
    );
  }
  for (const [path, endpoint, expectedStatus] of [
    [join(files, "objects", expected.report.storageKey), reportPath, 500],
    [join(files, "objects", "attachments", `${expected.attachment.id}.bin`), attachmentPath, 404],
  ]) {
    const damaged = await readFile(path);
    damaged[0] ^= 1;
    await corruptThenRestore(path, damaged, async () =>
      assert.equal((await request(endpoint)).status, expectedStatus),
    );
    await corruptThenRestore(path, null, async () =>
      assert.equal((await request(endpoint)).status, expectedStatus),
    );
  }
  assert.equal(outboundRequests, 0, "A restore read must not use a model or plugin connection.");
}

assert.notEqual(
  process.platform,
  "win32",
  "This drill currently verifies POSIX private files; Windows recovery needs its own acceptance.",
);
assert.equal(
  process.argv.length,
  2,
  "The synthetic restore drill accepts no paths, archives or connection arguments.",
);
const fixture = new SmokeDatabase();
const controller = new AbortController();
const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
const interrupted = () => controller.abort(new Error("Restore drill interrupted."));
process.on("SIGINT", interrupted);
process.on("SIGTERM", interrupted);
const databases = new Set();
const originalFetch = globalThis.fetch;
let directory;
let stage = "start disposable PostgreSQL";
let failed = false;
let databaseCleanup;
const stopOwnedDatabase = () => (databaseCleanup ??= fixture.stop());
const abortRunningFixture = () => {
  // Closing the owned container also interrupts the migration adapter's independent connection.
  // A dirty bit alone cannot interrupt a query waiting on a PostgreSQL advisory lock.
  void Promise.all([
    stopOwnedDatabase(),
    ...[...databases].map((database) => database.client.end({ timeout: 5 })),
  ]).catch(() => {
    failed = true;
  });
};
function advance(next) {
  deadline.throwIfAborted();
  stage = next;
}
function connect(url) {
  const database = createDatabase(url);
  databases.add(database);
  return database;
}
async function close(database) {
  await database.close();
  databases.delete(database);
}
try {
  globalThis.fetch = denyNetwork;
  directory = await mkdtemp(join(tmpdir(), "openbot-paired-restore-"));
  const sourceFiles = join(directory, "source");
  await mkdir(sourceFiles, { mode: 0o700 });
  const source = connect(await fixture.start(deadline, randomBytes(24).toString("hex")));
  deadline.addEventListener("abort", abortRunningFixture, { once: true });
  if (deadline.aborted) abortRunningFixture();
  advance("seed production stores with synthetic data");
  const expected = await seed(source, sourceFiles);
  const before = await rows(source);
  await close(source);
  advance("capture quiescent database and file set");
  const archive = await fixture.dump({ signal: deadline });
  assert(archive.subarray(0, 5).equals(Buffer.from("PGDMP")));
  const backup = join(directory, "backup");
  await mkdir(backup, { mode: 0o700 });
  await writeFile(join(backup, "database.dump"), archive, { flag: "wx", mode: 0o600 });
  const files = await captureFixtureFiles(sourceFiles, join(backup, "files"));
  const exec = promisify(execFile);
  const revision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000 })
  ).stdout.trim();
  const dirty =
    (
      await exec("git", ["status", "--porcelain"], {
        cwd: root,
        timeout: 5000,
        maxBuffer: 128 * 1024,
      })
    ).stdout.length > 0;
  const manifest = {
    version: 1,
    profile: "synthetic-server-directory",
    postgresImage,
    openbot: { revision, workingTreeModified: dirty },
    capturedAt: new Date().toISOString(),
    migrationCount: before["drizzle.__drizzle_migrations"].length,
    database: { bytes: archive.length, sha256: digest(archive) },
    files,
  };
  const serialized = JSON.stringify(manifest);
  for (const secret of [ownerPassword, modelCredential, pluginCredential])
    assert(!serialized.includes(secret));
  await writeFile(join(backup, "manifest.json"), serialized, { flag: "wx", mode: 0o600 });
  const retainedArchive = await readFile(join(backup, "database.dump"));
  assert.equal(digest(retainedArchive), manifest.database.sha256);
  advance("native transactional restore into a new database");
  const target = connect(
    await fixture.createRestoreTarget("openbot_restore_test_complete", { signal: deadline }),
  );
  await fixture.restore("openbot_restore_test_complete", retainedArchive, { signal: deadline });
  assert.deepEqual(await rows(target), before, "Every retained table must survive native restore.");
  await target.migrate();
  assert.deepEqual(
    await rows(target),
    before,
    "Production migration guard must preserve the restored history and rows.",
  );
  const restoredFiles = join(directory, "restored");
  await restoreFixtureFiles(join(backup, "files"), restoredFiles, files);
  advance("production Owner reads, decryption and corruption rejection");
  await verifyApplication(target, restoredFiles, expected);
  await verifyFixtureFiles(restoredFiles, files);
  advance("truncated native archive rollback");
  const broken = connect(
    await fixture.createRestoreTarget("openbot_restore_test_truncated", { signal: deadline }),
  );
  // Keep its header/catalog and truncate compressed data: native restore must fail and roll back.
  await assert.rejects(
    fixture.restore(
      "openbot_restore_test_truncated",
      retainedArchive.subarray(0, Math.floor(retainedArchive.length * 0.75)),
      { signal: deadline },
    ),
  );
  assert.deepEqual(
    await rows(broken),
    {},
    "A failed single-transaction restore must leave no application tables.",
  );
  deadline.throwIfAborted();
  console.log(
    `Paired restore passed: ${Object.keys(before).length} tables, ${files.length} files, ${manifest.migrationCount} migrations; native dump/restore, Owner downloads, key loss/mismatch and corrupted bytes verified.`,
  );
} catch (error) {
  failed = true;
  // Native tools and DB errors can contain synthetic credentials; emit only the stage and error kind.
  console.error(`Paired restore failed during ${stage} (${error.code ?? error.name ?? "error"}).`);
} finally {
  globalThis.fetch = originalFetch;
  const closed = await Promise.allSettled(
    [...databases].map((database) => database.client.end({ timeout: 5 })),
  );
  for (const result of closed) if (result.status === "rejected") failed = true;
  try {
    await stopOwnedDatabase();
  } catch {
    failed = true;
    console.error("Owned restore database cleanup failed.");
  }
  if (directory) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      failed = true;
      console.error("Private restore files cleanup failed.");
    }
  }
  if (!failed) console.log("Owned PostgreSQL container and private recovery files removed.");
  process.off("SIGINT", interrupted);
  process.off("SIGTERM", interrupted);
  deadline.removeEventListener("abort", abortRunningFixture);
}
process.exitCode = failed ? 1 : 0;
