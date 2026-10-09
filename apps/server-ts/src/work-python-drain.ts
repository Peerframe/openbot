import { createHash } from "node:crypto";
import { type Client, WorkflowNotFoundError } from "@openbot/work";
import type { WorkDb, WorkTransactions } from "./work-handoff.js";

const legacyTypes = new Set(["OpenBotWorkV1", "OpenBotClosedRepairV1"]);
const terminal = new Set(["completed", "failed", "cancelled"]);
const maximumRecords = 100000;
type Run = {
  id: string;
  task_id: string;
  task_status: string;
  run_status: string;
  state: string | null;
  engine_reference: string | null;
  submission_reference: string | null;
  engine_first_run_id: string | null;
  admitted: string;
  unknown: string;
  unfinished_repairs: string;
};
export type PythonDrainReport = {
  schema: "openbot.python-drain/v1";
  namespace: string;
  queue: string;
  runs: number;
  repairs: number;
  missingTerminalHistories: number;
  visibilityPages: number;
  blocked: {
    activeRuns: number;
    unconfirmed: number;
    effects: number;
    repairs: number;
    engineRuns: number;
  };
  sqlDigest: string;
};
const unavailable = () => new Error("python_drain_unverified");
async function rows(db: WorkDb, after: string) {
  await db`SET TRANSACTION READ ONLY`;
  return db<Run[]>`SELECT r.id,r.task_id,t.status AS task_status,r.status AS run_status,a.state,
    a.engine_reference,a.submission_reference,a.engine_first_run_id,
    (SELECT count(*) FROM work_actions e WHERE e.run_id=r.id AND e.status='admitted') AS admitted,
    (SELECT count(*) FROM work_actions e WHERE e.run_id=r.id AND e.status='unknown') AS unknown,
    (SELECT count(*) FROM work_reconciliation_commands c JOIN work_actions e ON e.id=c.action_id
      WHERE e.run_id=r.id AND c.finished_at IS NULL) AS unfinished_repairs
    FROM work_runs r JOIN work_tasks t ON t.id=r.task_id LEFT JOIN work_admissions a ON a.run_id=r.id
    WHERE coalesce(a.execution_owner,'python-v1')='python-v1' AND r.id>${after}
    ORDER BY r.id LIMIT 100`;
}
async function* allRuns(transactions: WorkTransactions) {
  let after = "",
    count = 0;
  for (;;) {
    const page = await transactions.run((db) => rows(db, after));
    for (const row of page) {
      if (++count > maximumRecords) throw unavailable();
      after = row.id;
      yield row;
    }
    if (page.length < 100) return;
  }
}
async function* allRepairs(transactions: WorkTransactions, runId: string) {
  let after = "",
    count = 0;
  for (;;) {
    const page = await transactions.run(async (db) => {
      await db`SET TRANSACTION READ ONLY`;
      return db`SELECT c.id,c.finished_at,c.outcome,c.delivery_reference,c.delivered_at
        FROM work_reconciliation_commands c JOIN work_actions e ON e.id=c.action_id
        WHERE e.run_id=${runId} AND c.id>${after} ORDER BY c.id LIMIT 100`;
    });
    for (const row of page) {
      if (++count > maximumRecords) throw unavailable();
      after = row.id;
      yield row;
    }
    if (page.length < 100) return;
  }
}
async function legacyGaps(transactions: WorkTransactions) {
  return transactions.run(async (db) => {
    await db`SET TRANSACTION READ ONLY`;
    const [row] = await db`SELECT
      (SELECT count(*) FROM work_tasks t WHERE NOT EXISTS (SELECT 1 FROM work_runs r WHERE r.task_id=t.id)) AS orphan_tasks,
      (SELECT count(*) FROM runs r WHERE r.status NOT IN ('completed','failed','cancelled')
        AND NOT EXISTS (SELECT 1 FROM work_sources s WHERE s.legacy_run_id=r.id)) AS legacy_active`;
    if (!row) throw unavailable();
    return { orphanTasks: number(row.orphan_tasks), legacyActive: number(row.legacy_active) };
  });
}
const number = (value: string) => {
  if (!/^[0-9]{1,10}$/.test(value)) throw unavailable();
  return Number(value);
};
/** Single-ID Describe plus the final history event, never Visibility alone. The result is
 * migration evidence only: it grants no replay, effect, refund or artifact-publication authority. */
export async function closedPythonWorkflow(
  client: Client,
  workflowId: string,
  queue: string,
  signal: AbortSignal,
  firstRunId?: string | null,
): Promise<"closed" | "missing" | "running"> {
  return client.withAbortSignal(signal, async () => {
    const describe = () =>
      client.withDeadline(Date.now() + 3000, () =>
        client.workflow.getHandle(workflowId).describe(),
      );
    let described: Awaited<ReturnType<typeof describe>>;
    try {
      described = await describe();
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return "missing";
      throw error;
    }
    const info = described.raw.workflowExecutionInfo;
    if (
      !info ||
      info.execution?.workflowId !== workflowId ||
      !info.execution.runId ||
      info.taskQueue !== queue ||
      !legacyTypes.has(info.type?.name ?? "") ||
      (firstRunId && info.firstRunId !== firstRunId)
    )
      throw unavailable();
    const execution = { workflowId, runId: info.execution.runId };
    if (info.status === 1 || info.status === 6) return "running";
    const states = {
      2: [2, "workflowExecutionCompletedEventAttributes"],
      3: [3, "workflowExecutionFailedEventAttributes"],
      4: [21, "workflowExecutionCanceledEventAttributes"],
      5: [27, "workflowExecutionTerminatedEventAttributes"],
      7: [17, "workflowExecutionTimedOutEventAttributes"],
    } as const;
    const state = states[info.status as keyof typeof states];
    if (!state || !info.closeTime) throw unavailable();
    const history = await client.withDeadline(Date.now() + 3000, () =>
      client.workflowService.getWorkflowExecutionHistory({
        namespace: client.options.namespace,
        execution,
        maximumPageSize: 1,
        waitNewEvent: false,
        skipArchival: true,
        historyEventFilterType: 2,
      }),
    );
    const event = history.history?.events?.[0];
    const attributes = event?.[state[1]];
    if (
      history.archived ||
      history.rawHistory?.length ||
      history.nextPageToken?.length ||
      history.history?.events?.length !== 1 ||
      !event ||
      event.eventType !== state[0] ||
      !attributes ||
      ("newExecutionRunId" in attributes && attributes.newExecutionRunId) ||
      event.eventId?.toString() !== info.historyLength?.toString() ||
      JSON.stringify(event.eventTime) !== JSON.stringify(info.closeTime)
    )
      throw unavailable();
    const checked = (await describe()).raw.workflowExecutionInfo;
    if (
      checked?.execution?.runId !== info.execution.runId ||
      checked.status !== info.status ||
      checked.firstRunId !== info.firstRunId ||
      checked.taskQueue !== queue ||
      checked.historyLength?.toString() !== info.historyLength?.toString()
    )
      throw unavailable();
    return "closed";
  });
}
/** Caller must already have stopped old admission and paired processes. Full SQL pagination is
 * repeated after engine observation; a timeout, changed snapshot or incomplete page fails closed. */
export async function auditPythonDrain(
  transactions: WorkTransactions,
  client: Client,
  queue: string,
  signal: AbortSignal,
  visibilityPageSize = 100,
): Promise<PythonDrainReport> {
  if (
    !queue ||
    queue.length > 256 ||
    queue.includes("\0") ||
    !Number.isInteger(visibilityPageSize) ||
    visibilityPageSize < 1 ||
    visibilityPageSize > 100
  )
    throw unavailable();
  const report: PythonDrainReport = {
    schema: "openbot.python-drain/v1",
    namespace: client.options.namespace,
    queue,
    runs: 0,
    repairs: 0,
    missingTerminalHistories: 0,
    visibilityPages: 0,
    sqlDigest: "",
    blocked: { activeRuns: 0, unconfirmed: 0, effects: 0, repairs: 0, engineRuns: 0 },
  };
  const gaps = await legacyGaps(transactions);
  report.blocked.activeRuns += gaps.orphanTasks + gaps.legacyActive;
  const hash = createHash("sha256").update(JSON.stringify(gaps) + "\n");
  const running = new Set<string>(),
    missing = new Set<string>();
  const observe = async (id: string, first?: string | null) => {
    const result = await closedPythonWorkflow(client, id, queue, signal, first);
    if (result === "running") running.add(id);
    if (result === "missing") missing.add(id);
  };
  for await (const row of allRuns(transactions)) {
    signal.throwIfAborted();
    report.runs++;
    hash.update(JSON.stringify(row) + "\n");
    const active = !terminal.has(row.task_status) || !terminal.has(row.run_status);
    if (active) report.blocked.activeRuns++;
    if (row.state === null || (row.state === "pending" && row.submission_reference !== null))
      report.blocked.unconfirmed++;
    report.blocked.effects += number(row.admitted) + number(row.unknown);
    report.blocked.repairs += number(row.unfinished_repairs);
    const id = "openbot-work-v1-" + row.id,
      reference = "temporal:" + client.options.namespace + ":" + id;
    if (
      [row.engine_reference, row.submission_reference].some(
        (value) => value !== null && value !== reference,
      )
    )
      throw unavailable();
    // Even a never-submitted row is checked: this detects an orphan start under its deterministic ID.
    await observe(id, row.engine_first_run_id);
    for await (const command of allRepairs(transactions, row.id)) {
      if (++report.repairs > maximumRecords) throw unavailable();
      hash.update(JSON.stringify(command) + "\n");
      await observe("openbot-closed-repair-v1-" + command.id);
    }
  }
  // Visibility discovers executions outside the current SQL index; it is not a closure proof.
  let nextPageToken = new Uint8Array(0),
    count = 0;
  const tokens = new Set<string>();
  for (;;) {
    signal.throwIfAborted();
    const page = await client.withAbortSignal(signal, () =>
      client.withDeadline(Date.now() + 3000, () =>
        client.workflowService.listWorkflowExecutions({
          namespace: client.options.namespace,
          query: "ExecutionStatus = 'Running'",
          pageSize: visibilityPageSize,
          nextPageToken,
        }),
      ),
    );
    if (++report.visibilityPages > 1000) throw unavailable();
    for (const info of page.executions ?? []) {
      if (++count > maximumRecords) throw unavailable();
      if (info.taskQueue !== queue) continue;
      if (!info.execution?.workflowId || !legacyTypes.has(info.type?.name ?? "")) {
        if (!info.execution?.workflowId) throw unavailable();
        running.add(info.execution.workflowId);
        continue;
      }
      await observe(info.execution.workflowId);
    }
    if (!page.nextPageToken?.length) break;
    const encoded = Buffer.from(page.nextPageToken).toString("base64");
    if (tokens.has(encoded)) throw unavailable();
    tokens.add(encoded);
    nextPageToken = Uint8Array.from(page.nextPageToken);
  }
  const checked = createHash("sha256").update(
    JSON.stringify(await legacyGaps(transactions)) + "\n",
  );
  let checkedCount = 0;
  for await (const row of allRuns(transactions)) {
    signal.throwIfAborted();
    checkedCount++;
    checked.update(JSON.stringify(row) + "\n");
    for await (const command of allRepairs(transactions, row.id)) {
      signal.throwIfAborted();
      checked.update(JSON.stringify(command) + "\n");
    }
  }
  report.sqlDigest = hash.digest("hex");
  if (checkedCount !== report.runs || checked.digest("hex") !== report.sqlDigest)
    throw unavailable();
  signal.throwIfAborted();
  report.blocked.engineRuns = running.size;
  report.missingTerminalHistories = missing.size;
  return report;
}
export function requirePythonDrain(report: PythonDrainReport) {
  if (Object.values(report.blocked).some((count) => count !== 0))
    throw new Error("python_work_not_drained");
}
