import { runProgressDetailsSchema, runProgressSummarySchema } from "@openbot/protocol";
import type postgres from "postgres";
import { refuse } from "./owner-transaction.js";

type Row = Record<string, any>;
const stages: Record<string, readonly [string, string]> = {
  context: ["context", "Read employee context."],
  planning: ["planning", "Choose the next action."],
  observation: ["observation", "Check the action result."],
  navigate: ["navigate", "Open a page."],
  screenshot: ["screenshot", "Capture the current screen."],
  model: ["planning", "Choose the next action."],
  tool: ["action", "Execute an authorized action."],
};
const terminal = ["completed", "failed", "cancelled"];
const failures = new Set([
  "plugin_rejected",
  "plugin_approval_expired",
  "plugin_changed",
  "plugin_unavailable",
  "attachment_model_unsupported",
  "attachment_unavailable",
  "model_credentials",
  "model_rate_limit",
  "model_unavailable",
  "settings_changed",
  "scope_revoked",
  "invalid_target",
  "conflict",
  "skills_changed",
  "memory_changed",
  "task_limit",
  "tool_unavailable",
  "task_timeout",
  "server_interrupted",
  "execution_failed",
  "task_failed",
]);
const stepRelation = `WITH sources AS (
    SELECT r.id,s.task_id FROM runs r LEFT JOIN work_sources s ON s.legacy_run_id=r.id WHERE r.id IN (SELECT jsonb_array_elements_text($1::jsonb))
), facts AS (
    SELECT s.id AS run_id,a.id,a.created_at,left(a.intent->>'kind',256) AS stage,a.status,
        timing.started_at,timing.ended_at
    FROM sources s JOIN work_actions a ON a.task_id=s.task_id
    LEFT JOIN LATERAL (
        SELECT min(e.created_at) FILTER (WHERE e.kind='action.admitted') AS started_at,
            max(e.created_at) FILTER (WHERE e.kind='action.resolved') AS ended_at
        FROM work_events e WHERE e.task_id=a.task_id AND e.payload->>'actionId'=a.id
            AND e.kind IN ('action.admitted','action.resolved')
    ) timing ON true
    UNION ALL
    SELECT s.id,e.id,e.created_at,left(e.payload->>'stage',256),NULL::text,e.created_at,NULL::timestamptz
    FROM sources s JOIN run_events e ON e.run_id=s.id AND e.type='RUN_PROGRESS' WHERE s.task_id IS NULL
), numbered AS (
    SELECT facts.*,row_number() OVER (PARTITION BY run_id ORDER BY created_at,id COLLATE "C") AS number,
        count(*) OVER (PARTITION BY run_id) AS total FROM facts
) `;

export function selectedProgressSteps(query: URLSearchParams): number[] | null {
  if ([...query.keys()].some((key) => key !== "steps") || query.getAll("steps").length > 1)
    refuse(422, "invalid_progress_steps");
  const value = query.get("steps");
  if (value === null) return null;
  if (!/^[1-9][0-9]{0,6}(?:,[1-9][0-9]{0,6}){0,11}$/.test(value))
    refuse(422, "invalid_progress_steps");
  const result = value.split(",").map(Number);
  if (new Set(result).size !== result.length) refuse(422, "invalid_progress_steps");
  return result.sort((a, b) => a - b);
}
const instant = (value: Date | string | null) => {
  if (value === null) return null;
  // Postgres.js can return a CTE's union timestamp as its SQL text representation.
  // Both branches use the same UTC/millisecond public DTO as Python iso_timestamp.
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
    throw new Error("Invalid persisted progress timestamp.");
  return date.toISOString();
};
export async function progressSummaries(db: postgres.TransactionSql, runs: readonly Row[]) {
  if (!runs.length) return {};
  const rows = await db.unsafe(
    stepRelation +
      `SELECT s.id,
    count(n.id) AS total_steps,
    CASE WHEN s.task_id IS NULL THEN NULL ELSE count(n.id) FILTER (WHERE n.status='applied') END AS completed_steps,
    (array_agg(n.stage ORDER BY n.number DESC) FILTER (WHERE n.id IS NOT NULL))[1] AS stage,
    CASE WHEN s.task_id IS NULL THEN
      (SELECT min(created_at) FROM run_events WHERE run_id=s.id AND type='RUN_STARTED')
    ELSE (SELECT min(created_at) FROM work_events WHERE task_id=s.task_id AND kind='run.claimed') END AS started_at,
    CASE WHEN s.task_id IS NULL THEN
      (SELECT max(created_at) FROM run_events WHERE run_id=s.id AND type IN ('RUN_COMPLETED','RUN_FAILED','RUN_CANCELLED'))
    ELSE (SELECT max(created_at) FROM work_events WHERE task_id=s.task_id AND kind IN ('task.completed','task.failed','task.cancelled')) END AS ended_at
    FROM sources s LEFT JOIN numbered n ON n.run_id=s.id GROUP BY s.id,s.task_id`,
    [db.json(runs.map((run) => run.id))],
  );
  const facts = new Map(rows.map((row) => [row.id, row]));
  return Object.fromEntries(
    runs.map((run) => {
      const fact = facts.get(run.id);
      if (!fact) throw new Error("Run progress facts unavailable.");
      let [stageName, description]: [string | null, string | null] = [
        ...(stages[fact.stage] ?? [null, null]),
      ];
      if (run.status === "waiting_approval") {
        stageName = "approval";
        description = "Wait for Owner approval.";
      } else if (terminal.includes(run.status)) {
        stageName = null;
        description = null;
      }
      const total = Number(fact.total_steps);
      return [
        run.id,
        runProgressSummarySchema.parse({
          runId: run.id,
          status: run.status,
          totalSteps: total,
          currentStepNumber: total || null,
          stageName,
          description,
          startedAt: instant(fact.started_at),
          endedAt: instant(fact.ended_at),
          plannedTotalSteps: null,
          completedSteps: fact.completed_steps === null ? null : Number(fact.completed_steps),
          failureReasonCode:
            run.status === "failed" && failures.has(run.error_code) ? run.error_code : null,
        }),
      ];
    }),
  );
}
export async function readRunProgress(
  db: postgres.TransactionSql,
  runId: string,
  query: URLSearchParams,
) {
  const indices = selectedProgressSteps(query);
  const [run] =
    await db`SELECT r.id,r.status,r.error_code FROM runs_work_projection r JOIN channels c ON c.id=r.channel_id WHERE r.id=${runId} AND c.deleted_at IS NULL`;
  if (!run) return refuse(404, "run_not_found");
  const summary = (await progressSummaries(db, [run]))[runId];
  const rows = await db.unsafe(
    stepRelation +
      `SELECT * FROM numbered WHERE
    ($2::jsonb IS NOT NULL AND number IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb))) OR
    ($2::jsonb IS NULL AND (total<=12 OR number<=3 OR number>total-6)) ORDER BY number`,
    [db.json([runId]), indices === null ? null : db.json(indices)],
  );
  return runProgressDetailsSchema.parse({
    ...summary,
    steps: rows.map((row) => ({
      id: row.id,
      stepNumber: Number(row.number),
      stageName: stages[row.stage]?.[0] ?? null,
      description: stages[row.stage]?.[1] ?? null,
      startedAt: instant(row.started_at),
      endedAt: instant(row.ended_at),
    })),
  });
}
