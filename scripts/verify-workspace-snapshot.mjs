import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.OPENBOT_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  throw new Error("Set OPENBOT_DATABASE_URL to a disposable database ending in _test.");
}
const { createDatabase } = await import("../packages/db/dist/index.js");
const { PostgresControlPlaneStore } = await import("../apps/server/dist/postgres-store.js");
const first = createDatabase(url);
const writer = createDatabase(url);
const store = new PostgresControlPlaneStore(first.db);
const other = new PostgresControlPlaneStore(writer.db);
const originalChannels = PostgresControlPlaneStore.prototype.listChannels;
const originalCounts = PostgresControlPlaneStore.prototype.getCounts;
const suffix = randomUUID();
let bot;
let channel;
let addedChannel;
try {
  await first.migrate();
  bot = await store.createBot({
    name: `Snapshot fixture ${suffix}`,
    role: "Synthetic test",
    computerProfile: "none",
  });
  channel = await store.createChannel({
    name: `Snapshot ${suffix}`,
    description: "Synthetic test",
    botIds: [bot.id],
  });
  // An old active Run is deliberately outside the newest 50 completed records.
  const oldId = randomUUID();
  await writer.client`
    insert into runs (id, channel_id, bot_id, title, instruction, status, created_at)
    values (${oldId}, ${channel.id}, ${bot.id}, 'Old active fixture', 'Synthetic', 'running', '2000-01-01')
  `;
  for (let i = 0; i < 51; i++) {
    await writer.client`
      insert into runs (id, channel_id, bot_id, title, instruction, status)
      values (${randomUUID()}, ${channel.id}, ${bot.id}, 'Recent terminal fixture', 'Synthetic', 'completed')
    `;
  }
  const baseline = await store.getCounts();
  let release;
  const changed = new Promise((resolve) => {
    release = resolve;
  });
  // Test-only interception forces a committed mutation between the rows read and count read.
  // Both still use real PostgreSQL connections and the production query implementations.
  PostgresControlPlaneStore.prototype.listChannels = async function () {
    const rows = await originalChannels.call(this);
    addedChannel = await other.createChannel({
      name: `Concurrent ${suffix}`,
      description: "Synthetic",
      botIds: [],
    });
    release();
    return rows;
  };
  PostgresControlPlaneStore.prototype.getCounts = async function () {
    await changed;
    return originalCounts.call(this);
  };
  const snapshot = await store.readWorkspaceSnapshot();
  assert.deepEqual(snapshot.counts, baseline, "counts must share the pre-mutation row snapshot");
  assert.equal(snapshot.channels.length, snapshot.counts.channels);
  assert.equal(snapshot.bots.length, snapshot.counts.bots);
  assert.equal(snapshot.runs.length, 50);
  assert.ok(!snapshot.runs.some((run) => run.id === oldId));
  assert.ok(
    snapshot.counts.activeRuns >
      snapshot.runs.filter((run) =>
        ["queued", "assigned", "running", "waiting_approval", "blocked"].includes(run.status),
      ).length,
  );
  PostgresControlPlaneStore.prototype.listChannels = originalChannels;
  PostgresControlPlaneStore.prototype.getCounts = originalCounts;
  const next = await store.readWorkspaceSnapshot();
  assert.equal(next.counts.channels, baseline.channels + 1);
  assert.ok(next.channels.some((item) => item.id === addedChannel.id));
  console.info(
    "Workspace snapshot: concurrent rows/counts, global active count and fresh reread passed.",
  );
} finally {
  PostgresControlPlaneStore.prototype.listChannels = originalChannels;
  PostgresControlPlaneStore.prototype.getCounts = originalCounts;
  if (channel) await writer.client`delete from runs where channel_id = ${channel.id}`;
  if (addedChannel) {
    await writer.client`delete from run_events where channel_id = ${addedChannel.id}`;
    await writer.client`delete from channels where id = ${addedChannel.id}`;
  }
  if (channel) {
    await writer.client`delete from run_events where channel_id = ${channel.id}`;
    await writer.client`delete from channel_bots where channel_id = ${channel.id}`;
    await writer.client`delete from channels where id = ${channel.id}`;
  }
  if (bot) {
    await writer.client`delete from run_events where bot_id = ${bot.id}`;
    await writer.client`delete from bots where id = ${bot.id}`;
  }
  await Promise.all([first.close(), writer.close()]);
}
