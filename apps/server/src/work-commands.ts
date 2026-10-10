/** Validates public Work mutations and applies them under the existing task authority. */
import { randomUUID } from "node:crypto";
import { WorkConflict } from "@openbot/work";
import {
  activeWorkTask,
  lockWorkTask,
  type WorkDb,
  type WorkTaskRow,
  workEvent,
} from "./work-handoff.js";
import { reconciliationView, workAction, workDate } from "./work-public.js";
import { workCanonical, workText } from "./work-values.js";

type CorrectionInput = {
  runId: string;
  instruction: string;
  requestKey: string;
  expectedSequence: number;
};
function correctionView(row: Record<string, unknown>) {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    sequence: row.sequence,
    requestedBy: row.requested_by,
    instruction: row.instruction,
    generation: Number(row.generation),
    createdAt: workDate(row.created_at as Date),
  };
}
export async function requestCorrection(
  db: WorkDb,
  taskId: string,
  value: CorrectionInput,
  source = false,
) {
  workText(value.runId, 128);
  workText(value.instruction, source ? 16384 : 4096);
  workText(value.requestKey, 128);
  const digest = workCanonical(
    {
      taskId,
      runId: value.runId,
      instruction: value.instruction,
      expectedSequence: value.expectedSequence,
    },
    131072,
  ).digest;
  const task = await lockWorkTask(db, taskId);
  const [run] = await db`SELECT * FROM work_runs WHERE task_id=${taskId} AND id=${value.runId}`;
  if (!run) throw new WorkConflict("work_not_found");
  const [prior] =
    await db`SELECT * FROM work_corrections WHERE task_id=${taskId} AND request_key=${value.requestKey}`;
  if (prior) {
    if (prior.request_digest !== digest) throw new WorkConflict("correction_content_changed");
    return correctionView(prior);
  }
  activeWorkTask(task);
  if (!run.corrections_enabled) throw new WorkConflict("corrections_unsupported");
  if (!["queued", "running"].includes(run.status)) throw new WorkConflict("run_closed");
  const [latest] =
    await db`SELECT coalesce(max(sequence),0) AS sequence FROM work_corrections WHERE task_id=${taskId} AND run_id=${value.runId}`;
  const sequence = Number(latest!.sequence),
    generation = Number(task.authority_generation) + 1;
  if (sequence !== value.expectedSequence) throw new WorkConflict("correction_sequence_changed");
  if (sequence >= 8) throw new WorkConflict("correction_limit");
  const [row] =
    await db`INSERT INTO work_corrections(id,task_id,run_id,sequence,request_key,request_digest,requested_by,instruction,generation)
    VALUES(${randomUUID()},${taskId},${value.runId},${sequence + 1},${value.requestKey},${digest},'owner',${value.instruction},${generation}) RETURNING *`;
  await db`UPDATE work_tasks SET authority_generation=${generation} WHERE id=${taskId}`;
  const superseded =
    await db`UPDATE work_actions a SET status='superseded',superseded_by=${row!.id} WHERE a.task_id=${taskId}
    AND a.status='proposed' AND a.decision<>'denied' AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.task_id=a.task_id
      AND e.kind='action.admitted' AND e.payload->>'actionId'=a.id) RETURNING a.id`;
  await workEvent(db, taskId, "correction.requested", {
    correctionId: row!.id,
    runId: value.runId,
    sequence: sequence + 1,
    generation,
    supersededActionIds: superseded.map((x) => x.id),
  });
  return correctionView(row!);
}
export type CorrectionContext = {
  id: string;
  generation: number;
  corrections: { id: string; instruction: string }[];
};
async function currentCorrections(db: WorkDb, taskId: string, runId: string) {
  const rows =
    await db`SELECT id,instruction FROM work_corrections WHERE task_id=${taskId} AND run_id=${runId} ORDER BY sequence`;
  return rows.map((row) => ({ id: String(row.id), instruction: String(row.instruction) }));
}
function contextDigest(
  taskId: string,
  runId: string,
  generation: number,
  corrections: CorrectionContext["corrections"],
) {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    corrections.length > 8 ||
    new Set(corrections.map((c) => c.id)).size !== corrections.length
  )
    throw new WorkConflict("correction_context_corrupt");
  for (const correction of corrections) {
    workText(correction.id, 128);
    workText(correction.instruction, 16384);
  }
  return workCanonical({ taskId, runId, generation, corrections }, 262144).digest;
}
export async function checkWorkContext(
  db: WorkDb,
  task: WorkTaskRow,
  runId: string,
  id: string,
  current = true,
): Promise<CorrectionContext> {
  const [row] =
    await db`SELECT c.*,r.corrections_enabled FROM work_correction_contexts c JOIN work_runs r ON r.id=c.run_id
    WHERE c.id=${id} AND c.task_id=${task.id} AND c.run_id=${runId}`;
  if (
    !row?.corrections_enabled ||
    row.content_digest !== contextDigest(task.id, runId, Number(row.generation), row.corrections)
  )
    throw new WorkConflict("correction_context_corrupt");
  if (
    current &&
    (Number(row.generation) !== Number(task.authority_generation) ||
      workCanonical(row.corrections, 262144).wire !==
        workCanonical(await currentCorrections(db, task.id, runId), 262144).wire)
  )
    throw new WorkConflict("corrections_changed");
  return { id, generation: Number(row.generation), corrections: row.corrections };
}
export async function freezeWorkContext(
  db: WorkDb,
  task: WorkTaskRow,
  runId: string,
): Promise<CorrectionContext> {
  const generation = Number(task.authority_generation),
    key = "ts-v1:g" + generation;
  const [prior] =
    await db`SELECT id FROM work_correction_contexts WHERE run_id=${runId} AND checkpoint_key=${key}`;
  if (prior) return checkWorkContext(db, task, runId, prior.id);
  activeWorkTask(task);
  const corrections = await currentCorrections(db, task.id, runId),
    id = randomUUID();
  const digest = contextDigest(task.id, runId, generation, corrections);
  await db`INSERT INTO work_correction_contexts(id,task_id,run_id,checkpoint_key,generation,corrections,content_digest)
    VALUES(${id},${task.id},${runId},${key},${generation},${db.json(corrections)}::jsonb,${digest})`;
  return { id, generation, corrections };
}

type ReconcileInput = {
  intentDigest: string;
  requestKey: string;
  expectedSequence: number;
  reason: string;
};
export async function requestReconciliation(db: WorkDb, actionId: string, value: ReconcileInput) {
  workText(value.requestKey, 128);
  workText(value.reason, 512);
  const digest = workCanonical({
    actionId,
    intentDigest: value.intentDigest,
    expectedSequence: value.expectedSequence,
    reason: value.reason,
  }).digest;
  const { task, action } = await workAction(db, actionId);
  const [prior] =
    await db`SELECT c.*,r.request_digest AS replay_digest FROM work_reconciliation_requests r
    JOIN work_reconciliation_commands c ON c.id=r.command_id WHERE r.request_key=${value.requestKey}`;
  if (prior) {
    if (prior.replay_digest !== digest) throw new WorkConflict("reconciliation_content_changed");
    return reconciliationView(prior);
  }
  if (action.intent_digest !== value.intentDigest)
    throw new WorkConflict("reconciliation_intent_changed");
  if (action.status !== "unknown") throw new WorkConflict("reconciliation_unavailable");
  const [latest] =
    await db`SELECT * FROM work_reconciliation_commands WHERE action_id=${actionId} ORDER BY sequence DESC LIMIT 1`;
  const sequence = latest ? Number(latest.sequence) : 0;
  let command = latest;
  if (latest && latest.finished_at === null) {
    if (![sequence - 1, sequence].includes(value.expectedSequence))
      throw new WorkConflict("reconciliation_stale");
  } else {
    if (value.expectedSequence !== sequence) throw new WorkConflict("reconciliation_stale");
    if (sequence >= 64) throw new WorkConflict("reconciliation_limit");
    [command] =
      await db`INSERT INTO work_reconciliation_commands(id,action_id,intent_digest,sequence,requested_by,reason)
      VALUES(${randomUUID()},${actionId},${value.intentDigest},${sequence + 1},'owner',${value.reason}) RETURNING *`;
    await workEvent(db, task.id, "reconciliation.requested", {
      commandId: command!.id,
      actionId,
      sequence: sequence + 1,
      intentDigest: value.intentDigest,
      requestedBy: "owner",
      reason: value.reason,
    });
  }
  const inserted =
    await db`INSERT INTO work_reconciliation_requests(request_key,request_digest,command_id)
    VALUES(${value.requestKey},${digest},${command!.id}) ON CONFLICT(request_key) DO NOTHING RETURNING request_key`;
  if (!inserted.length) {
    const [old] =
      await db`SELECT request_digest,command_id FROM work_reconciliation_requests WHERE request_key=${value.requestKey}`;
    if (old?.request_digest !== digest || old.command_id !== command!.id)
      throw new WorkConflict("reconciliation_content_changed");
  }
  return reconciliationView(command!);
}
