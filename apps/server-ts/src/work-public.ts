import { randomUUID } from "node:crypto";
import {
  cancelWorkInputSchema,
  correctWorkInputSchema,
  createWorkRequestSchema,
  decideWorkActionInputSchema,
  modelSelectionSchema,
  reconcileWorkInputSchema,
  workSnapshotWireSchema,
} from "@openbot/protocol";
import { EXECUTION_OWNER, WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { FileSession, OwnerFiles } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import type { ProductRoute } from "./product-identity.js";
import { ProductBytes } from "./product-response.js";
import { requestCorrection, requestReconciliation } from "./work-commands.js";
import type { WorkFiles } from "./work-files.js";
import { activeWorkTask, lockWorkTask, type WorkDb, workEvent } from "./work-handoff.js";
import { captureWorkScope } from "./work-scope.js";
import { cascadeWork } from "./work-tree.js";
import { workCanonical, workText } from "./work-values.js";

export const workDate = (value: Date) => value.toISOString();
export function workParse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) return refuse(422, "Invalid work command.");
  return result.data;
}
export async function workUsage(db: WorkDb, taskId: string) {
  const [row] =
    await db`SELECT coalesce(sum(reserved_tokens) FILTER (WHERE status IN ('admitted','unknown')),0) AS reserved,
    coalesce(sum(actual_tokens),0) AS spent FROM work_actions WHERE task_id=${taskId}`;
  return { reservedTokens: Number(row!.reserved), spentTokens: Number(row!.spent) };
}
export function reconciliationView(row: Record<string, unknown>) {
  return {
    id: row.id,
    actionId: row.action_id,
    sequence: row.sequence,
    requestedBy: row.requested_by,
    reason: row.reason,
    createdAt: workDate(row.created_at as Date),
    delivered: row.delivered_at !== null,
    outcome: row.outcome,
  };
}
export async function workSnapshot(db: WorkDb, taskId: string) {
  const [task] = await db`SELECT * FROM work_tasks WHERE id=${taskId}`;
  if (!task) throw new WorkConflict("work_not_found");
  const runs =
    await db`SELECT id,status,ordinal FROM work_runs WHERE task_id=${taskId} ORDER BY ordinal`;
  const repairs =
    await db`SELECT DISTINCT ON(c.action_id) c.* FROM work_reconciliation_commands c JOIN work_actions a ON a.id=c.action_id
    WHERE a.task_id=${taskId} ORDER BY c.action_id,c.sequence DESC`;
  const actions = (
    await db`SELECT * FROM work_actions WHERE task_id=${taskId} ORDER BY created_at,id`
  ).map((a) => ({
    id: a.id,
    runId: a.run_id,
    intent: a.intent,
    intentDigest: a.intent_digest,
    decision: a.decision,
    status: a.status,
    expiresAt: workDate(a.expires_at),
    reservedTokens: Number(a.reserved_tokens),
    actualTokens: a.actual_tokens === null ? null : Number(a.actual_tokens),
    evidence: a.evidence,
    reconciliation: repairs.find((c) => c.action_id === a.id)
      ? reconciliationView(repairs.find((c) => c.action_id === a.id)!)
      : null,
  }));
  const events = (
    await db`SELECT revision,kind,payload FROM work_events WHERE task_id=${taskId} ORDER BY revision DESC LIMIT 100`
  )
    .reverse()
    .map((e) => ({ ...e, revision: Number(e.revision) }));
  const artifacts = (
    await db`SELECT * FROM work_artifacts WHERE task_id=${taskId} ORDER BY id`
  ).map((a) => ({
    id: a.id,
    runId: a.run_id,
    name: a.name,
    mediaType: a.media_type,
    sha256: a.sha256,
    sizeBytes: Number(a.size_bytes),
    downloadUrl: "/api/v1/artifacts/" + a.id,
  }));
  const usage = await workUsage(db, taskId);
  const uncertain = actions.some(
    (a) => a.status === "unknown" || (task.cancel_requested && a.status === "admitted"),
  );
  return workSnapshotWireSchema.parse({
    id: task.id,
    botId: task.bot_id,
    objective: task.objective,
    status: task.status,
    revision: Number(task.revision),
    resultSummary: task.result_summary,
    authorityActive: task.authority_active,
    cancelRequested: task.cancel_requested,
    attention: uncertain
      ? "reconciliation"
      : usage.spentTokens > Number(task.token_limit)
        ? "budget"
        : task.authority_active &&
            actions.some((a) => a.status === "proposed" && a.decision === "pending")
          ? "approval"
          : null,
    usage: { tokenLimit: Number(task.token_limit), ...usage },
    runs,
    actions,
    artifacts,
    events,
    eventsTruncated: Boolean(events[0] && events[0].revision > 1),
  });
}
export async function createWork(db: WorkDb, body: unknown, session?: FileSession, source = false) {
  const value = workParse(
    source
      ? createWorkRequestSchema.extend({
          objective: z.string().min(1).max(32768),
          scope: z.null().default(null),
        })
      : createWorkRequestSchema,
    body,
  );
  workText(value.botId, 128);
  workText(value.objective, source ? 32768 : 16384);
  workText(value.requestKey, 128);
  const digest = workCanonical(
    {
      botId: value.botId,
      objective: value.objective,
      tokenLimit: value.tokenLimit,
      ...(value.scope === null ? {} : { scope: value.scope }),
    },
    !source && value.scope === null ? 16384 : 131072,
  ).digest;
  const [bot] =
    await db`SELECT computer_profile,configuration->'model' AS selection FROM bots WHERE id=${value.botId} AND deleted_at IS NULL FOR SHARE`;
  if (!bot) throw new WorkConflict("work_not_found");
  const taskId = randomUUID(),
    runId = randomUUID();
  const inserted =
    await db`INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit)
    VALUES(${taskId},'owner',${value.botId},${value.requestKey},${digest},${value.objective},${value.tokenLimit})
    ON CONFLICT(request_key) DO NOTHING RETURNING id`;
  if (!inserted.length) {
    const [prior] =
      await db`SELECT id,request_digest FROM work_tasks WHERE request_key=${value.requestKey}`;
    if (prior?.request_digest !== digest) throw new WorkConflict("idempotency_content_changed");
    await lockWorkTask(db, prior.id);
    return workSnapshot(db, prior.id);
  }
  if (!source) {
    if (!["none", "model"].includes(bot.computer_profile))
      throw new WorkConflict("product_task_profile_required");
    let selection = bot.computer_profile === "model" ? bot.selection : null;
    if (selection === null) {
      const [preferences] =
        await db`SELECT default_model FROM owner_preferences WHERE owner_id='owner' FOR SHARE`;
      selection = preferences?.default_model ?? null;
    }
    if (selection !== null) selection = workParse(modelSelectionSchema, selection);
    if (bot.computer_profile === "model" && selection === null)
      throw new WorkConflict("product_task_model_required");
    const profile = {
      kind: "work_task_profile",
      version: 1,
      taskId,
      botId: value.botId,
      executionProfile: bot.computer_profile,
      modelSelection: selection,
    };
    await db`INSERT INTO work_task_profiles(task_id,bot_id,execution_profile,model_selection,profile_digest)
    VALUES(${taskId},${value.botId},${bot.computer_profile},${selection === null ? null : db.json(selection)}::jsonb,${workCanonical(profile).digest})`;
    await captureWorkScope(db, taskId, value.botId, value.scope, session);
  }
  await db`INSERT INTO work_runs(id,task_id,ordinal,corrections_enabled) VALUES(${runId},${taskId},1,true)`;
  await db`INSERT INTO work_admissions(run_id,execution_owner) VALUES(${runId},${EXECUTION_OWNER})`;
  await db`INSERT INTO work_events(task_id,revision,kind,payload) VALUES(${taskId},1,'task.created',${db.json({ runId })}::jsonb)`;
  return workSnapshot(db, taskId);
}
export async function finishWorkCancellation(db: WorkDb, taskId: string) {
  const unresolved =
    await db`SELECT 1 FROM work_actions WHERE task_id=${taskId} AND status IN ('admitted','unknown') LIMIT 1`;
  if (!unresolved.length) {
    await db`UPDATE work_tasks SET status='cancelled' WHERE id=${taskId} AND cancel_requested`;
    await db`UPDATE work_runs r SET status='cancelled' FROM work_tasks t WHERE t.id=r.task_id AND t.id=${taskId}
      AND t.cancel_requested AND r.status IN ('queued','running')`;
  }
}
export async function cancelWork(db: WorkDb, taskId: string) {
  const task = await lockWorkTask(db, taskId);
  if (task.cancel_requested) return workSnapshot(db, taskId);
  if (!["queued", "open"].includes(task.status)) throw new WorkConflict("task_closed");
  await cascadeWork(db, taskId, "cancel");
  return workSnapshot(db, taskId);
}
export async function workAction(db: WorkDb, actionId: string) {
  const [scope] = await db`SELECT task_id FROM work_actions WHERE id=${actionId}`;
  if (!scope) throw new WorkConflict("work_not_found");
  const task = await lockWorkTask(db, scope.task_id);
  const [action] =
    await db`SELECT *,expires_at>clock_timestamp() AS unexpired FROM work_actions WHERE id=${actionId} FOR UPDATE`;
  if (!action) throw new WorkConflict("work_not_found");
  return { task, action };
}
async function decideWork(db: WorkDb, actionId: string, body: unknown) {
  const value = workParse(decideWorkActionInputSchema, body);
  const { task, action } = await workAction(db, actionId);
  activeWorkTask(task);
  if (
    action.intent_digest !== value.intentDigest ||
    String(action.authority_generation) !== String(task.authority_generation) ||
    !action.unexpired
  )
    throw new WorkConflict("approval_stale");
  if (!action.requires_approval || action.status !== "proposed")
    throw new WorkConflict("decision_unavailable");
  const decision = value.approved ? "approved" : "denied";
  if (action.decision !== decision) {
    if (action.decision !== "pending") throw new WorkConflict("decision_already_recorded");
    await db`UPDATE work_actions SET decision=${decision} WHERE id=${actionId}`;
    await workEvent(db, task.id, "action.decided", {
      actionId,
      decision,
      intentDigest: value.intentDigest,
    });
  }
  return workSnapshot(db, task.id);
}
export function workRoutes(files: WorkFiles, attachments?: OwnerFiles): ProductRoute[] {
  const route = (
    method: string,
    path: string,
    maxBytes: number,
    status: number,
    operation: (db: WorkDb, id: string, body: unknown) => Promise<unknown>,
  ): ProductRoute => ({
    method,
    path,
    kind: "typed",
    maxBytes,
    status,
    execute: async (db, ids, body) => {
      try {
        return await operation(db, ids[0] ?? "", body);
      } catch (error) {
        if (error instanceof WorkConflict)
          return refuse(
            error.message === "work_not_found"
              ? 404
              : error.message === "invalid_work_input"
                ? 422
                : 409,
            error.message === "work_not_found" ? "Work item not found." : error.message,
          );
        throw error;
      }
    },
  });
  const create = route("POST", "/api/v1/tasks", 20000, 202, (db, _id, body) =>
    createWork(db, body),
  );
  create.remote = async (owner, _ids, body, signal) => {
    try {
      return attachments
        ? await attachments.withLock(
            (session) => owner((db) => createWork(db, body, session), session.signal),
            signal,
          )
        : await owner((db) => createWork(db, body));
    } catch (error) {
      if (error instanceof WorkConflict)
        return refuse(error.message === "work_not_found" ? 404 : 409, error.message);
      throw error;
    }
  };
  return [
    create,
    route("GET", "/api/v1/tasks/{task_id}", 0, 200, async (db, id) => {
      await lockWorkTask(db, id);
      return workSnapshot(db, id);
    }),
    route("GET", "/api/v1/tasks/{task_id}/scope", 0, 200, async (db, id) => {
      const task = await lockWorkTask(db, id);
      const [row] =
        await db`SELECT scope,scope_digest FROM work_task_scopes WHERE task_id=${id} FOR SHARE`;
      if (!row) return { scope: null };
      if (
        row.scope.taskId !== id ||
        row.scope.botId !== task.bot_id ||
        workCanonical(row.scope).digest !== row.scope_digest
      )
        throw new WorkConflict("native_task_scope_changed");
      return {
        scope: {
          ...row.scope.request,
          sha256: row.scope_digest,
          attachments: row.scope.attachments,
        },
      };
    }),
    route("POST", "/api/v1/tasks/{task_id}/cancel", 128, 200, (db, id, body) => {
      workParse(cancelWorkInputSchema, body);
      return cancelWork(db, id);
    }),
    route("POST", "/api/v1/tasks/{task_id}/corrections", 32768, 202, (db, id, body) =>
      requestCorrection(db, id, workParse(correctWorkInputSchema, body)),
    ),
    route("POST", "/api/v1/actions/{action_id}/decision", 512, 200, decideWork),
    route("POST", "/api/v1/actions/{action_id}/reconcile", 4096, 202, (db, id, body) =>
      requestReconciliation(db, id, workParse(reconcileWorkInputSchema, body)),
    ),
    route("GET", "/api/v1/artifacts/{artifact_id}", 0, 200, async (db, id) => {
      const [artifact] = await db`SELECT * FROM work_artifacts WHERE id=${id}`;
      if (!artifact) throw new WorkConflict("work_not_found");
      await lockWorkTask(db, artifact.task_id);
      const bytes = files.read({ sha256: artifact.sha256, sizeBytes: Number(artifact.size_bytes) });
      return new ProductBytes(bytes, {
        "Content-Type": artifact.media_type,
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(artifact.name),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
    }),
  ];
}
