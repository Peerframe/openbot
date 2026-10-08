import { randomUUID } from "node:crypto";
import {
  approvalDecisionInputSchema,
  approvalDecisionResponseSchema,
  approvalSettingsInputSchema,
  approvalSettingsSchema,
} from "@openbot/protocol";
import type postgres from "postgres";
import { runProjection } from "./channel-read-projection.js";
import { employeeRows, employeeTime } from "./employee-records.js";
import { hasIntegerTokens } from "./json-input.js";
import { parseEmployee } from "./employee-input.js";
import type { OwnerFiles, FileSession, Attachment } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import type { ProductRoute } from "./product-identity.js";

type DB = postgres.TransactionSql;
const protectedCategories = [
  "delete",
  "install",
  "permission_change",
  "command",
  "browser",
  "plugin",
  "unknown",
] as const;
const configurationSchema = approvalSettingsInputSchema.omit({ expectedRevision: true });
function configuration(raw: unknown) {
  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success) return refuse(503, "approval_policy_unavailable");
  return parsed.data;
}
const view = (revision: unknown, raw: unknown) =>
  approvalSettingsSchema.parse({
    revision,
    ...configuration(raw),
    protectedExceptionCategories: protectedCategories,
  });
async function policy(db: DB, write = false) {
  const rows = await employeeRows(
    db,
    "SELECT revision,configuration FROM owner_approval_settings WHERE owner_id='owner' " +
      (write ? "FOR UPDATE" : "FOR SHARE"),
  );
  return rows[0] ?? refuse(503, "approval_policy_unavailable");
}
async function save(
  db: DB,
  files: FileSession | undefined,
  value: ReturnType<typeof approvalSettingsInputSchema.parse>,
) {
  const { expectedRevision, ...next } = value;
  for (const entry of value.exceptions) {
    if (
      !(await db`SELECT id FROM bots WHERE id=${entry.botId} AND deleted_at IS NULL FOR SHARE`)
        .length
    )
      refuse(404, "bot_not_found");
    if (entry.target.kind === "channel") {
      if (
        !(
          await db`SELECT id FROM channels WHERE id=${entry.target.value} AND deleted_at IS NULL FOR SHARE`
        ).length
      )
        refuse(404, "channel_not_found");
    } else if (entry.target.kind === "attachment") {
      if (!files) return refuse(503, "approval_policy_unavailable");
      let item: Attachment;
      try {
        item = files.metadata(null, entry.target.value);
      } catch {
        const raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            files.read(entry.target.value + ".json", 4096),
          ),
        );
        if (typeof raw.channelId !== "string") return refuse(404, "attachment_not_found");
        if (
          !(
            await db`SELECT id FROM channels WHERE id=${raw.channelId} AND deleted_at IS NULL FOR SHARE`
          ).length
        )
          refuse(404, "channel_not_found");
        item = files.metadata(raw.channelId, entry.target.value);
      }
      if (item.deletedAt) refuse(404, "attachment_not_found");
    }
  }
  const current = await policy(db, true);
  configuration(current.configuration);
  if (current.revision !== expectedRevision) refuse(409, "approval_policy_revision_changed");
  const [same] =
    await db`SELECT ${db.json(current.configuration)}::jsonb=${db.json(next)}::jsonb AS same`;
  let revision = current.revision as number;
  if (!same!.same) {
    if (revision >= 2147483647) refuse(409, "approval_policy_revision_exhausted");
    revision++;
    await db`UPDATE owner_approval_settings SET configuration=${db.json(next)},revision=${revision} WHERE owner_id='owner'`;
    await db`INSERT INTO run_events(id,type,payload,created_at) VALUES(${randomUUID()},'SETTINGS_APPROVAL_UPDATED',${db.json({ revision, productRead: value.productRead, publicWeb: value.publicWeb, exceptionCount: value.exceptions.length })},clock_timestamp())`;
  }
  return view(revision, next);
}
async function decide(db: DB, id: string, body: unknown) {
  const parsed = approvalDecisionInputSchema.safeParse(body);
  if (!parsed.success) return refuse(422, "invalid_approval_decision");
  const [reference] = await db`SELECT run_id FROM approvals WHERE id=${id}`;
  if (!reference) return refuse(404, "approval_not_found");
  const [run] = await employeeRows(db, "SELECT * FROM runs WHERE id=$1 FOR UPDATE", [
    reference.run_id,
  ]);
  if (!run) return refuse(503, "product_operation_unavailable");
  const [approval] = await employeeRows(
    db,
    "SELECT *,expires_at<=clock_timestamp() AS expired FROM approvals WHERE id=$1 FOR UPDATE",
    [id],
  );
  if (!approval || approval.status !== "pending" || run.status !== "waiting_approval")
    refuse(409, "approval_already_resolved");
  const status = approval!.expired
    ? "expired"
    : parsed.data.decision === "approve"
      ? "approved"
      : "rejected";
  const [current] =
    await db`UPDATE approvals SET status=${status},decided_by='owner',decided_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=${id} RETURNING *`;
  const [updated] =
    await db`UPDATE runs SET status=${status === "approved" ? "running" : "blocked"},updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=${run.id} RETURNING *`;
  await db`INSERT INTO run_events(id,run_id,channel_id,bot_id,node_id,type,payload) VALUES(${randomUUID()},${run.id},${run.channel_id},${run.bot_id},${current!.node_id},${"APPROVAL_" + status.toUpperCase()},${db.json({ approvalId: id, action: current!.action, targetFingerprint: current!.target_fingerprint, decidedBy: "owner" })})`;
  return approvalDecisionResponseSchema.parse({
    approval: {
      id: current!.id,
      runId: current!.run_id,
      channelId: run.channel_id,
      botId: run.bot_id,
      nodeId: current!.node_id,
      action: current!.action,
      target: current!.target,
      summary: current!.summary,
      risk: current!.risk,
      targetFingerprint: current!.target_fingerprint,
      beforeState: current!.before_state,
      status: current!.status,
      expiresAt: employeeTime(current!.expires_at),
      createdAt: employeeTime(current!.created_at),
      decidedAt: employeeTime(current!.decided_at),
      decidedBy: current!.decided_by,
    },
    run: runProjection(updated!),
  });
}
export function approvalRoutes(files: OwnerFiles): readonly ProductRoute[] {
  return [
    {
      method: "GET",
      path: "/api/v1/settings/approvals",
      kind: "product",
      error: "product_operation_unavailable",
      execute: async (db) => {
        const value = await policy(db);
        return view(value.revision, value.configuration);
      },
    },
    {
      method: "PUT",
      path: "/api/v1/settings/approvals",
      kind: "product",
      maxBytes: 16384,
      error: "product_operation_unavailable",
      remote: async (owner, _ids, body, signal) => {
        if (!hasIntegerTokens(body, ["expectedRevision"]))
          return refuse(422, "Invalid request input.");
        const value = parseEmployee(approvalSettingsInputSchema, body);
        return value.exceptions.some((e) => e.target.kind === "attachment")
          ? files.withLock(
              (session) => owner((db) => save(db, session, value), session.signal),
              signal,
            )
          : owner((db) => save(db, undefined, value));
      },
      execute: async () => {
        throw new Error("Approval settings must own the file-before-policy lock.");
      },
    },
    {
      method: "POST",
      path: "/api/v1/approvals/{approval_id}/decision",
      kind: "product",
      maxBytes: 32768,
      error: "product_operation_unavailable",
      remote: async (owner, ids, body) => {
        const result = await owner((db) => decide(db, ids[0]!, body));
        // Expiration is a committed single-use resolution, then a 409 response, just like Python.
        if (result.approval.status === "expired") return refuse(409, "approval_expired");
        return result;
      },
      execute: async () => {
        throw new Error("Approval expiration must commit before its error response.");
      },
    },
  ];
}
