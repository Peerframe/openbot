import { randomUUID } from "node:crypto";
import {
  botAppearanceResultSchema,
  createChannelInputSchema,
  employeeProfileMutationSchema,
  joinChannelBotInputSchema,
  reactionEmojiSchema,
  renameBotInputSchema,
  renameChannelInputSchema,
  setMessageReactionSchema,
  updateBotAppearanceInputSchema,
  updateEmployeeProfileDetailsInputSchema,
} from "@openbot/protocol";
import type postgres from "postgres";
import { z } from "zod";
import { botProjection, channelProjection } from "./channel-read-projection.js";
import { refuse } from "./owner-transaction.js";
import { WriteFailure } from "./primary-bot-write.js";

type DB = postgres.TransactionSql;
type Row = Record<string, unknown>;
// Python's retained identity inputs count Unicode code points after ECMAScript trim.
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((v) => [...v].length >= min && [...v].length <= max);
export const channelInput = createChannelInputSchema.extend({
  name: text(1, 80),
  description: text(0, 500).default(""),
});
export const profileInput = updateEmployeeProfileDetailsInputSchema.extend({
  role: text(1, 160),
  description: text(0, 2000),
});
const parse = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) return refuse(422, message);
  return result.data;
};
const date = (value: unknown) => {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    value.getUTCFullYear() < 1 ||
    value.getUTCFullYear() > 9999
  )
    throw new Error("Invalid stored date.");
  return value.toISOString();
};
async function audit(
  db: DB,
  type: string,
  payload: Record<string, unknown>,
  channelId: string | null = null,
  botId: string | null = null,
) {
  await db`INSERT INTO run_events(id,channel_id,bot_id,type,payload) VALUES(${randomUUID()},${channelId},${botId},${type},${db.json(payload as postgres.JSONValue)})`;
}
async function channel(db: DB, id: string) {
  const rows = await db`SELECT c.id,c.name,c.description,c.direct_bot_id,c.created_at,cb.bot_id
    FROM channels c LEFT JOIN channel_bots cb ON cb.channel_id=c.id
    WHERE c.id=${id} AND c.deleted_at IS NULL ORDER BY cb.joined_at,cb.bot_id LIMIT 10001`;
  if (rows.length > 10000) throw new Error("Channel member limit.");
  const result = channelProjection(rows);
  if (result.length !== 1) throw new Error("Channel projection unavailable.");
  return result[0]!;
}
async function createChannel(db: DB, body: unknown) {
  const value = parse(channelInput, body, "Invalid creation input.");
  if (value.botIds.length) {
    const bots =
      await db`SELECT id FROM bots WHERE id=ANY(${value.botIds}) AND deleted_at IS NULL ORDER BY id FOR KEY SHARE`;
    if (bots.length !== value.botIds.length)
      refuse(422, "One or more selected Bots no longer exist.");
  }
  const id = randomUUID();
  const [row] = await db`INSERT INTO channels(id,name,description,created_at,updated_at)
    VALUES(${id},${value.name},${value.description},date_trunc('milliseconds',statement_timestamp()),date_trunc('milliseconds',statement_timestamp())) RETURNING created_at`;
  await audit(db, "CHANNEL_CREATED", { name: value.name }, id);
  for (const botId of value.botIds) {
    await db`INSERT INTO channel_bots(channel_id,bot_id,joined_at) VALUES(${id},${botId},${row!.created_at})`;
    await audit(db, "BOT_JOINED_CHANNEL", {}, id, botId);
  }
  return {
    channel: {
      id,
      name: value.name,
      description: value.description,
      botIds: value.botIds,
      createdAt: date(row!.created_at),
    },
  };
}
async function direct(db: DB, id: string) {
  const [bot] = await db`SELECT id,name FROM bots WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
  if (!bot) return refuse(404, "Bot or channel not found.");
  const [existing] = await db`SELECT id FROM channels WHERE direct_bot_id=${id}`;
  const channelId = (existing?.id as string | undefined) ?? randomUUID();
  if (!existing) {
    const [row] =
      await db`INSERT INTO channels(id,name,description,direct_bot_id,created_at,updated_at)
      VALUES(${channelId},${bot.name},'',${id},date_trunc('milliseconds',statement_timestamp()),date_trunc('milliseconds',statement_timestamp())) RETURNING created_at`;
    await db`INSERT INTO channel_bots(channel_id,bot_id,joined_at) VALUES(${channelId},${id},${row!.created_at})`;
    await audit(db, "CHANNEL_CREATED", { name: bot.name, directBotId: id }, channelId);
    await audit(db, "BOT_JOINED_CHANNEL", {}, channelId, id);
  }
  const result = await channel(db, channelId);
  if (result.botIds.length !== 1 || result.botIds[0] !== id)
    throw new Error("Invalid direct membership.");
  return { channel: result };
}
async function join(db: DB, id: string, body: unknown) {
  const { botId } = parse(joinChannelBotInputSchema, body, "Invalid member input.");
  const [row] =
    await db`SELECT direct_bot_id FROM channels WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
  if (!row) return refuse(404, "Bot or channel not found.");
  if (row.direct_bot_id !== null) refuse(422, "Direct conversation membership cannot be changed.");
  if (
    !(await db`SELECT id FROM bots WHERE id=${botId} AND deleted_at IS NULL FOR KEY SHARE`).length
  )
    refuse(404, "Bot or channel not found.");
  if (
    (
      await db`INSERT INTO channel_bots(channel_id,bot_id,joined_at) VALUES(${id},${botId},date_trunc('milliseconds',statement_timestamp())) ON CONFLICT DO NOTHING RETURNING bot_id`
    ).length
  )
    await audit(db, "BOT_JOINED_CHANNEL", {}, id, botId);
  return { channel: await channel(db, id) };
}
async function rename(db: DB, kind: "bot" | "channel", id: string, body: unknown) {
  const { name } = parse(
    (kind === "bot" ? renameBotInputSchema : renameChannelInputSchema).extend({
      name: text(1, kind === "bot" ? 64 : 80),
    }),
    body,
    "invalid_rename_input",
  );
  const [row] =
    kind === "bot"
      ? await db`SELECT name FROM bots WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`
      : await db`SELECT name,direct_bot_id FROM channels WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
  if (!row) return refuse(404, kind + "_not_found");
  if (kind === "channel" && row.direct_bot_id !== null)
    refuse(409, "direct_channel_identity_follows_bot");
  if (row.name !== name) {
    if (kind === "bot") {
      await db`UPDATE bots SET name=${name},updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=${id}`;
      await db`UPDATE channels SET name=${name},updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE direct_bot_id=${id} AND deleted_at IS NULL`;
    } else
      await db`UPDATE channels SET name=${name},updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=${id}`;
    await audit(
      db,
      kind === "bot" ? "BOT_RENAMED" : "CHANNEL_RENAMED",
      { actor: "owner", from: row.name, to: name },
      kind === "channel" ? id : null,
      kind === "bot" ? id : null,
    );
  }
  return { [kind]: { [kind + "Id"]: id, name } };
}
async function profile(db: DB, id: string, body: unknown) {
  const value = parse(profileInput, body, "Invalid profile input.");
  const conflict = () =>
    refuse(
      409,
      "The Employee profile changed while it was being edited. Reload and review the current values.",
    );
  const [before] =
    await db`SELECT role,description,profile_revision FROM bots WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
  if (!before) return refuse(404, "Bot not found.");
  if (before.profile_revision !== value.expectedRevision) conflict();
  const changed = [
    ...(before.role !== value.role ? ["role"] : []),
    ...(before.description !== value.description ? ["description"] : []),
  ];
  if (!changed.length) refuse(422, "At least one Employee profile field must change.");
  const [row] =
    await db`UPDATE bots SET role=${value.role},description=${value.description},profile_revision=profile_revision+1,updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=${id} AND profile_revision=${value.expectedRevision} RETURNING *`;
  if (!row) return conflict();
  const role = changed.includes("role");
  const [event] =
    await db`INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,evidence,created_at)
    VALUES(${randomUUID()},${id},${role ? "role_changed" : "configuration_changed"},${role ? "Employee role updated" : "Profile updated"},${"Owner updated: " + changed.join(", ") + "."},'manual','[]'::jsonb,${row.updated_at}) RETURNING *`;
  await db`INSERT INTO run_events(id,bot_id,type,payload,created_at) VALUES(${randomUUID()},${id},'EMPLOYEE_PROFILE_UPDATED',${db.json({ changedFields: changed, revision: row.profile_revision })},${row.updated_at})`;
  return employeeProfileMutationSchema.parse({
    employee: botProjection(row),
    details: {
      description: row.description,
      revision: row.profile_revision,
      updatedAt: date(row.updated_at),
    },
    evolution: {
      id: event!.id,
      botId: id,
      type: event!.type,
      title: event!.title,
      summary: event!.summary,
      source: event!.source,
      evidence: event!.evidence,
      createdAt: date(event!.created_at),
    },
  });
}
async function appearance(db: DB, id: string, body: unknown) {
  const value = parse(updateBotAppearanceInputSchema, body, "Invalid appearance input.");
  const [before] = await db`SELECT * FROM bots WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
  if (!before) return refuse(404, "Bot not found.");
  if (before.profile_revision !== value.expectedRevision)
    refuse(409, "The Employee profile changed. Reload before editing.");
  const previous = (before.configuration as Row | null)?.appearance ?? null;
  // jsonb equality, not property insertion order, defines an idempotent appearance update.
  const [same] =
    await db`SELECT ${db.json(previous as postgres.JSONValue)}::jsonb = ${db.json(value.appearance)}::jsonb AS equal`;
  if (same!.equal)
    return botAppearanceResultSchema.parse({
      bot: botProjection(before),
      revision: before.profile_revision,
    });
  const [row] =
    await db`UPDATE bots SET configuration=jsonb_set(configuration,'{appearance}',${db.json(value.appearance)}),profile_revision=profile_revision+1,updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=${id} AND profile_revision=${value.expectedRevision} AND deleted_at IS NULL RETURNING *`;
  if (!row) return refuse(409, "The Employee profile changed. Reload before editing.");
  await db`INSERT INTO run_events(id,bot_id,type,payload,created_at) VALUES(${randomUUID()},${id},'EMPLOYEE_APPEARANCE_UPDATED',${db.json({ actor: "owner", from: previous, to: value.appearance, revision: row.profile_revision } as postgres.JSONValue)},${row.updated_at})`;
  return botAppearanceResultSchema.parse({
    bot: botProjection(row),
    revision: row.profile_revision,
  });
}
async function markRead(db: DB, id: string) {
  if (!(await db`SELECT id FROM channels WHERE id=${id} AND deleted_at IS NULL FOR SHARE`).length)
    refuse(404, "channel_not_found");
  const [row] =
    await db`INSERT INTO channel_read_states(channel_id,last_read_at) VALUES(${id},date_trunc('milliseconds',statement_timestamp())) ON CONFLICT(channel_id) DO UPDATE SET last_read_at=GREATEST(channel_read_states.last_read_at,EXCLUDED.last_read_at) RETURNING last_read_at`;
  return { channelId: id, lastReadAt: date(row!.last_read_at) };
}
async function unread(db: DB) {
  const rows =
    await db`SELECT c.id,(SELECT count(*) FROM (SELECT 1 FROM messages m WHERE m.channel_id=c.id AND m.author_type<>'human' AND m.created_at>COALESCE(r.last_read_at,c.created_at) LIMIT 99) capped) AS unread FROM channels c LEFT JOIN channel_read_states r ON r.channel_id=c.id WHERE c.deleted_at IS NULL ORDER BY c.id LIMIT 10001`;
  if (rows.length > 10000) refuse(503, "identity_lifecycle_projection_limit");
  return {
    unread: Object.fromEntries(
      rows.filter((r) => Number(r.unread) > 0).map((r) => [r.id, Number(r.unread)]),
    ),
  };
}
function reactionProjection(rows: readonly Row[]) {
  return rows.map((row) => {
    const emoji = reactionEmojiSchema.safeParse(row.emoji);
    if (!emoji.success) return refuse(503, "invalid_stored_reaction");
    return { messageId: row.message_id, emoji: emoji.data, actor: "owner" };
  });
}
async function reactions(db: DB, id: string) {
  if (!(await db`SELECT id FROM channels WHERE id=${id} AND deleted_at IS NULL`).length)
    refuse(404, "channel_not_found");
  const rows =
    await db`SELECT left(message_id,129) AS message_id,emoji FROM message_reactions WHERE channel_id=${id} AND message_id IN (SELECT id FROM messages WHERE channel_id=${id} ORDER BY created_at DESC LIMIT 100) LIMIT 600`;
  if (rows.some((r) => [...(r.message_id as string)].length > 128))
    refuse(503, "channel_interaction_projection_limit");
  return { reactions: reactionProjection(rows) };
}
async function setReaction(db: DB, id: string, messageId: string, body: unknown) {
  const value = parse(setMessageReactionSchema, body, "Invalid request input.");
  if (
    !(await db`SELECT id FROM messages WHERE id=${messageId} AND channel_id=${id} FOR UPDATE`)
      .length
  )
    refuse(404, "message_not_found_in_channel");
  const rows = value.active
    ? await db`INSERT INTO message_reactions(message_id,channel_id,emoji) VALUES(${messageId},${id},${value.emoji}) ON CONFLICT DO NOTHING RETURNING message_id`
    : await db`DELETE FROM message_reactions WHERE message_id=${messageId} AND channel_id=${id} AND emoji=${value.emoji} RETURNING message_id`;
  if (rows.length)
    await audit(
      db,
      "MESSAGE_REACTION_CHANGED",
      { messageId, emoji: value.emoji, active: value.active, actor: "owner" },
      id,
    );
  return {
    reactions: reactionProjection(
      await db`SELECT message_id,emoji FROM message_reactions WHERE channel_id=${id} AND message_id=${messageId} LIMIT 6`,
    ),
  };
}
export type AuthorizedProductOperation = <T>(operation: (db: DB) => Promise<T>) => Promise<T>;
export type ProductRoute = {
  remote?: (
    owner: AuthorizedProductOperation,
    ids: string[],
    body: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  method: string;
  path: string;
  kind: "typed" | "product";
  maxBytes?: number;
  status?: number;
  error?: string;
  execute: (db: DB, ids: string[], body: unknown) => Promise<unknown>;
};
export const identityRoutes: readonly ProductRoute[] = [
  {
    method: "POST",
    path: "/api/v1/channels",
    kind: "typed",
    status: 201,
    execute: (db, _ids, body) => createChannel(db, body),
  },
  {
    method: "POST",
    path: "/api/v1/bots/{bot_id}/conversation",
    kind: "typed",
    maxBytes: 0,
    execute: (db, ids) => direct(db, ids[0]!),
  },
  {
    method: "POST",
    path: "/api/v1/channels/{channel_id}/bots",
    kind: "typed",
    execute: (db, ids, body) => join(db, ids[0]!, body),
  },
  {
    method: "PATCH",
    path: "/api/v1/bots/{bot_id}/profile",
    kind: "typed",
    maxBytes: 32768,
    execute: (db, ids, body) => profile(db, ids[0]!, body),
  },
  {
    method: "PATCH",
    path: "/api/v1/bots/{bot_id}/appearance",
    kind: "typed",
    maxBytes: 2048,
    execute: (db, ids, body) => appearance(db, ids[0]!, body),
  },
  {
    method: "PATCH",
    path: "/api/v1/bots/{bot_id}",
    kind: "product",
    maxBytes: 1024,
    error: "identity_lifecycle_unavailable",
    execute: (db, ids, body) => rename(db, "bot", ids[0]!, body),
  },
  {
    method: "PATCH",
    path: "/api/v1/channels/{channel_id}",
    kind: "product",
    maxBytes: 1024,
    error: "identity_lifecycle_unavailable",
    execute: (db, ids, body) => rename(db, "channel", ids[0]!, body),
  },
  {
    method: "POST",
    path: "/api/v1/channels/{channel_id}/read",
    kind: "product",
    maxBytes: 1024,
    error: "identity_lifecycle_unavailable",
    execute: (db, ids) => markRead(db, ids[0]!),
  },
  {
    method: "GET",
    path: "/api/v1/channels/unread",
    kind: "product",
    error: "identity_lifecycle_unavailable",
    execute: (db) => unread(db),
  },
  {
    method: "GET",
    path: "/api/v1/channels/{channel_id}/reactions",
    kind: "product",
    error: "channel_interaction_unavailable",
    execute: (db, ids) => reactions(db, ids[0]!),
  },
  {
    method: "PUT",
    path: "/api/v1/channels/{channel_id}/messages/{message_id}/reactions",
    kind: "product",
    maxBytes: 1024,
    error: "channel_interaction_unavailable",
    execute: (db, ids, body) => setReaction(db, ids[0]!, ids[1]!, body),
  },
];
export function identityError(error: unknown, route: ProductRoute): never {
  if (error instanceof WriteFailure) throw error;
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    if (route.error === "identity_lifecycle_unavailable") refuse(409, "name_already_exists");
    if ("constraint_name" in error && error.constraint_name === "channels_name_idx")
      refuse(409, "A channel with this name already exists.");
  }
  return refuse(503, route.error ?? "Control-plane storage is unavailable.");
}
