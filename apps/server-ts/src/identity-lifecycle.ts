import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { runProjection } from "./channel-read-projection.js";
import { employeeRows } from "./employee-records.js";
import { lockEmployeeSource } from "./employee-source-lock.js";
import { refuse } from "./owner-transaction.js";
import type { AuthorizedProductOperation as Owner, ProductRoute } from "./product-identity.js";
import type { OwnerFiles } from "./owner-files.js";
import type { Plugins } from "./product-plugins.js";

type DB = postgres.TransactionSql;
type Row = Record<string, any>;
const active = ["queued", "assigned", "running", "waiting_approval", "blocked"];
async function audit(
  db: DB,
  type: string,
  payload: Record<string, unknown>,
  channel: string | null = null,
  bot: string | null = null,
) {
  await db`INSERT INTO run_events(id,channel_id,bot_id,type,payload) VALUES(${randomUUID()},${channel},${bot},${type},${db.json(payload as postgres.JSONValue)})`;
}
export async function primarySettings(db: DB) {
  const [row] =
    await db`SELECT primary_bot_id,revision FROM workspace_settings WHERE workspace_id='workspace' FOR UPDATE`;
  return row ?? refuse(503, "workspace_settings_unavailable");
}
export async function publishPrimary(db: DB, previous: Row, bot: string | null, reason: string) {
  if (previous.primary_bot_id === bot) return;
  if (previous.revision >= 2147483647) refuse(409, "workspace_revision_exhausted");
  const [row] =
    await db`UPDATE workspace_settings SET primary_bot_id=${bot},revision=revision+1 WHERE workspace_id='workspace' RETURNING revision`;
  await audit(db, "SETTINGS_PRIMARY_BOT_UPDATED", {
    actor: "owner",
    previousBotId: previous.primary_bot_id,
    primaryBotId: bot,
    revision: row!.revision,
    reason,
  });
}
async function removeChannelContent(db: DB, id: string) {
  const source =
    "SELECT source_message_id FROM work_sources UNION SELECT assignment_message_id FROM work_collaborations WHERE assignment_message_id IS NOT NULL";
  const redacted = await db.unsafe(
    "UPDATE messages SET content='（内容已删除）' WHERE channel_id=$1 AND id IN (" +
      source +
      ") RETURNING id",
    [id],
  );
  const deleted = await db.unsafe(
    "DELETE FROM messages WHERE channel_id=$1 AND id NOT IN (" + source + ") RETURNING id",
    [id],
  );
  await db`DELETE FROM message_reactions WHERE channel_id=${id}`;
  await db`DELETE FROM automations WHERE channel_id=${id}`;
  await db`DELETE FROM channel_read_states WHERE channel_id=${id}`;
  const members = await db`DELETE FROM channel_bots WHERE channel_id=${id} RETURNING bot_id`;
  await db`UPDATE channels SET description='',deleted_at=date_trunc('milliseconds',statement_timestamp()),updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=${id}`;
  return { deleted: deleted.length, redacted: redacted.length, members: members.length };
}
async function deleteChannel(db: DB, id: string) {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${id},731))`;
  const [row] = await employeeRows(
    db,
    "SELECT name,direct_bot_id FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
    [id],
  );
  if (!row) return refuse(404, "channel_not_found");
  if (row.direct_bot_id !== null) refuse(409, "direct_channel_identity_follows_bot");
  if (
    (
      await db`SELECT 1 FROM runs WHERE channel_id=${id} AND id IN (SELECT id FROM runs_work_projection WHERE status=ANY(${active})) LIMIT 1`
    ).length
  )
    refuse(409, "active_work_blocks_delete");
  const result = await removeChannelContent(db, id);
  await audit(
    db,
    "CHANNEL_DELETED",
    {
      actor: "owner",
      name: row.name,
      deletedMessages: result.deleted,
      redactedMessages: result.redacted,
      memberCount: result.members,
    },
    id,
  );
  return { deleted: true, channelId: id };
}
async function deleteBot(db: DB, id: string) {
  const settings = await primarySettings(db);
  const [row] = await employeeRows(
    db,
    "SELECT name FROM bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
    [id],
  );
  if (!row) return refuse(404, "bot_not_found");
  if (
    (
      await db`SELECT 1 FROM runs WHERE (bot_id=${id} OR delegated_by_bot_id=${id}) AND id IN (SELECT id FROM runs_work_projection WHERE status=ANY(${active})) LIMIT 1`
    ).length ||
    (await db`SELECT 1 FROM work_tasks WHERE bot_id=${id} AND status IN ('queued','open') LIMIT 1`)
      .length
  )
    refuse(409, "active_work_blocks_delete");
  const [direct] =
    await db`SELECT id FROM channels WHERE direct_bot_id=${id} AND deleted_at IS NULL FOR UPDATE`;
  let content = { deleted: 0, redacted: 0 };
  if (direct) {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${direct.id},731))`;
    content = await removeChannelContent(db, direct.id);
  }
  const memberships = await db`DELETE FROM channel_bots WHERE bot_id=${id} RETURNING channel_id`;
  for (const member of memberships)
    await audit(
      db,
      "BOT_REMOVED_FROM_CHANNEL",
      { actor: "owner", reason: "bot_deleted" },
      member.channel_id,
      id,
    );
  for (const table of [
    "automations",
    "knowledge_proposals",
    "employee_memory_events",
    "employee_memories",
    "employee_skills",
    "employee_evolution_events",
  ])
    await db.unsafe(`DELETE FROM ${table} WHERE bot_id=$1`, [id]);
  await db`UPDATE bots SET description='',configuration='{}'::jsonb,deleted_at=date_trunc('milliseconds',statement_timestamp()),updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=${id}`;
  await audit(
    db,
    "BOT_DELETED",
    {
      actor: "owner",
      name: row.name,
      deletedMessages: content.deleted,
      redactedMessages: content.redacted,
      memberships: memberships.length,
    },
    null,
    id,
  );
  if (settings.primary_bot_id === id) await publishPrimary(db, settings, null, "deleted");
  return { deleted: true, botId: id, direct: direct?.id as string | undefined };
}
async function cancelSource(db: DB, run: string) {
  const [source] = await db`SELECT task_id FROM work_sources WHERE legacy_run_id=${run}`;
  if (!source) return;
  const task = await lockEmployeeSource(db, source.task_id);
  const [link] =
    await db`SELECT root_task_id FROM work_collaborations WHERE child_task_id=${task.id}`;
  const tree = await employeeRows(
    db,
    "SELECT child_task_id,parent_task_id,depth FROM work_collaborations WHERE root_task_id=$1 ORDER BY depth,child_task_id LIMIT 26",
    [link?.root_task_id ?? task.id],
  );
  if (tree.length > 24) refuse(409, "collaboration_task_limit");
  const selected = new Set<string>([task.id]),
    order = [task.id];
  for (const row of tree)
    if (selected.has(row.parent_task_id)) {
      selected.add(row.child_task_id);
      order.push(row.child_task_id);
    }
  for (const id of order) {
    const current = await lockEmployeeSource(db, id);
    if (
      !["queued", "open"].includes(current.status) ||
      (!current.authority_active && current.cancel_requested)
    )
      continue;
    await db`UPDATE work_tasks SET authority_active=false,authority_generation=authority_generation+1,cancel_requested=true WHERE id=${id}`;
    // An already admitted or unknown effect keeps its reconciliation obligation and reservation.
    if (
      !(
        await db`SELECT 1 FROM work_actions WHERE task_id=${id} AND status IN ('admitted','unknown') LIMIT 1`
      ).length
    ) {
      await db`UPDATE work_tasks SET status='cancelled' WHERE id=${id}`;
      await db`UPDATE work_runs SET status='cancelled' WHERE task_id=${id} AND status IN ('queued','running')`;
    }
    const [revision] =
      await db`UPDATE work_tasks SET revision=revision+1 WHERE id=${id} RETURNING revision`;
    await db`INSERT INTO work_events(task_id,revision,kind,payload) VALUES(${id},${revision!.revision},'task.cancel_requested','{"collaborationReason":"cancel"}'::jsonb)`;
  }
}
async function removeMember(db: DB, channel: string, bot: string) {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${channel},731))`;
  const [row] = await employeeRows(
    db,
    "SELECT id,left(name,81) AS name,left(description,501) AS description,direct_bot_id,created_at FROM channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
    [channel],
  );
  if (!row) return refuse(404, "channel_not_found");
  if (row.direct_bot_id) refuse(409, "direct_channel_membership_immutable");
  if ([...row.name].length > 80 || [...row.description].length > 500)
    refuse(503, "channel_interaction_projection_limit");
  const runs =
    await db`SELECT left(id,129) AS id,left(bot_id,129) AS bot_id,left(parent_run_id,129) AS parent_run_id,left(root_run_id,129) AS root_run_id FROM runs WHERE channel_id=${channel} AND id IN (SELECT id FROM runs_work_projection WHERE status=ANY(${active})) ORDER BY created_at,id LIMIT 1001 FOR UPDATE`;
  if (runs.length > 1000) refuse(409, "too_many_active_tasks");
  if (runs.some((r) => Object.values(r).some((v) => typeof v === "string" && [...v].length > 128)))
    refuse(503, "channel_interaction_projection_limit");
  const removed = new Set(runs.filter((r) => r.bot_id === bot).map((r) => r.id));
  for (let i = 0; i < 3; i++)
    for (const r of runs)
      if (removed.has(r.parent_run_id) || removed.has(r.root_run_id)) removed.add(r.id);
  const ids = runs.filter((r) => removed.has(r.id)).map((r) => r.id);
  if (ids.length) {
    for (const id of [...new Set(ids)].sort()) await cancelSource(db, id);
    await db`UPDATE runs SET status='cancelled',updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=ANY(${ids})`;
    await db`UPDATE approvals SET status='expired',decided_at=date_trunc('milliseconds',clock_timestamp()),decided_by='owner' WHERE run_id=ANY(${ids}) AND status='pending'`;
    for (const r of runs)
      if (removed.has(r.id))
        await db`INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) VALUES(${randomUUID()},${r.id},${channel},${r.bot_id},'RUN_CANCELLED',${db.json({ actor: "owner", reason: "channel_member_removed", removedBotId: bot })})`;
  }
  if (
    (
      await db`DELETE FROM channel_bots WHERE channel_id=${channel} AND bot_id=${bot} RETURNING bot_id`
    ).length
  )
    await audit(
      db,
      "BOT_REMOVED_FROM_CHANNEL",
      { actor: "owner", cancelledRunIds: ids },
      channel,
      bot,
    );
  const members =
    await db`SELECT left(bot_id,129) AS bot_id FROM channel_bots WHERE channel_id=${channel} ORDER BY joined_at,bot_id LIMIT 10001`;
  if (members.length > 10000 || members.some((r) => [...r.bot_id].length > 128))
    refuse(503, "channel_interaction_projection_limit");
  const cancelled = ids.length
    ? await employeeRows(db, "SELECT * FROM runs_work_projection WHERE id=ANY($1)", [ids])
    : [];
  return {
    channel: {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: new Date(row.created_at).toISOString(),
      botIds: members.map((r) => r.bot_id),
    },
    cancelledRuns: ids.map((id) =>
      runProjection({
        ...cancelled.find((r) => r.id === id)!,
        created_at: new Date(cancelled.find((r) => r.id === id)!.created_at),
        updated_at: new Date(cancelled.find((r) => r.id === id)!.updated_at),
      }),
    ),
  };
}
export function lifecycleRoutes(files: OwnerFiles, plugins: Plugins): ProductRoute[] {
  async function cleanup(owner: Owner, channels: string[], signal: AbortSignal) {
    if (!channels.length) return true;
    try {
      await files.withLock(
        (session) =>
          owner(async (db) => {
            const rows =
              await db`SELECT id FROM channels WHERE id=ANY(${channels}) AND deleted_at IS NOT NULL`;
            if (rows.length !== new Set(channels).size) refuse(404, "channel_not_found");
            for (const channel of channels) session.purgeChannel(channel);
          }, session.signal),
        signal,
      );
      return true;
    } catch {
      return false;
    }
  }
  return [
    {
      method: "DELETE",
      path: "/api/v1/channels/{channel_id}",
      kind: "product",
      maxBytes: 1024,
      error: "identity_lifecycle_unavailable",
      remote: async (owner, ids, _body, signal) => {
        const result = await owner((db) => deleteChannel(db, ids[0]!));
        return { ...result, attachmentsRemoved: await cleanup(owner, [ids[0]!], signal) };
      },
      execute: async () => {
        throw new Error("Deletion cleanup follows the committed tombstone.");
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/bots/{bot_id}",
      kind: "product",
      maxBytes: 1024,
      error: "identity_lifecycle_unavailable",
      remote: async (owner, ids, _body, signal) => {
        const { direct, ...result } = await owner((db) => deleteBot(db, ids[0]!));
        const attachmentsRemoved = await cleanup(owner, direct ? [direct] : [], signal);
        let pluginGrantsRemoved = true;
        try {
          await plugins.forgetBot(owner, ids[0]!, signal);
        } catch {
          pluginGrantsRemoved = false;
        }
        return { ...result, attachmentsRemoved, pluginGrantsRemoved };
      },
      execute: async () => {
        throw new Error("Deletion cleanup follows the committed tombstone.");
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/channels/{channel_id}/bots/{bot_id}",
      kind: "product",
      maxBytes: 1024,
      error: "channel_interaction_unavailable",
      execute: (db, ids) => removeMember(db, ids[0]!, ids[1]!),
    },
  ];
}
