import { createHash } from "node:crypto";
import {
  type ActivityBinding,
  assertEngineClosure,
  type EngineClosure,
  EXECUTION_OWNER,
  engineReference,
  HandoffPending,
  WorkConflict,
} from "@openbot/work";
import {
  activeWorkTask,
  lockWorkTask,
  type WorkDb,
  type WorkTaskRow,
  type WorkTransactions,
  workEvent,
} from "./work-handoff.js";

export type WorkFence = { runId: string; claimId: string; epoch: number };
/** Called only with facts derived inside a real remote Activity by currentBinding(). */
export async function acceptedWork(
  db: WorkDb,
  binding: ActivityBinding,
  historical = false,
): Promise<WorkTaskRow> {
  return acceptedExecution(db, binding, historical);
}
/** Engine history proves closure, never a permission to dispatch an Activity effect. */
export async function acceptedClosedWork(db: WorkDb, proof: EngineClosure) {
  assertEngineClosure(proof);
  return acceptedExecution(db, proof, true);
}
async function acceptedExecution(
  db: WorkDb,
  binding: Pick<ActivityBinding, "input" | "namespace" | "firstRunId">,
  historical: boolean,
): Promise<WorkTaskRow> {
  const { input } = binding;
  const task = await lockWorkTask(db, input.taskId);
  const rows =
    await db`SELECT a.*,r.status AS run_status FROM work_admissions a JOIN work_runs r ON r.id=a.run_id
    WHERE r.task_id=${input.taskId} AND r.id=${input.runId}`;
  const row = rows[0];
  if (!row || row.execution_owner !== EXECUTION_OWNER)
    throw new WorkConflict("handoff_execution_owner_mismatch");
  const reference = engineReference(binding.namespace, input.runId);
  if (row.state !== "acknowledged") throw new HandoffPending("handoff_not_acknowledged");
  if (row.submission_reference !== reference || row.engine_reference !== reference)
    throw new WorkConflict("handoff_reference_changed");
  if (row.submission_attempt_id !== input.attemptId)
    throw new WorkConflict("handoff_attempt_changed");
  if (row.engine_first_run_id !== binding.firstRunId)
    throw new WorkConflict("handoff_engine_run_changed");
  if (!historical) {
    activeWorkTask(task);
    if (!["queued", "running"].includes(row.run_status)) throw new WorkConflict("run_closed");
  }
  return task;
}
export async function checkWorkFence(db: WorkDb, fence: WorkFence): Promise<void> {
  const rows = await db`SELECT r.execution_epoch,c.epoch,c.expires_at>clock_timestamp() AS live
    FROM work_runs r JOIN work_claims c ON c.run_id=r.id WHERE r.id=${fence.runId} AND c.claim_id=${fence.claimId}`;
  const row = rows[0];
  if (
    !Number.isInteger(fence.epoch) ||
    fence.epoch < 1 ||
    fence.epoch > 10000 ||
    !row?.live ||
    Number(row.epoch) !== fence.epoch ||
    Number(row.execution_epoch) !== fence.epoch
  )
    throw new WorkConflict("execution_claim_stale");
  // This final clock check also runs after a transaction writes its own completed status.
  const expired =
    await db`SELECT 1 FROM work_collaborations c JOIN work_runs r ON r.id=${fence.runId}
    WHERE (c.child_task_id=r.task_id OR c.root_task_id=r.task_id) AND c.deadline_at<=clock_timestamp() LIMIT 1`;
  if (expired.length) throw new WorkConflict("collaboration_deadline_expired");
}
export class WorkExecution {
  constructor(readonly transactions: WorkTransactions) {}
  async claim(binding: ActivityBinding, commandRuntime = false): Promise<WorkFence> {
    // SDK Activity attempts are distinct writers; retry can supersede a crashed writer but
    // never renew its old claim, reservation or permission to send an admitted effect.
    const claimId = createHash("sha256")
      .update(JSON.stringify([binding.engineRunId, binding.activityId, binding.activityAttempt]))
      .digest("hex");
    return this.transactions.run(async (db) => {
      await acceptedWork(db, binding);
      const runId = binding.input.runId;
      const rows = await db`SELECT execution_epoch FROM work_runs WHERE id=${runId} FOR UPDATE`;
      const existing =
        await db`SELECT epoch FROM work_claims WHERE run_id=${runId} AND claim_id=${claimId}`;
      if (existing[0]) {
        const fence = { runId, claimId, epoch: Number(existing[0].epoch) };
        await checkWorkFence(db, fence);
        return fence;
      }
      const epoch = Number(rows[0]?.execution_epoch) + 1;
      if (!Number.isInteger(epoch) || epoch > 10000) throw new WorkConflict("attempt_limit");
      await db`UPDATE work_runs SET execution_epoch=${epoch},status='running' WHERE id=${runId}`;
      const command =
        commandRuntime &&
        (
          await db`SELECT 1 FROM work_actions a JOIN work_command_profiles p ON p.task_id=a.task_id WHERE a.run_id=${runId} AND a.status='proposed' AND a.intent->>'tool'='run_command' AND a.requires_approval AND a.decision IN ('pending','approved') AND a.expires_at>clock_timestamp() LIMIT 1`
        ).length > 0;
      // A pending command can be approved while this Activity reads its state. Reserve the
      // retained preparation/runtime/stop envelope for that claim too; approval is still
      // independently required before preparation. Existing claims keep their original expiry.
      await db`INSERT INTO work_claims(run_id,claim_id,epoch,expires_at)
        VALUES (${runId},${claimId},${epoch},clock_timestamp()+${command ? 120 : 60}*interval '1 second')`;
      await db`UPDATE work_tasks SET status='open' WHERE id=${binding.input.taskId}`;
      await workEvent(db, binding.input.taskId, "run.claimed", { runId, epoch });
      const fence = { runId, claimId, epoch };
      await checkWorkFence(db, fence);
      return fence;
    });
  }
}
