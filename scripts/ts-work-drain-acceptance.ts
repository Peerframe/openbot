import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkTransactions } from "../apps/server-ts/dist/work-handoff.js";
import { auditPythonDrain, requirePythonDrain } from "../apps/server-ts/dist/work-python-drain.js";
import type { createDatabase } from "../packages/db/dist/index.js";
import type { Client } from "../packages/work/dist/index.js";

type Identity = { taskId: string; runId: string };
export async function qualifyPythonDrain(
  sql: ReturnType<typeof createDatabase>["client"],
  transactions: WorkTransactions,
  client: Client,
  first: Identity,
  seed: () => Promise<Identity>,
) {
  const queue = "openbot-python-drain-fixture-" + randomUUID();
  const audit = (store = transactions, pageSize = 100) =>
    auditPythonDrain(store, client, queue, AbortSignal.timeout(30000), pageSize);
  const initial = await audit();
  assert(initial.blocked.activeRuns > 0);
  assert.throws(() => requirePythonDrain(initial), /python_work_not_drained/);
  const identities = [first];
  for (let i = 0; i < 104; i++) identities.push(await seed());
  const taskIds = identities.map((v) => v.taskId),
    runIds = identities.map((v) => v.runId);
  await sql`UPDATE work_tasks SET status='cancelled',authority_active=false WHERE id IN ${sql(taskIds)}`;
  await sql`UPDATE work_runs SET status='cancelled' WHERE id IN ${sql(runIds)}`;
  const target = identities.sort((a, b) => (a.runId < b.runId ? -1 : 1)).at(-1)!;
  await sql`UPDATE work_runs SET status='queued' WHERE id=${target.runId}`;
  const blocked = await audit();
  assert.equal(blocked.runs, 105);
  assert.equal(blocked.blocked.activeRuns, 1);
  assert.throws(() => requirePythonDrain(blocked), /python_work_not_drained/);
  await sql`UPDATE work_runs SET status='cancelled' WHERE id=${target.runId}`;
  await sql`UPDATE work_admissions SET submission_reference=${"temporal:" + client.options.namespace + ":openbot-work-v1-" + target.runId},submission_attempted_at=clock_timestamp() WHERE run_id=${target.runId}`;
  assert.equal((await audit()).blocked.unconfirmed, 1);
  await sql`UPDATE work_admissions SET submission_reference=NULL,submission_attempted_at=NULL WHERE run_id=${target.runId}`;
  const actionId = randomUUID(),
    repairId = randomUUID();
  await sql`INSERT INTO work_actions(id,task_id,run_id,action_key,intent,intent_digest,authority_generation,
    requires_approval,baseline_requires_approval,decision,expires_at,reserved_tokens,status)
    VALUES(${actionId},${target.taskId},${target.runId},'drain-fixture','{}',${"a".repeat(64)},1,false,false,'not_required',clock_timestamp()+interval '1 minute',1,'unknown')`;
  await sql`INSERT INTO work_reconciliation_commands(id,action_id,intent_digest,sequence,requested_by,reason)
    VALUES(${repairId},${actionId},${"a".repeat(64)},1,'owner','Disposable drain fixture')`;
  const unresolved = await audit();
  assert.equal(unresolved.blocked.effects, 1);
  assert.equal(unresolved.blocked.repairs, 1);
  await sql`DELETE FROM work_reconciliation_commands WHERE id=${repairId}`;
  await sql`DELETE FROM work_actions WHERE id=${actionId}`;
  const handles = [];
  try {
    for (const item of identities.slice(0, 3))
      handles.push(
        await client.workflow.start("OpenBotWorkV1", {
          workflowId: "openbot-work-v1-" + item.runId,
          taskQueue: queue,
          args: [{ taskId: item.taskId, runId: item.runId, attemptId: randomUUID() }],
          workflowExecutionTimeout: 60000,
          retry: { maximumAttempts: 1 },
        }),
      );
    const end = Date.now() + 15000;
    for (;;) {
      const found = [];
      for await (const info of client.workflow.list({
        query: "WorkflowType = 'OpenBotWorkV1' AND ExecutionStatus = 'Running'",
        pageSize: 2,
      }))
        if (info.taskQueue === queue) found.push(info);
      if (found.length === 3) break;
      assert(Date.now() < end, "Owned Temporal Visibility did not publish fixture starts");
      await delay(100);
    }
    const running = await audit(transactions, 2);
    assert.equal(running.blocked.engineRuns, 3);
    assert(running.visibilityPages >= 2);
    assert.throws(() => requirePythonDrain(running));
  } finally {
    await Promise.all(
      handles.map((handle) => handle.terminate("Disposable drain gate qualification")),
    );
  }
  const complete = await audit(transactions, 2);
  requirePythonDrain(complete);
  assert.equal(complete.runs, 105);
  let calls = 0;
  const racing: WorkTransactions = {
    ...transactions,
    run: async (operation) => {
      const result = await transactions.run(operation);
      if (++calls === 2)
        await sql`UPDATE work_tasks SET status='completed' WHERE id=${identities[0]!.taskId}`;
      return result;
    },
  };
  await assert.rejects(audit(racing), /python_drain_unverified/);
  console.log(
    "PASS real SQL drain beyond 100 rows rejects active/unconfirmed/unknown/unfinished repair facts; real mTLS Temporal pagination catches running legacy IDs, requires terminal events and rejects a changing SQL snapshot (unpolled engine fixtures, no Python task execution)",
  );
}
