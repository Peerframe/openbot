import {
  type EngineSettings,
  EXECUTION_OWNER,
  observeEngineClosure,
  type TemporalEngine,
  WorkConflict,
} from "@openbot/work";
import { acceptedClosedWork } from "./work-execution.js";
import { type WorkTransactions, workEvent } from "./work-handoff.js";
import { loadWorkActions, type WorkLedger } from "./work-ledger.js";
import { finishWorkCancellation } from "./work-public.js";
import { WorkRepair } from "./work-repair.js";
import { cascadeWork } from "./work-tree.js";
import { workCanonical } from "./work-values.js";

/** Paged control observation closes proved dead Runs and submits existing repair commands.
 * Receipt settlement runs only inside Temporal; no replacement effects are authorized. */
export class WorkTerminal {
  private after = "";
  readonly repair: WorkRepair;
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
  ) {
    this.repair = new WorkRepair(transactions, ledger);
  }
  async poll(engine: TemporalEngine, settings: EngineSettings, signal: AbortSignal) {
    const candidates = await this.transactions.run(
      (db) => db`
      SELECT t.id AS task_id,r.id AS run_id,a.submission_attempt_id,a.engine_first_run_id
      FROM work_tasks t JOIN work_runs r ON r.task_id=t.id JOIN work_admissions a ON a.run_id=r.id
      WHERE a.execution_owner=${EXECUTION_OWNER} AND a.state='acknowledged' AND r.id>${this.after}
      AND ((t.status IN ('queued','open') AND r.status IN ('queued','running')
        AND NOT EXISTS(SELECT 1 FROM work_events e WHERE e.task_id=t.id AND e.kind='run.engine_terminal' AND e.payload->>'runId'=r.id))
        OR EXISTS(SELECT 1 FROM work_reconciliation_commands c JOIN work_actions x ON x.id=c.action_id
          WHERE x.run_id=r.id AND c.finished_at IS NULL))
      ORDER BY r.id LIMIT 16`,
    );
    for (const candidate of candidates) {
      if (signal.aborted) break;
      this.after = candidate.run_id;
      try {
        const proof = await observeEngineClosure(
          engine.client,
          settings,
          {
            taskId: candidate.task_id,
            runId: candidate.run_id,
            attemptId: candidate.submission_attempt_id,
          },
          candidate.engine_first_run_id,
          signal,
        );
        if (!proof) continue;
        await this.transactions.run(async (db) => {
          const task = await acceptedClosedWork(db, proof);
          const [prior] =
            await db`SELECT payload FROM work_events WHERE task_id=${task.id} AND kind='run.engine_terminal' AND payload->>'runId'=${proof.input.runId}`;
          const terminal = {
            namespace: proof.namespace,
            workflowId: proof.workflowId,
            engineRunId: proof.engineRunId,
            firstRunId: proof.firstRunId,
            closeEventId: proof.closeEventId,
            closeEventTime: proof.closeEventTime,
            closeEventType: proof.state,
            closeEventSha256: proof.closeEventSha256,
          };
          if (prior && workCanonical(prior.payload.proof).wire !== workCanonical(terminal).wire)
            throw new WorkConflict("terminal_proof_changed");
          // Hard-terminal projection never settles an effect. Only a real repair Activity
          // may look up and apply an already observed receipt after this closure.
          for (const action of (await loadWorkActions(db, task.id)).filter(
            (a) => a.run_id === proof.input.runId && a.status === "admitted",
          )) {
            await db`UPDATE work_actions SET status='unknown' WHERE id=${action.id}`;
            await workEvent(db, task.id, "action.unknown", { actionId: action.id });
          }
          await finishWorkCancellation(db, task.id);
          if (prior || ["completed", "failed", "cancelled"].includes(task.status)) return;
          const runs =
            await db`SELECT id,status FROM work_runs WHERE task_id=${task.id} ORDER BY ordinal FOR UPDATE`;
          if (
            runs.at(-1)?.id !== proof.input.runId ||
            runs
              .filter((r) => ["queued", "running"].includes(r.status))
              .some((r) => r.id !== proof.input.runId)
          )
            throw new WorkConflict("terminal_run_superseded");
          const unresolvedActions = (await loadWorkActions(db, task.id)).filter((a) =>
            ["admitted", "unknown"].includes(a.status),
          ).length;
          const reason = `engine_${proof.state.toLowerCase()}`;
          await cascadeWork(db, task.id, "failed", false);
          if (!task.cancel_requested) {
            await db`UPDATE work_tasks SET status='failed',authority_active=false,authority_generation=authority_generation+1 WHERE id=${task.id}`;
            await db`UPDATE work_runs SET status='failed' WHERE id=${proof.input.runId}`;
          } else if (task.authority_active)
            throw new WorkConflict("terminal_cancel_authority_invalid");
          const payload = {
            version: 1,
            reason: "engine_terminal",
            runId: proof.input.runId,
            proof: terminal,
            publicCode: reason,
            unresolvedActions,
          };
          if (!task.cancel_requested) await workEvent(db, task.id, "task.failed", payload);
          await workEvent(db, task.id, "run.engine_terminal", payload);
        });
        await this.repair.deliver(engine, settings, proof, signal);
      } catch {
        // Missing/untrusted history leaves durable obligations intact. Advance so one unavailable
        // Run cannot starve later records; the cursor wraps after this bounded scan completes.
      }
    }
    if (candidates.length < 16) this.after = "";
  }
}
