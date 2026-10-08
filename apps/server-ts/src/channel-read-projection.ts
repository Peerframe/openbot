import {
  botSchema,
  channelSchema,
  messageSchema,
  runSchema,
  runModelUsageSchema,
  botAppearanceSchema,
} from "@openbot/protocol";
import { z } from "zod";
import { WriteFailure } from "./primary-bot-write.js";

type Row = Record<string, unknown>;
const invalidPage = () => new WriteFailure(422, { error: "invalid_message_pagination" });
const invalidInput = () => new WriteFailure(422, { error: "Invalid request input." });
const timestamp = (value: unknown) => {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    value.getUTCFullYear() < 1 ||
    value.getUTCFullYear() > 9999
  )
    throw new Error("Invalid timestamp.");
  return value.toISOString();
};
const optional = (value: unknown) => (value == null ? undefined : value);
const previewSchema = channelSchema.extend({
  latestMessage: z
    .object({
      id: z.string(),
      authorType: z.enum(["human", "bot", "system"]),
      preview: z.string().refine((value) => [...value].length <= 160),
      createdAt: z.string(),
    })
    .strict()
    .optional(),
});

export function botProjection(row: Row) {
  const config = row.configuration as Row | null;
  const candidate = config?.appearance;
  const appearance =
    candidate && typeof candidate === "object"
      ? botAppearanceSchema.safeParse(
          Object.fromEntries(
            ["head", "body", "mobility", "accessory", "accent"].map((key) => [
              key,
              (candidate as Row)[key],
            ]),
          ),
        )
      : undefined;
  return botSchema.parse({
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    computerProfile: row.computer_profile,
    model: optional(config?.model),
    ...(appearance?.success ? { appearance: appearance.data } : {}),
    createdAt: timestamp(row.created_at),
  });
}
export function channelProjection(rows: readonly Row[]) {
  const channels = new Map<unknown, z.infer<typeof previewSchema>>();
  for (const row of rows) {
    let channel = channels.get(row.id);
    if (!channel) {
      channel = previewSchema.parse({
        id: row.id,
        name: row.name,
        description: row.description,
        botIds: [],
        directBotId: optional(row.direct_bot_id),
        createdAt: timestamp(row.created_at),
      });
      channels.set(row.id, channel);
    }
    if (row.last_activity_at != null) channel.lastActivityAt = timestamp(row.last_activity_at);
    if (row.latest_message_id != null)
      channel.latestMessage = {
        id: row.latest_message_id as string,
        authorType: row.latest_author_type as "human",
        preview: row.latest_preview as string,
        createdAt: timestamp(row.latest_message_at),
      };
    if (row.bot_id != null) channel.botIds.push(z.string().parse(row.bot_id));
  }
  return [...channels.values()].map((value) => previewSchema.parse(value));
}
export function messageProjection(row: Row) {
  return messageSchema.parse({
    id: row.id,
    channelId: row.channel_id,
    authorType: row.author_type,
    authorId: optional(row.author_id),
    replyToMessageId: optional(row.reply_to_message_id),
    runId: optional(row.run_id),
    origin: optional(row.origin),
    content: row.content,
    createdAt: timestamp(row.created_at),
  });
}
export function runProjection(row: Row) {
  const usage = runModelUsageSchema.safeParse(row.model_usage);
  return runSchema.parse({
    id: row.id,
    workTaskId: optional(row.work_task_id),
    channelId: row.channel_id,
    botId: row.bot_id,
    executionProfile: row.execution_profile,
    instruction: row.instruction ?? row.title,
    title: row.title,
    status: row.status,
    model: optional(row.model_selection),
    ...(usage.success ? { modelUsage: usage.data } : {}),
    parentRunId: row.parent_run_id || undefined,
    rootRunId: row.root_run_id || undefined,
    delegatedByBotId: row.delegated_by_bot_id || undefined,
    errorCode: row.error_code || undefined,
    sourceMessageId: optional(row.source_message_id),
    nodeId: optional(row.node_id),
    resultSummary: optional(row.result_summary),
    errorMessage: optional(row.error_message),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

export function channelIdentity(value: string) {
  if ([...value].length < 1 || [...value].length > 128) throw invalidInput();
  return value;
}
export function messagePagination(raw: string, channelId: string) {
  const values = new Map<string, string>();
  const query = new URLSearchParams(raw);
  // FastAPI validates parameter length before the operation's strict query parser.
  if ([...(query.getAll("before").at(-1) ?? "")].length > 2048) throw invalidInput();
  const declaredLimit = (query.getAll("limit").at(-1) ?? "100").trim();
  const integer = Number(declaredLimit.replaceAll("_", ""));
  if (
    !/^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$/.test(declaredLimit) ||
    !Number.isInteger(integer) ||
    integer < 1 ||
    integer > 100
  )
    throw invalidInput();
  for (const [key, value] of query) {
    if (!["before", "limit"].includes(key) || values.has(key)) throw invalidPage();
    values.set(key, value);
  }
  const limit = values.get("limit") ?? "100";
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100) throw invalidPage();
  const before = values.get("before");
  return {
    limit: Number(limit),
    boundary: before === undefined ? undefined : decodeCursor(before, channelId),
  };
}
// Retain json.loads(bytes) encoding detection for existing opaque cursors. The public
// encoder still emits UTF-8 only; this bounded compatibility decoder grants no authority.
function cursorJson(bytes: Buffer): string {
  if (
    (bytes[0] === 0 && bytes[1] === 0) ||
    (bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
  ) {
    const little = bytes[0] !== 0;
    if (bytes.length % 4) throw new Error();
    let raw = "";
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const code = little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      if (offset === 0 && code === 0xfeff) continue;
      raw += String.fromCodePoint(code);
    }
    return raw;
  }
  if (
    bytes[0] === 0 ||
    bytes[1] === 0 ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe)
  ) {
    if (bytes.length % 2) throw new Error();
    const little = bytes[0] !== 0 && !(bytes[0] === 0xfe && bytes[1] === 0xff);
    const raw = (little ? bytes : Buffer.from(bytes).swap16()).toString("utf16le");
    return raw.startsWith("\ufeff") ? raw.slice(1) : raw;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function decodeCursor(value: string, channelId: string): { time: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const raw = cursorJson(bytes);
    JSON.parse(raw);
    // The cursor is a flat four-field JSON object. Read scalar tokens to retain version
    // integer spelling and detect duplicate (including escaped) keys before JSON.parse loses them.
    const token = '"(?:[^"\\\\\x00-\x1f]|\\\\["\\\\/bfnrt]|\\\\u[0-9a-fA-F]{4})*"';
    const member = new RegExp(
      `^[ \\t\\r\\n]*(${token})[ \\t\\r\\n]*:[ \\t\\r\\n]*(${token}|-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)[ \\t\\r\\n]*`,
    );
    let rest = raw.trim();
    if (!rest.startsWith("{") || !rest.endsWith("}")) throw new Error();
    rest = rest.slice(1, -1);
    const entries = new Map<string, unknown>();
    for (;;) {
      const match = member.exec(rest);
      if (!match) throw new Error();
      const key = JSON.parse(match[1]!) as string;
      if (entries.has(key) || (key === "v" && match[2] !== "1")) throw new Error();
      entries.set(key, JSON.parse(match[2]!));
      rest = rest.slice(match[0].length);
      if (!rest) break;
      if (!rest.startsWith(",")) throw new Error();
      rest = rest.slice(1);
    }
    const time = entries.get("t"),
      id = entries.get("i");
    if (
      entries.size !== 4 ||
      entries.get("v") !== 1 ||
      entries.get("c") !== channelId ||
      typeof id !== "string" ||
      [...id].length < 1 ||
      [...id].length > 128 ||
      typeof time !== "string" ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(time) ||
      time.startsWith("0000") ||
      new Date(time).toISOString() !== time.slice(0, 23) + "Z"
    )
      throw new Error();
    return { time, id };
  } catch {
    throw invalidPage();
  }
}
export function encodeCursor(channelId: string, row: Row) {
  const cursor = Buffer.from(
    JSON.stringify({ v: 1, c: channelId, t: row.cursor_time, i: row.id }),
    "utf8",
  ).toString("base64url");
  try {
    decodeCursor(cursor, channelId);
  } catch {
    throw new WriteFailure(503, { error: "Control-plane storage is unavailable." });
  }
  return cursor;
}
export function boundedProjection(value: unknown) {
  // Python json.dumps adds one space after each structural comma/colon (not inside strings).
  const wire = JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"|[:,]/g, (match) =>
    match.length === 1 ? match + " " : match,
  );
  if (Buffer.byteLength(wire, "utf8") > 4 * 1024 * 1024) throw new Error("Projection limit.");
  return value;
}
