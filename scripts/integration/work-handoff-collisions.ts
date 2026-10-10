/** Real Temporal start collisions must never acknowledge SQL, acquire a claim or produce effects. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import {
  Client,
  createWorkWorker,
  currentBinding,
  dispatchOne,
  TemporalEngine,
  WORKFLOW_ID_PREFIX,
  WORKFLOW_TYPE,
  type EngineSettings,
  type WorkIdentity,
} from "../../packages/work/dist/index.js";
import { acceptedWork } from "../../apps/server/dist/work-execution.js";
import { WorkHandoff, type WorkTransactions } from "../../apps/server/dist/work-handoff.js";
import type { TLSConfig } from "@temporalio/worker";

export async function qualifyHandoffCollisions(options: {
  sql: postgres.Sql;
  transactions: WorkTransactions;
  client: Client;
  address: string;
  tls: TLSConfig;
  seed: () => Promise<WorkIdentity>;
}) {
  const { sql, transactions, client } = options,
    engine = new TemporalEngine(client),
    handoff = new WorkHandoff(transactions);
  const settings: EngineSettings = {
    namespace: "default",
    taskQueue: "handoff-collision-" + randomUUID(),
    executionTimeoutMs: 240000,
  };
  const state = async (identity: WorkIdentity) => {
    const [task] =
      await sql`SELECT to_jsonb(t)-'revision'-'updated_at' AS value,revision FROM work_tasks t WHERE id=${identity.taskId}`;
    const runs = await sql`SELECT * FROM work_runs WHERE task_id=${identity.taskId} ORDER BY id`;
    const actions = await sql`SELECT * FROM work_actions WHERE task_id=${identity.taskId}`;
    const artifacts = await sql`SELECT * FROM work_artifacts WHERE task_id=${identity.taskId}`;
    const claims = await sql`SELECT * FROM work_claims WHERE run_id=${identity.runId}`;
    assert(task);
    return {
      task: task.value,
      revision: Number(task.revision),
      runs: Array.from(runs),
      actions: Array.from(actions),
      artifacts: Array.from(artifacts),
      claims: Array.from(claims),
    };
  };
  const unacknowledged = async (
    identity: WorkIdentity,
    before: Awaited<ReturnType<typeof state>>,
    conflictingAttempt?: string,
  ) => {
    const after = await state(identity);
    assert.deepEqual(after, { ...before, revision: before.revision + 1 });
    const [admission] = await sql`SELECT * FROM work_admissions WHERE run_id=${identity.runId}`;
    assert(admission);
    assert.equal(admission.state, "pending");
    assert.equal(admission.engine_reference, null);
    assert.equal(admission.engine_first_run_id, null);
    assert.match(admission.submission_attempt_id, /^[a-f0-9]{32}$/);
    assert.notEqual(admission.submission_attempt_id, conflictingAttempt);
    const events =
      await sql`SELECT kind,payload FROM work_events WHERE task_id=${identity.taskId} ORDER BY revision`;
    assert.deepEqual(Array.from(events), [
      { kind: "task.created", payload: { runId: identity.runId } },
      {
        kind: "handoff.submission_attempted",
        payload: {
          runId: identity.runId,
          engineReference: `temporal:default:${WORKFLOW_ID_PREFIX}${identity.runId}`,
        },
      },
    ]);
  };
  const missing = await options.seed(),
    missingBefore = await state(missing);
  const reference = `temporal:default:${WORKFLOW_ID_PREFIX}${missing.runId}`;
  const reservation = await handoff.reserve(missing, reference);
  assert(reservation.shouldStart && reservation.attemptId);
  let replacementStarts = 0;
  const noReplacement = {
    namespace: engine.namespace,
    inspectStart: engine.inspectStart.bind(engine),
    async start() {
      replacementStarts++;
      assert.fail("Unconfirmed submission must never start a replacement.");
    },
  };
  for (let delivery = 0; delivery < 3; delivery++) {
    assert.deepEqual(await dispatchOne(missing, settings, handoff, noReplacement), {
      acknowledged: false,
      startRequested: false,
      reason: "unconfirmed_missing_history",
    });
    assert.equal(await engine.inspectStart(WORKFLOW_ID_PREFIX + missing.runId), null);
    await unacknowledged(missing, missingBefore);
  }
  assert.equal(replacementStarts, 0);
  console.log(
    "PASS real history missing after durable reservation: no replacement, SQL acknowledgement, claim or effect",
  );

  for (const mismatch of ["scope", "type", "queue", "attempt"] as const) {
    const identity = await options.seed(),
      before = await state(identity),
      other = mismatch === "scope" ? await options.seed() : undefined;
    const otherBefore = other ? await state(other) : undefined;
    const input = {
      ...identity,
      taskId: other?.taskId ?? identity.taskId,
      attemptId: randomBytes(16).toString("hex"),
    };
    const workflowId = WORKFLOW_ID_PREFIX + identity.runId;
    const handle = await client.workflow.start(
      mismatch === "type" ? "UnrelatedWorkflow" : WORKFLOW_TYPE,
      {
        workflowId,
        args: [input],
        taskQueue: mismatch === "queue" ? "unrelated-" + randomUUID() : settings.taskQueue,
        workflowExecutionTimeout: 240000,
        retry: { maximumAttempts: 1 },
      },
    );
    let worker: Awaited<ReturnType<typeof createWorkWorker>> | undefined,
      running: Promise<void> | undefined;
    let admissionAttempts = 0,
      effects = 0;
    try {
      const result = await dispatchOne(identity, settings, handoff, engine);
      assert.deepEqual(result, {
        acknowledged: false,
        startRequested: true,
        reason: "unconfirmed_start_event_mismatch",
      });
      await unacknowledged(identity, before, input.attemptId);
      if (mismatch === "scope" || mismatch === "attempt") {
        worker = await createWorkWorker({
          address: options.address,
          tls: options.tls,
          settings,
          admission: async (start) => {
            admissionAttempts++;
            const binding = await currentBinding(engine, settings, start);
            await transactions.run((db) => acceptedWork(db, binding, true));
          },
          advance: async () => {
            effects++;
            return { state: "completed" };
          },
          inspectTree: async () => {
            effects++;
            return { watch: false, deadline: null };
          },
          closeTree: async () => {
            effects++;
          },
          repair: async () => {
            effects++;
          },
        });
        running = worker.run();
        running.catch(() => {});
        const deadline = Date.now() + 30000;
        while (admissionAttempts < (mismatch === "attempt" ? 2 : 1)) {
          assert(Date.now() < deadline, "Actual colliding start was not consumed by the Worker.");
          await delay(100);
        }
        // TS retries admission until durable acknowledgement. A colliding attempt remains pending,
        // unlike the former Python-specific immediate FAILED status; neither can obtain authority.
        await delay(200);
        assert.equal(effects, 0);
        assert.notEqual((await handle.describe()).status.name, "COMPLETED");
      }
      assert.deepEqual(await dispatchOne(identity, settings, handoff, engine), {
        acknowledged: false,
        startRequested: false,
        reason: "unconfirmed_start_event_mismatch",
      });
      await unacknowledged(identity, before, input.attemptId);
      if (other && otherBefore) assert.deepEqual(await state(other), otherBefore);
      console.log(
        JSON.stringify({
          case: "handoff-reject-" + mismatch,
          actualEngineHistory: true,
          actualWorkerAdmission: !!worker,
          admissionAttempts,
          effectCalls: effects,
          sqlAcknowledged: false,
          originalAttemptRetained: true,
        }),
      );
    } finally {
      try {
        await worker?.close();
        await running;
      } finally {
        if ((await handle.describe()).status.name === "RUNNING")
          await handle.terminate("Owned collision qualification finished");
      }
    }
  }
}
