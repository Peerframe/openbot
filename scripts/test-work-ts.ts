// Real Temporal/mTLS + disposable PostgreSQL qualification. The Activity below is an explicit
// synthetic control probe: it verifies handoff/recovery/fences, not product model/tool completion.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode, NativeConnection, Worker } from "@temporalio/worker";
import {
  acceptedWork,
  checkWorkFence,
  WorkExecution,
  type WorkFence,
} from "../apps/server-ts/dist/work-execution.js";
import { WorkHandoff, workTransactions } from "../apps/server-ts/dist/work-handoff.js";
import { createDatabase } from "../packages/db/dist/index.js";
import {
  Client,
  Connection,
  currentBinding,
  dispatchOne,
  installWorkRuntime,
  observeEngineClosure,
  TemporalEngine,
  WORKFLOW_ID_PREFIX,
  type WorkStart,
} from "../packages/work/dist/index.js";
import {
  allowlistedEnvironment,
  cleanupOnTerminationSignals,
  OwnedDockerFixture,
  startControlPostgres,
} from "./python-acceptance-fixture.ts";
import { qualifyWorkProduct } from "./ts-work-product-acceptance.ts";

await installWorkRuntime();
const root = fileURLToPath(new URL("../", import.meta.url));
const input = process.argv[2];
assert(input, "The owned Temporal fixture must supply its private receipt path.");
const fixture = JSON.parse(await readFile(input, "utf8"));
assert(/^127\.0\.0\.1:\d+$/.test(fixture.address));
const tls = {
  serverNameOverride: fixture.tls.server_name,
  serverRootCACertificate: await readFile(fixture.tls.ca),
  clientCertPair: {
    crt: await readFile(fixture.tls.certificate),
    key: await readFile(fixture.tls.key),
  },
};
const environment = allowlistedEnvironment([
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
]);
const docker = new OwnedDockerFixture(root, environment);
cleanupOnTerminationSignals(() => docker.cleanup());
let database: ReturnType<typeof createDatabase> | undefined;
let transactionsToClose: ReturnType<typeof workTransactions> | undefined;
let connection: Connection | undefined;
let native: NativeConnection | undefined;
try {
  const dsn = await startControlPostgres(
    docker,
    `openbot-p4-${randomBytes(6).toString("hex")}`,
    randomBytes(24).toString("hex"),
  );
  database = createDatabase(dsn);
  const transactions = workTransactions(dsn);
  transactionsToClose = transactions;
  await database.migrate();
  const sql = database.client;
  const botId = randomUUID();
  await sql`INSERT INTO bots(id,name,role) VALUES (${botId},'Synthetic P4 control probe','fixture')`;
  async function seed(owner: "python-v1" | "typescript-v1" = "typescript-v1") {
    const taskId = randomUUID(),
      runId = randomUUID();
    await sql.begin(async (db) => {
      await db`INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit)
        VALUES (${taskId},'owner',${botId},${randomUUID()},${"a".repeat(64)},'Verify isolated engine control',1000)`;
      await db`INSERT INTO work_runs(id,task_id,ordinal) VALUES (${runId},${taskId},1)`;
      await db`INSERT INTO work_admissions(run_id,execution_owner) VALUES (${runId},${owner})`;
      await db`INSERT INTO work_events(task_id,revision,kind,payload) VALUES (${taskId},1,'task.created',${JSON.stringify({ runId })}::jsonb)`;
    });
    return { taskId, runId };
  }
  const handoff = new WorkHandoff(transactions);
  const python = await seed("python-v1");
  const ts = await seed();
  assert.deepEqual(await handoff.pending(), [ts]);
  await assert.rejects(
    handoff.reserve(python, "temporal:default:unowned"),
    /handoff_execution_owner_mismatch/,
  );
  await assert.rejects(
    sql`UPDATE work_admissions SET execution_owner='typescript-v1' WHERE run_id=${python.runId}`,
    /work_execution_owner_immutable/,
  );
  const racers = await Promise.all([
    handoff.reserve(ts, "fixture-reserved"),
    handoff.reserve(ts, "fixture-reserved"),
  ]);
  assert.equal(racers.filter((r) => r.shouldStart).length, 1);
  assert.equal(racers[0]!.attemptId, racers[1]!.attemptId);
  console.log("PASS ownership isolation, immutable owner and concurrent single reservation");
  const paging = await Promise.all(Array.from({ length: 7 }, () => seed()));
  const pages = async (
    read: (limit: number, after: string) => Promise<{ taskId: string; runId: string }[]>,
  ) => {
    const found = new Set<string>();
    let after = "";
    for (let page = 0; page < 10; page++) {
      const rows = await read(2, after);
      for (const row of rows) {
        assert(!found.has(row.runId));
        found.add(row.runId);
      }
      if (rows.length < 2) return found;
      after = rows.at(-1)!.runId;
    }
    assert.fail("Handoff paging failed to end");
  };
  const pendingIds = await pages(handoff.pending.bind(handoff));
  assert(paging.every((row) => pendingIds.has(row.runId)));
  for (const row of paging) await handoff.reserve(row, "fixture-unconfirmed-" + row.runId);
  const uncertainIds = await pages(handoff.unconfirmedBatch.bind(handoff));
  assert(paging.every((row) => uncertainIds.has(row.runId)));
  await sql.begin(async (db) => {
    await db`DELETE FROM work_admissions WHERE run_id IN ${db(paging.map((row) => row.runId))}`;
    await db`DELETE FROM work_events WHERE task_id IN ${db(paging.map((row) => row.taskId))}`;
    await db`DELETE FROM work_runs WHERE id IN ${db(paging.map((row) => row.runId))}`;
    await db`DELETE FROM work_tasks WHERE id IN ${db(paging.map((row) => row.taskId))}`;
  });
  console.log(
    "PASS complete pending/unconfirmed keyset scans reach rows beyond an unchanged first page",
  );

  connection = await Connection.connect({
    address: fixture.address,
    tls,
    connectTimeout: 10_000,
    interceptors: [],
  });
  native = await NativeConnection.connect({ address: fixture.address, tls });
  const client = new Client({ connection, namespace: "default" });
  const engine = new TemporalEngine(client);
  const settings = {
    namespace: "default",
    taskQueue: "openbot-p4-" + randomUUID(),
    executionTimeoutMs: 300_000,
  };
  const lost = await seed();
  let starts = 0;
  const losingEngine = {
    namespace: engine.namespace,
    start: async (...args: Parameters<typeof engine.start>) => {
      starts++;
      await engine.start(...args);
      throw new Error("synthetic lost reply");
    },
    inspectStart: engine.inspectStart.bind(engine),
  };
  await assert.rejects(dispatchOne(lost, settings, handoff, losingEngine), /synthetic lost reply/);
  await sql`UPDATE work_tasks SET status='cancelled',cancel_requested=true,authority_active=false WHERE id=${lost.taskId}`;
  const recovered = await dispatchOne(lost, settings, handoff, losingEngine);
  assert.equal(recovered.acknowledged, true);
  assert.equal(recovered.startRequested, false);
  assert.equal(starts, 1);
  assert.equal(
    (await sql`SELECT status FROM work_tasks WHERE id=${lost.taskId}`)[0]!.status,
    "cancelled",
  );
  await client.workflow
    .getHandle(WORKFLOW_ID_PREFIX + lost.runId)
    .terminate("Owned synthetic cancellation probe finished");
  console.log("PASS lost start reply recovered from real history, cancelled task remains closed");

  const identity = await seed();
  await dispatchOne(identity, settings, handoff, engine);
  const row = (await sql`SELECT * FROM work_admissions WHERE run_id=${identity.runId}`)[0]!;
  const execution = new WorkExecution(transactions);
  let calls = 0;
  let admissionCalls = 0;
  let chainTask: string | undefined;
  let pendingTask: string | undefined;
  let oldFence: WorkFence | undefined;
  const activities = {
    inspectWorkTree: async () => ({ watch: false, deadline: null }),
    awaitWorkAdmission: async (start: WorkStart) => {
      if (start.taskId === pendingTask) admissionCalls++;
      const binding = await currentBinding(engine, settings, start);
      await transactions.run((db) => acceptedWork(db, binding, true));
    },
    advanceWork: async (start: WorkStart) => {
      const binding = await currentBinding(engine, settings, start);
      const fence = await execution.claim(binding);
      await transactions.run(async (db) => {
        await acceptedWork(db, binding);
        await checkWorkFence(db, fence);
        if (oldFence && start.taskId === identity.taskId)
          await assert.rejects(checkWorkFence(db, oldFence), /execution_claim_stale/);
      });
      if (start.taskId === chainTask)
        return { state: fence.epoch < 65 ? ("continue" as const) : ("completed" as const) };
      if (start.taskId === pendingTask) return { state: "completed" as const };
      oldFence = fence;
      calls++;
      return { state: calls === 1 ? ("waiting" as const) : ("completed" as const) };
    },
  };
  const workflowsPath = fileURLToPath(
    new URL("../packages/work/dist/workflows.js", import.meta.url),
  );
  const workflowBundle = await bundleWorkflowCode({ workflowsPath });
  const makeWorker = () =>
    Worker.create({
      connection: native!,
      namespace: settings.namespace,
      taskQueue: settings.taskQueue,
      workflowBundle,
      activities,
      shutdownGraceTime: "1 second",
      shutdownForceTime: "5 seconds",
    });
  const first = await makeWorker();
  const firstRunning = first.run();
  try {
    const deadline = Date.now() + 25_000;
    while (calls < 1 && Date.now() < deadline) await delay(100);
    assert.equal(calls, 1, "Real remote Activity did not run");
    // Wait until the Activity completion and durable timer are recorded before replacing the worker.
    let waiting = false;
    while (Date.now() < deadline) {
      const history = await client.workflow
        .getHandle(WORKFLOW_ID_PREFIX + identity.runId)
        .fetchHistory();
      if (history.events?.some((event) => event.timerStartedEventAttributes)) {
        waiting = true;
        break;
      }
      await delay(100);
    }
    assert(waiting, "Durable timer was not recorded before worker replacement");
  } finally {
    first.shutdown();
    await firstRunning;
  }
  const second = await makeWorker();
  await second.runUntil(async () => {
    const handle = client.workflow.getHandle(WORKFLOW_ID_PREFIX + identity.runId);
    await handle.signal("workChanged");
    await handle.result();
  });
  assert.equal(calls, 2, "Restart reran an already completed Activity");
  const history = await client.workflow
    .getHandle(WORKFLOW_ID_PREFIX + identity.runId)
    .fetchHistory();
  assert.equal(
    (await engine.inspectStart(WORKFLOW_ID_PREFIX + identity.runId))!.firstRunId,
    row.engine_first_run_id,
  );
  await Worker.runReplayHistory({ workflowBundle }, history);
  console.log(
    "PASS real worker replacement, durable wakeup, stale fence rejection and offline replay",
  );

  const continued = await seed();
  chainTask = continued.taskId;
  await dispatchOne(continued, settings, handoff, engine);
  const continuedRow = (
    await sql`SELECT engine_first_run_id,submission_attempt_id FROM work_admissions WHERE run_id=${continued.runId}`
  )[0]!;
  const third = await makeWorker();
  await third.runUntil(async () => {
    await client.workflow.getHandle(WORKFLOW_ID_PREFIX + continued.runId).result();
  });
  const continuedStart = await engine.inspectStart(WORKFLOW_ID_PREFIX + continued.runId);
  assert.equal(continuedStart!.firstRunId, continuedRow.engine_first_run_id);
  const firstHistory = await client.workflow
    .getHandle(WORKFLOW_ID_PREFIX + continued.runId, continuedRow.engine_first_run_id)
    .fetchHistory();
  assert(
    firstHistory.events?.some((event) => event.workflowExecutionContinuedAsNewEventAttributes),
  );
  await Worker.runReplayHistory({ workflowBundle }, firstHistory);
  await Worker.runReplayHistory(
    { workflowBundle },
    await client.workflow.getHandle(WORKFLOW_ID_PREFIX + continued.runId).fetchHistory(),
  );
  assert.equal(
    Number(
      (await sql`SELECT execution_epoch FROM work_runs WHERE id=${continued.runId}`)[0]!
        .execution_epoch,
    ),
    65,
  );
  const continuedClosure = await observeEngineClosure(
    client,
    settings,
    { ...continued, attemptId: continuedRow.submission_attempt_id },
    continuedRow.engine_first_run_id,
  );
  assert.equal(continuedClosure?.state, "COMPLETED");
  assert.notEqual(continuedClosure?.engineRunId, continuedClosure?.firstRunId);
  console.log(
    "PASS Continue-As-New retains accepted chain and exact input; both histories replay; immutable chain closure verified",
  );

  const pending = await seed();
  pendingTask = pending.taskId;
  const pendingRef = "temporal:default:" + WORKFLOW_ID_PREFIX + pending.runId;
  const reserved = await handoff.reserve(pending, pendingRef);
  await engine.start(
    WORKFLOW_ID_PREFIX + pending.runId,
    { ...pending, attemptId: reserved.attemptId! },
    settings,
  );
  const fourth = await makeWorker();
  await fourth.runUntil(async () => {
    const deadline = Date.now() + 20_000;
    while (!admissionCalls && Date.now() < deadline) await delay(100);
    assert(admissionCalls > 0);
    assert.equal(
      Number(
        (await sql`SELECT execution_epoch FROM work_runs WHERE id=${pending.runId}`)[0]!
          .execution_epoch,
      ),
      0,
    );
    await dispatchOne(pending, settings, handoff, engine);
    await client.workflow.getHandle(WORKFLOW_ID_PREFIX + pending.runId).result();
  });
  assert(admissionCalls >= 2);
  console.log(
    "PASS early Activity waits for durable acknowledgement without failing or gaining authority",
  );
  await qualifyWorkProduct(dsn, fixture);
} finally {
  const closed = await Promise.allSettled([
    native?.close(),
    connection?.close(),
    transactionsToClose?.close(),
    database?.close(),
  ]);
  docker.cleanup();
  assert(
    closed.every((result) => result.status === "fulfilled"),
    "Owned client cleanup failed",
  );
}
