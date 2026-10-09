import {
  currentRepairBinding,
  dispatchRepair,
  type EngineClosure,
  type EngineSettings,
  observeEngineClosure,
  type RepairStart,
  type TemporalEngine,
  WorkConflict,
} from "@openbot/work";
import { acceptedClosedWork } from "./work-execution.js";
import { type WorkDb, type WorkTransactions, workEvent } from "./work-handoff.js";
import { loadWorkActions, type WorkLedger } from "./work-ledger.js";

/** Closed recovery remains a finite Temporal Activity. Control only submits the durable command. */
export class WorkRepair {
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
  ) {}
  private async command(db: WorkDb, proof: EngineClosure, input: RepairStart) {
    const task = await acceptedClosedWork(db, proof),
      action = (await loadWorkActions(db, task.id)).find(
        (a) => a.id === input.actionId && a.run_id === input.runId,
      );
    const [command] =
      await db`SELECT * FROM work_reconciliation_commands WHERE id=${input.commandId} AND action_id=${input.actionId} FOR UPDATE`;
    if (
      !action ||
      !command ||
      command.intent_digest !== action.intent_digest ||
      input.taskId !== proof.input.taskId ||
      input.runId !== proof.input.runId
    )
      throw new WorkConflict("repair_command_changed");
    return { task, action, command };
  }
  async deliver(
    engine: TemporalEngine,
    settings: EngineSettings,
    proof: EngineClosure,
    signal: AbortSignal,
  ) {
    const rows = await this.transactions.run(async (db) => {
      await acceptedClosedWork(db, proof);
      return db`SELECT c.id,c.action_id FROM work_reconciliation_commands c JOIN work_actions a ON a.id=c.action_id WHERE a.task_id=${proof.input.taskId} AND a.run_id=${proof.input.runId} AND c.finished_at IS NULL ORDER BY c.created_at,c.id LIMIT 16`;
    });
    for (const row of rows) {
      if (signal.aborted) break;
      const input = {
        taskId: proof.input.taskId,
        runId: proof.input.runId,
        actionId: String(row.action_id),
        commandId: String(row.id),
      };
      try {
        const dispatch = await engine.client.withAbortSignal(
          AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          () => dispatchRepair(engine.client, settings, input),
        );
        await this.transactions.run(async (db) => {
          const { task, action, command } = await this.command(db, proof, input);
          if (command.finished_at) return;
          if (command.delivery_reference && command.delivery_reference !== dispatch.workflowId)
            throw new WorkConflict("repair_delivery_changed");
          await db`UPDATE work_reconciliation_commands SET delivery_reference=${dispatch.workflowId},delivered_at=coalesce(delivered_at,clock_timestamp()) WHERE id=${input.commandId}`;
          if (dispatch.closed) {
            // Engine closure is not effect success. This only closes a lookup cycle using
            // already committed Action state; reservations and effects are left intact.
            const outcome = ["applied", "not_applied"].includes(action.status)
              ? "resolved"
              : "unresolved";
            await db`UPDATE work_reconciliation_commands SET outcome=${outcome},finished_at=clock_timestamp() WHERE id=${input.commandId}`;
            await workEvent(db, task.id, "reconciliation.finished", {
              commandId: input.commandId,
              actionId: input.actionId,
              outcome,
            });
          }
        });
      } catch {
        /* The persisted command remains visible and eligible for a later bounded pass. */
      }
    }
  }
  async execute(
    engine: TemporalEngine,
    settings: EngineSettings,
    input: RepairStart,
    signal: AbortSignal,
  ) {
    const reference = await currentRepairBinding(engine.client, settings, input);
    const [row] = await this.transactions.run(
      (db) =>
        db`SELECT a.submission_attempt_id,a.engine_first_run_id FROM work_admissions a JOIN work_runs r ON r.id=a.run_id WHERE r.id=${input.runId} AND r.task_id=${input.taskId} AND a.execution_owner='typescript-v1' AND a.state='acknowledged'`,
    );
    if (!row) throw new WorkConflict("repair_original_unbound");
    const proof = await observeEngineClosure(
      engine.client,
      settings,
      { taskId: input.taskId, runId: input.runId, attemptId: row.submission_attempt_id },
      row.engine_first_run_id,
      signal,
    );
    if (!proof) throw new WorkConflict("repair_original_still_running");
    await this.transactions.run(async (db) => {
      const { task, command } = await this.command(db, proof, input);
      if (command.finished_at) return;
      if (command.delivery_reference && command.delivery_reference !== reference)
        throw new WorkConflict("repair_delivery_changed");
      await db`UPDATE work_reconciliation_commands SET delivery_reference=${reference},delivered_at=coalesce(delivered_at,clock_timestamp()) WHERE id=${input.commandId}`;
      await this.ledger.recoverRecorded(db, task, input.runId, reference, input.actionId);
    });
  }
}
