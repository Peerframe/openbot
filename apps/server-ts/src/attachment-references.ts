import type postgres from "postgres";
import { attachmentReferencesSchema } from "@openbot/protocol";
import type { Attachment } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";

export type ReferenceCount = { messages: number; tasks: number };
export type ReferencedAttachment = Attachment & { referenceCount: ReferenceCount };
function count(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10000)
    return refuse(503, "attachment_reference_limit");
  return number;
}
export async function withReferenceCounts(
  db: postgres.TransactionSql,
  channel: string,
  items: readonly Attachment[],
): Promise<ReferencedAttachment[]> {
  if (!items.length) return [];
  if (items.length > 1024) return refuse(503, "attachment_count_limit");
  const rows = await db`SELECT a.id,
    (SELECT count(*) FROM (SELECT 1 FROM messages m WHERE m.channel_id=${channel}
      AND position('[openbot attachment: '||a.id||']' in lower(m.content COLLATE "C"))>0 LIMIT 10001) bounded) AS messages,
    (SELECT count(*) FROM (SELECT 1 FROM runs r WHERE r.channel_id=${channel}
      AND position('[openbot attachment: '||a.id||']' in lower(r.instruction COLLATE "C"))>0 LIMIT 10001) bounded) AS tasks
    FROM jsonb_array_elements_text(${db.json(items.map((item) => item.id))}) AS a(id)`;
  const facts = new Map(
    rows.map((row) => [row.id, { messages: count(row.messages), tasks: count(row.tasks) }]),
  );
  if (facts.size !== items.length) return refuse(503, "attachment_references_unavailable");
  return items.map((item) => ({ ...item, referenceCount: facts.get(item.id)! }));
}
export async function attachmentReferences(
  db: postgres.TransactionSql,
  channel: string,
  id: string,
  query: URLSearchParams,
) {
  const limit = query.get("limit") ?? "20";
  if (
    [...query].length > 1 ||
    [...query.keys()].some((key) => key !== "limit") ||
    !/^[0-9]{1,3}$/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 100
  )
    return refuse(422, "invalid_attachment_reference_query");
  const marker = "[openbot attachment: " + id.toLowerCase() + "]";
  const [row] = await db`WITH message_refs AS MATERIALIZED (
    SELECT id,created_at FROM messages WHERE channel_id=${channel} AND position(${marker} in lower(content COLLATE "C"))>0 LIMIT 10001
  ), task_refs AS MATERIALIZED (
    SELECT id,created_at FROM runs WHERE channel_id=${channel} AND position(${marker} in lower(instruction COLLATE "C"))>0 LIMIT 10001
  ), message_page AS (SELECT * FROM message_refs ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT ${Number(limit)}),
     task_page AS (SELECT * FROM task_refs ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT ${Number(limit)})
  SELECT (SELECT count(*) FROM message_refs) AS message_count,(SELECT count(*) FROM task_refs) AS task_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'createdAt',m.created_at,
      'authorType',m.author_type,'authorId',m.author_id,
      'preview',left(btrim(regexp_replace(m.content COLLATE "C",${String.raw`\[openbot attachment: [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\]`},'','gi')),120))
      ORDER BY m.created_at DESC,m.id COLLATE "C" DESC) FROM message_page p JOIN messages m ON m.id=p.id),'[]'::jsonb) AS messages,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('runId',r.id,'title',left(r.title,160),
      'status',r.status,'createdAt',r.created_at) ORDER BY r.created_at DESC,r.id COLLATE "C" DESC)
      FROM task_page p JOIN runs r ON r.id=p.id),'[]'::jsonb) AS tasks`;
  if (!row) return refuse(503, "attachment_references_unavailable");
  const messages = (row.messages as Array<Record<string, unknown>>).map((item) => {
    const kind = ({ human: "owner", bot: "bot", system: "system" } as const)[
      item.authorType as "human" | "bot" | "system"
    ];
    if (!kind) return refuse(503, "attachment_references_unavailable");
    return {
      id: item.id,
      createdAt: new Date(item.createdAt as string).toISOString(),
      author: {
        kind,
        ...(kind === "bot" && item.authorId !== null ? { botId: item.authorId } : {}),
      },
      preview: item.preview,
    };
  });
  const tasks = (row.tasks as Array<Record<string, unknown>>).map((item) => ({
    ...item,
    createdAt: new Date(item.createdAt as string).toISOString(),
  }));
  const messageCount = count(row.message_count),
    taskCount = count(row.task_count);
  return attachmentReferencesSchema.parse({
    messages,
    tasks,
    messageCount,
    taskCount,
    hasMore: messageCount > messages.length || taskCount > tasks.length,
  });
}
