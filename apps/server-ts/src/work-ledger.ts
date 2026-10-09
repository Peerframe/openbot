import { randomUUID } from "node:crypto";
import { type ActivityBinding, WorkConflict } from "@openbot/work";
import { checkWorkApproval, workApprovalRequired } from "./work-approval.js";
import { checkWorkContext } from "./work-commands.js";
import { acceptedWork, checkWorkFence, type WorkFence } from "./work-execution.js";
import type { WorkBlob, WorkFiles } from "./work-files.js";
import {
  activeWorkTask,
  type WorkDb,
  type WorkTaskRow,
  type WorkTransactions,
  workEvent,
} from "./work-handoff.js";
import { workModelObservation } from "./work-model.js";
import { finishWorkCancellation, workUsage } from "./work-public.js";
import { workTreeBudget } from "./work-tree.js";
import { type WorkJson, workCanonical } from "./work-values.js";

export type WorkAction = {
  id: string;
  task_id: string;
  run_id: string;
  action_key: string;
  intent: Record<string, WorkJson>;
  intent_digest: string;
  authority_generation: string;
  correction_context_id: string;
  baseline_requires_approval: boolean;
  requires_approval: boolean;
  decision: string;
  status: string;
  reserved_tokens: string;
  actual_tokens: string | null;
  evidence: Record<string, string> | null;
  unexpired: boolean;
};
export type WorkScope = { binding: ActivityBinding; fence: WorkFence; contextId: string };
export async function currentWork(db: WorkDb, scope: WorkScope) {
  const task = await acceptedWork(db, scope.binding);
  await checkWorkFence(db, scope.fence);
  await checkWorkContext(db, task, scope.binding.input.runId, scope.contextId);
  const [bot] =
    await db`SELECT id FROM bots WHERE id=${task.bot_id} AND deleted_at IS NULL FOR SHARE`;
  if (!bot) throw new WorkConflict("product_task_bot_missing");
  return task;
}
export async function loadWorkActions(db: WorkDb, taskId: string): Promise<WorkAction[]> {
  const actions = await db<
    WorkAction[]
  >`SELECT *,expires_at>clock_timestamp() AS unexpired FROM work_actions WHERE task_id=${taskId} ORDER BY created_at,id LIMIT 257`;
  if (actions.length > 256) throw new WorkConflict("action_limit");
  for (const action of actions) {
    if (workCanonical(action.intent).digest !== action.intent_digest)
      throw new WorkConflict("action_content_changed");
  }
  return actions;
}
export class WorkLedger {
  restoreTool?: (db: WorkDb, action: WorkAction) => Promise<WorkJson | null>;
  constructor(
    readonly transactions: WorkTransactions,
    readonly files: WorkFiles,
  ) {}
  async propose(
    scope: WorkScope,
    key: string,
    intent: Record<string, WorkJson>,
    tokens: number,
    requiresApproval: boolean,
    guard?: (db: WorkDb) => Promise<void>,
  ): Promise<WorkAction> {
    const encoded = workCanonical(intent);
    return this.transactions.run(async (db) => {
      const task = await currentWork(db, scope);
      const actions = await loadWorkActions(db, task.id);
      const prior = actions.find(
        (a) => a.run_id === scope.binding.input.runId && a.action_key === key,
      );
      if (prior) {
        if (
          prior.intent_digest !== encoded.digest ||
          Number(prior.reserved_tokens) !== tokens ||
          prior.baseline_requires_approval !== requiresApproval ||
          prior.correction_context_id !== scope.contextId
        )
          throw new WorkConflict("action_content_changed");
        return prior;
      }
      if (
        actions.length >= 256 ||
        !Number.isSafeInteger(tokens) ||
        tokens < 0 ||
        tokens > 1_000_000_000
      )
        throw new WorkConflict("action_limit");
      await guard?.(db);
      const required = await workApprovalRequired(db, task.bot_id, intent, requiresApproval);
      const [row] = await db<
        WorkAction[]
      >`INSERT INTO work_actions(id,task_id,run_id,action_key,intent,intent_digest,authority_generation,
        requires_approval,baseline_requires_approval,decision,expires_at,reserved_tokens,correction_context_id)
        VALUES(${randomUUID()},${task.id},${scope.binding.input.runId},${key},${db.json(intent)}::jsonb,${encoded.digest},${task.authority_generation},
          ${required},${requiresApproval},${required ? "pending" : "not_required"},clock_timestamp()+interval '300 seconds',${tokens},${scope.contextId}) RETURNING *,true AS unexpired`;
      await workEvent(db, task.id, "action.proposed", {
        actionId: row!.id,
        intentDigest: encoded.digest,
      });
      await checkWorkFence(db, scope.fence);
      return row!;
    });
  }
  async admit(
    scope: WorkScope,
    id: string,
    guard: (db: WorkDb, action: WorkAction) => Promise<void>,
  ): Promise<boolean> {
    return this.transactions.run(async (db) => {
      const task = await currentWork(db, scope);
      const action = (await loadWorkActions(db, task.id)).find(
        (a) => a.id === id && a.run_id === scope.binding.input.runId,
      );
      if (!action || action.correction_context_id !== scope.contextId)
        throw new WorkConflict("action_context_changed");
      if (action.status !== "proposed") return false;
      if (
        !action.unexpired ||
        String(action.authority_generation) !== String(task.authority_generation) ||
        !["approved", "not_required"].includes(action.decision)
      )
        throw new WorkConflict("action_not_authorized");
      const usage = await workUsage(db, task.id);
      if (
        usage.reservedTokens + usage.spentTokens + Number(action.reserved_tokens) >
        Number(task.token_limit)
      )
        throw new WorkConflict("token_budget_exhausted");
      const root = await workTreeBudget(db, task);
      if (root.reserved + root.spent + Number(action.reserved_tokens) > root.limit)
        throw new WorkConflict("root_token_budget_exhausted");
      await checkWorkApproval(db, task.bot_id, action);
      await guard(db, action);
      await db`UPDATE work_actions SET status='admitted' WHERE id=${id}`;
      await workEvent(db, task.id, "action.admitted", {
        actionId: id,
        reservedTokens: Number(action.reserved_tokens),
      });
      await checkWorkFence(db, scope.fence);
      return true;
    });
  }
  async fresh(
    scope: WorkScope,
    id: string,
    guard?: (db: WorkDb, action: WorkAction) => Promise<void>,
  ) {
    return this.transactions.run(async (db) => {
      const task = await currentWork(db, scope);
      const action = (await loadWorkActions(db, task.id)).find(
        (a) => a.id === id && a.run_id === scope.binding.input.runId,
      );
      if (
        !action ||
        action.status !== "admitted" ||
        !action.unexpired ||
        action.correction_context_id !== scope.contextId ||
        String(action.authority_generation) !== String(task.authority_generation)
      )
        throw new WorkConflict("action_not_admitted");
      await checkWorkApproval(db, task.bot_id, action);
      await guard?.(db, action);
      await checkWorkFence(db, scope.fence);
    });
  }
  async unknown(binding: ActivityBinding, id: string) {
    await this.transactions.run(async (db) => {
      const task = await acceptedWork(db, binding, true);
      const [row] =
        await db`UPDATE work_actions SET status='unknown' WHERE id=${id} AND task_id=${task.id} AND run_id=${binding.input.runId}
        AND status='admitted' RETURNING id`;
      if (row) await workEvent(db, task.id, "action.unknown", { actionId: id });
    });
  }
  readReceipt(db: WorkDb, action: WorkAction, kind: "model" | "tool") {
    return kind === "model"
      ? db`SELECT * FROM work_model_receipts WHERE action_id=${action.id}`
      : db`SELECT * FROM work_tool_results WHERE action_id=${action.id}`;
  }
  async observed(db: WorkDb, action: WorkAction, kind: "model" | "tool"): Promise<WorkJson | null> {
    const [row] = await this.readReceipt(db, action, kind);
    if (!row) return null;
    const codec = kind === "model" ? "openbot-ts-model-response-v1" : "openbot-tool-json-v1";
    if (
      row.task_id !== action.task_id ||
      row.run_id !== action.run_id ||
      row.intent_digest !== action.intent_digest ||
      row.codec !== codec
    )
      throw new WorkConflict("work_receipt_changed");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        this.files.read({ sha256: row.sha256, sizeBytes: Number(row.size_bytes) }),
      ),
    ) as WorkJson;
    if (
      kind === "model" &&
      workModelObservation.parse(value).actualTokens !== Number(row.actual_tokens)
    )
      throw new WorkConflict("model_usage_changed");
    return value;
  }
  /** Only a trusted adapter calls this with its observed response. Late truth cannot authorize another effect. */
  async record(
    binding: ActivityBinding,
    action: WorkAction,
    kind: "model" | "tool",
    value: WorkJson,
  ): Promise<void> {
    const actualTokens = kind === "model" ? workModelObservation.parse(value).actualTokens : 0;
    const encoded = workCanonical(value, kind === "model" ? 2097152 : 131072);
    const blob = this.files.put(Buffer.from(encoded.wire));
    await this.transactions.run(async (db) => {
      const task = await acceptedWork(db, binding, true);
      const current = (await loadWorkActions(db, task.id)).find(
        (a) => a.id === action.id && a.run_id === binding.input.runId,
      );
      if (
        !current ||
        current.intent_digest !== action.intent_digest ||
        !["admitted", "unknown", "applied"].includes(current.status)
      )
        throw new WorkConflict("action_not_admitted");
      await checkWorkContext(db, task, current.run_id, current.correction_context_id, false);
      const [prior] = await this.readReceipt(db, current, kind);
      if (prior) {
        if (prior.sha256 !== blob.sha256 || Number(prior.size_bytes) !== blob.sizeBytes)
          throw new WorkConflict("work_receipt_changed");
        await this.observed(db, current, kind);
      } else if (kind === "model") {
        await db`INSERT INTO work_model_receipts(action_id,task_id,run_id,intent_digest,codec,sha256,size_bytes,actual_tokens)
          VALUES(${current.id},${task.id},${current.run_id},${current.intent_digest},'openbot-ts-model-response-v1',${blob.sha256},${blob.sizeBytes},${actualTokens})`;
      } else {
        await db`INSERT INTO work_tool_results(action_id,task_id,run_id,intent_digest,codec,sha256,size_bytes)
          VALUES(${current.id},${task.id},${current.run_id},${current.intent_digest},'openbot-tool-json-v1',${blob.sha256},${blob.sizeBytes})`;
      }
      // Immutable bytes and their SQL reference precede settlement in the same commit.
      // Effect adapters must independently validate semantic receipts before calling record.
      await this.resolve(db, current, blob, actualTokens, kind);
      await finishWorkCancellation(db, task.id);
    });
  }
  private async resolve(
    db: WorkDb,
    action: WorkAction,
    blob: WorkBlob,
    actualTokens: number,
    kind: "model" | "tool",
  ) {
    const evidence = {
      source: kind === "model" ? "model_receipt" : "tool_response",
      reference: action.id,
      sha256: blob.sha256,
    };
    if (action.status === "applied") {
      if (
        Number(action.actual_tokens) !== actualTokens ||
        workCanonical(action.evidence).wire !== workCanonical(evidence).wire
      )
        throw new WorkConflict("outcome_already_recorded");
      return;
    }
    await db`UPDATE work_actions SET status='applied',actual_tokens=${actualTokens},evidence=${db.json(evidence)}::jsonb WHERE id=${action.id}`;
    await workEvent(db, action.task_id, "action.resolved", {
      actionId: action.id,
      outcome: "applied",
      actualTokens,
      evidence,
    });
    const commands =
      await db`UPDATE work_reconciliation_commands SET outcome='resolved',finished_at=clock_timestamp()
      WHERE action_id=${action.id} AND finished_at IS NULL RETURNING id`;
    for (const command of commands)
      await workEvent(db, action.task_id, "reconciliation.finished", {
        commandId: command.id,
        actionId: action.id,
        outcome: "resolved",
      });
  }
  async recover(binding: ActivityBinding) {
    return this.transactions.run(async (db) => {
      const task = await acceptedWork(db, binding, true);
      return this.recoverRecorded(db, task, binding.input.runId, binding.workflowId);
    });
  }
  /** Caller has locked and verified the accepted Run. Reads local immutable receipts only. */
  async recoverRecorded(
    db: WorkDb,
    task: WorkTaskRow,
    runId: string,
    deliveryReference: string,
    onlyAction?: string,
  ) {
    const actions = await loadWorkActions(db, task.id);
    for (const action of actions.filter(
      (a) =>
        a.run_id === runId &&
        (!onlyAction || a.id === onlyAction) &&
        ["admitted", "unknown"].includes(a.status),
    )) {
      await checkWorkContext(db, task, action.run_id, action.correction_context_id, false);
      const kind = action.intent.kind === "model" ? "model" : "tool";
      let value = await this.observed(db, action, kind);
      if (value === null && kind === "tool" && this.restoreTool) {
        value = await this.restoreTool(db, action);
        if (value !== null) {
          const blob = this.files.put(Buffer.from(workCanonical(value, 131072).wire));
          await db`INSERT INTO work_tool_results(action_id,task_id,run_id,intent_digest,codec,sha256,size_bytes)
            VALUES(${action.id},${action.task_id},${action.run_id},${action.intent_digest},'openbot-tool-json-v1',${blob.sha256},${blob.sizeBytes})`;
        }
      }
      if (value !== null) {
        const encoded = workCanonical(value, kind === "model" ? 2097152 : 131072);
        await this.resolve(
          db,
          action,
          { sha256: encoded.digest, sizeBytes: Buffer.byteLength(encoded.wire) },
          kind === "model" ? workModelObservation.parse(value).actualTokens : 0,
          kind,
        );
      } else {
        if (action.status === "admitted") {
          await db`UPDATE work_actions SET status='unknown' WHERE id=${action.id}`;
          await workEvent(db, task.id, "action.unknown", { actionId: action.id });
        }
        const commands =
          await db`UPDATE work_reconciliation_commands SET outcome='unresolved',finished_at=clock_timestamp(),delivered_at=clock_timestamp(),
            delivery_reference=${deliveryReference} WHERE action_id=${action.id} AND finished_at IS NULL RETURNING id`;
        for (const command of commands)
          await workEvent(db, task.id, "reconciliation.finished", {
            commandId: command.id,
            actionId: action.id,
            outcome: "unresolved",
          });
      }
    }
    await finishWorkCancellation(db, task.id);
    const remaining = (await loadWorkActions(db, task.id)).some((a) =>
      ["admitted", "unknown"].includes(a.status),
    );
    if (!remaining && task.cancel_requested) return "cancelled" as const;
    if (["completed", "cancelled", "failed"].includes(task.status))
      return task.status as "completed" | "cancelled" | "failed";
    if (remaining || !task.authority_active) return "waiting" as const;
    activeWorkTask(task);
    return "continue" as const;
  }
}
