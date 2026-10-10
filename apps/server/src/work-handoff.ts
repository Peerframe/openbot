/** Persists Work admission and reconciliation facts without repeating unknown engine starts. */
import { databasePool } from "./database-pool.js";
import { randomBytes } from "node:crypto";
import {
  EXECUTION_OWNER,
  HandoffPending,
  type HandoffPort,
  type PriorSubmission,
  type Reservation,
  validAttempt,
  WorkConflict,
  type WorkIdentity,
  workIdentity,
} from "@openbot/work";
import postgres from "postgres";
import { boundedAdmission } from "./request-limits.js";
import { activeWorkTree, lockWorkTree } from "./work-tree.js";

export type WorkDb = postgres.TransactionSql;
export type WorkTaskRow = {
  id: string;
  bot_id: string;
  objective: string;
  result_summary: string | null;
  status: string;
  authority_active: boolean;
  cancel_requested: boolean;
  authority_generation: string;
  token_limit: string;
  revision: string;
};
export const lockWorkTask = lockWorkTree;
export function activeWorkTask(task: WorkTaskRow): void {
  activeWorkTree(task);
  if (
    !task.authority_active ||
    task.cancel_requested ||
    !["queued", "open"].includes(task.status)
  ) {
    throw new WorkConflict("task_closed");
  }
}
export async function workEvent(
  db: WorkDb,
  taskId: string,
  kind: string,
  payload: postgres.JSONValue,
): Promise<void> {
  const rows =
    await db`UPDATE work_tasks SET revision=revision+1 WHERE id=${taskId} RETURNING revision`;
  if (!rows[0]) throw new WorkConflict("work_not_found");
  await db`INSERT INTO work_events(task_id,revision,kind,payload) VALUES (${taskId},${rows[0].revision},${kind},${db.json(payload)}::jsonb)`;
}
export function workTransactions(databaseUrl: string) {
  const pool = databasePool(databaseUrl);
  const sql = pool.sql;
  const admit = boundedAdmission(16, { waitForSettlement: true, committedResult: true });
  return {
    run: async <T>(operation: (db: WorkDb) => Promise<T>): Promise<T> => {
      const outcome = await admit(AbortSignal.timeout(6000), async (check) => {
        try {
          const value = await sql.begin(async (db) => {
            check();
            const result = await operation(db);
            check();
            return result;
          });
          return { value: value as T };
        } catch (error) {
          // Preserve domain refusals only after SQL has rolled back. Transport failures retain
          // the existing bounded, redacted storage envelope shared by the TS control pool.
          if (error instanceof WorkConflict || error instanceof HandoffPending)
            return { failure: error };
          throw error;
        }
      });
      if ("failure" in outcome) throw outcome.failure;
      return outcome.value;
    },
    close: () => pool.close(),
  };
}
export type WorkTransactions = ReturnType<typeof workTransactions>;
type Admission = {
  execution_owner: string;
  state: string;
  run_status: string;
  engine_reference: string | null;
  submission_reference: string | null;
  submission_attempt_id: string | null;
  engine_first_run_id: string | null;
};
async function admission(db: WorkDb, identity: WorkIdentity): Promise<Admission> {
  const rows = await db<
    Admission[]
  >`SELECT a.*,r.status AS run_status FROM work_admissions a JOIN work_runs r ON r.id=a.run_id
    WHERE r.task_id=${identity.taskId} AND r.id=${identity.runId} FOR UPDATE OF r,a`;
  if (!rows[0]) throw new WorkConflict("work_not_found");
  if (rows[0].execution_owner !== EXECUTION_OWNER)
    throw new WorkConflict("handoff_execution_owner_mismatch");
  return rows[0];
}
export class WorkHandoff implements HandoffPort {
  constructor(readonly transactions: WorkTransactions) {}
  async pending(limit = 32, after = ""): Promise<WorkIdentity[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 128 ||
      typeof after !== "string" ||
      after.length > 128 ||
      after.includes("\0")
    )
      throw new WorkConflict("invalid_handoff_limit");
    return this.transactions.run(async (db) => {
      const rows =
        await db`SELECT t.id AS task_id,r.id AS run_id FROM work_tasks t JOIN work_runs r ON r.task_id=t.id
        JOIN work_admissions a ON a.run_id=r.id WHERE a.execution_owner=${EXECUTION_OWNER}
        AND t.authority_active AND NOT t.cancel_requested AND t.status IN ('queued','open')
        AND r.status IN ('queued','running') AND a.state='pending' AND a.submission_attempted_at IS NULL
        AND r.id>${after} ORDER BY r.id LIMIT ${limit}`;
      return rows.map((r) => ({ taskId: r.task_id, runId: r.run_id }));
    });
  }
  async unconfirmedBatch(limit = 32, after = ""): Promise<WorkIdentity[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 128 ||
      typeof after !== "string" ||
      after.length > 128 ||
      after.includes("\0")
    )
      throw new WorkConflict("invalid_handoff_limit");
    return this.transactions.run(async (db) => {
      const rows =
        await db`SELECT r.task_id,r.id AS run_id FROM work_admissions a JOIN work_runs r ON r.id=a.run_id
        WHERE a.execution_owner=${EXECUTION_OWNER} AND a.state='pending' AND a.submission_attempted_at IS NOT NULL
        AND r.id>${after} ORDER BY r.id LIMIT ${limit}`;
      return rows.map((r) => ({ taskId: r.task_id, runId: r.run_id }));
    });
  }
  async unconfirmed(identity: WorkIdentity): Promise<PriorSubmission | null> {
    workIdentity(identity);
    return this.transactions.run(async (db) => {
      const rows =
        await db`SELECT a.submission_reference,a.submission_attempt_id FROM work_admissions a JOIN work_runs r ON r.id=a.run_id
        WHERE r.task_id=${identity.taskId} AND r.id=${identity.runId} AND a.execution_owner=${EXECUTION_OWNER}
        AND a.state='pending' AND a.submission_attempted_at IS NOT NULL`;
      return rows[0]
        ? {
            engineReference: rows[0].submission_reference,
            attemptId: rows[0].submission_attempt_id,
          }
        : null;
    });
  }
  async reserve(identity: WorkIdentity, reference: string): Promise<Reservation> {
    workIdentity(identity);
    return this.transactions.run(async (db) => {
      const task = await lockWorkTask(db, identity.taskId);
      const row = await admission(db, identity);
      const existing = row.submission_reference ?? row.engine_reference;
      if (existing !== null) {
        if (existing !== reference) throw new WorkConflict("handoff_reference_changed");
        return { shouldStart: false, attemptId: row.submission_attempt_id };
      }
      activeWorkTask(task);
      if (row.state !== "pending" || !["queued", "running"].includes(row.run_status))
        throw new WorkConflict("handoff_closed");
      const attemptId = randomBytes(16).toString("hex");
      await db`UPDATE work_admissions SET submission_reference=${reference},submission_attempt_id=${attemptId},
        submission_attempted_at=clock_timestamp() WHERE run_id=${identity.runId}`;
      await workEvent(db, identity.taskId, "handoff.submission_attempted", {
        runId: identity.runId,
        engineReference: reference,
      });
      return { shouldStart: true, attemptId };
    });
  }
  async acknowledge(
    identity: WorkIdentity,
    reference: string,
    attemptId: string,
    firstRunId: string,
  ): Promise<boolean> {
    workIdentity(identity);
    if (!validAttempt(attemptId) || !firstRunId.length || Buffer.byteLength(firstRunId) > 128)
      throw new WorkConflict("invalid_engine_receipt");
    return this.transactions.run(async (db) => {
      await lockWorkTask(db, identity.taskId);
      const row = await admission(db, identity);
      if (!row.submission_reference) throw new WorkConflict("handoff_not_reserved");
      if (row.submission_reference !== reference)
        throw new WorkConflict("handoff_reference_changed");
      if (!row.submission_attempt_id) throw new WorkConflict("handoff_attempt_unbound");
      if (row.submission_attempt_id !== attemptId)
        throw new WorkConflict("handoff_attempt_changed");
      if (row.state === "acknowledged") {
        if (row.engine_reference !== reference) throw new WorkConflict("handoff_reference_changed");
        if (!row.engine_first_run_id) throw new WorkConflict("handoff_engine_run_unbound");
        if (row.engine_first_run_id !== firstRunId)
          throw new WorkConflict("handoff_engine_run_changed");
        return false;
      }
      if (row.state !== "pending") throw new WorkConflict("handoff_closed");
      await db`UPDATE work_admissions SET state='acknowledged',engine_reference=${reference},engine_first_run_id=${firstRunId}
        WHERE run_id=${identity.runId}`;
      await workEvent(db, identity.taskId, "handoff.acknowledged", {
        runId: identity.runId,
        engineReference: reference,
        engineFirstRunId: firstRunId,
      });
      return true;
    });
  }
}
