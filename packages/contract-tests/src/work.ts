import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  emptyNativeTaskScope,
  nativeTaskScopeSchema,
  type WorkSnapshot,
  workCorrectionSchema,
  workHttpErrorSchema,
  workReconciliationSchema,
  workSnapshotWireSchema,
} from "@openbot/protocol";
import { z } from "zod";
import { contractClient } from "./client.ts";
import {
  type ContractTarget,
  contractTargetSchema,
  type WorkScenario,
  workScenarioSchema,
} from "./target.ts";

export { type ContractTarget, contractTargetSchema } from "./target.ts";

/** A late receipt records the original handoff without reopening cancelled authority. */
export function assertCancelledSnapshotPersisted(cancelled: WorkSnapshot, persisted: WorkSnapshot) {
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.authorityActive, false);
  assert.deepEqual(persisted.events.slice(0, cancelled.events.length), cancelled.events);
  const later = persisted.events.slice(cancelled.events.length);
  const acknowledged = new Set(
    cancelled.events.filter((e) => e.kind === "handoff.acknowledged").map((e) => e.payload.runId),
  );
  for (const [index, event] of later.entries()) {
    assert.equal(event.kind, "handoff.acknowledged");
    assert.equal(event.revision, cancelled.revision + index + 1);
    assert.deepEqual(Object.keys(event.payload).sort(), [
      "engineFirstRunId",
      "engineReference",
      "runId",
    ]);
    assert(cancelled.runs.some((run) => run.id === event.payload.runId));
    assert(!acknowledged.has(event.payload.runId));
    assert(
      cancelled.events.some(
        (prior) =>
          prior.kind === "handoff.submission_attempted" &&
          prior.payload.runId === event.payload.runId &&
          prior.payload.engineReference === event.payload.engineReference,
      ),
    );
    assert(
      typeof event.payload.engineFirstRunId === "string" &&
        event.payload.engineFirstRunId.length > 0 &&
        Buffer.byteLength(event.payload.engineFirstRunId) <= 128,
    );
    acknowledged.add(event.payload.runId);
  }
  assert.equal(persisted.revision, cancelled.revision + later.length);
  // Every other public field, including runs, effects, usage and authority, must remain exact.
  assert.deepEqual(
    { ...persisted, revision: cancelled.revision, events: cancelled.events },
    cancelled,
  );
}

/** Uses only the supplied disposable target; no dotenv, DB or product implementation imports. */
export async function runWorkContracts(input: ContractTarget, scenario?: WorkScenario) {
  const target = contractTargetSchema.parse(input);
  const passed: string[] = [];
  const { request } = contractClient(target);
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: Parameters<typeof request>[1]) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status);
    workHttpErrorSchema.parse(result.body);
  };
  const missing = randomUUID();
  const create = {
    botId: target.botId,
    objective: "Review synthetic 文档 🧪",
    tokenLimit: 10,
    requestKey: randomUUID(),
    scope: emptyNativeTaskScope(),
  };
  let task: WorkSnapshot | undefined;
  await check("unauthenticated read", () =>
    error(`/api/v1/tasks/${missing}`, 401, { cookie: false }),
  );
  await check("authorization before invalid JSON", () =>
    error("/api/v1/tasks", 401, {
      method: "POST",
      rawBody: "invalid JSON",
      cookie: false,
    }),
  );
  await check("foreign origin before creation", () =>
    error("/api/v1/tasks", 403, {
      method: "POST",
      body: create,
      origin: "https://other.invalid",
    }),
  );
  await check("unknown task", () => error(`/api/v1/tasks/${missing}`, 404, {}));
  for (const [name, body] of [
    ["unknown request fields", { ...create, extra: true }],
    ["boolean budget", { ...create, tokenLimit: true }],
    ["fractional budget", { ...create, tokenLimit: 0.5 }],
    [
      "invalid scope identity",
      { ...create, scope: { ...create.scope, attachmentIds: ["invalid"] } },
    ],
    [
      "duplicate scope identity",
      {
        ...create,
        scope: { ...create.scope, collaboratorBotIds: [target.botId, target.botId.toUpperCase()] },
      },
    ],
  ] as const)
    await check(name, () => error("/api/v1/tasks", 422, { method: "POST", body }));
  await check("raw fractional integer encoding", () =>
    error("/api/v1/tasks", 422, {
      method: "POST",
      rawBody: JSON.stringify(create).replace('"tokenLimit":10', '"tokenLimit":10.0'),
    }),
  );
  await check("UTF-8 HTTP body ceiling", () =>
    error("/api/v1/tasks", 413, {
      method: "POST",
      body: { ...create, objective: "文".repeat(7000) },
    }),
  );
  await check("UTF-8 Work admission text ceiling", () =>
    error("/api/v1/tasks", 422, {
      method: "POST",
      body: { ...create, objective: "文".repeat(5500) },
    }),
  );
  await check("concurrent idempotent create", async () => {
    const results = await Promise.all([
      request("/api/v1/tasks", { method: "POST", body: create }),
      request("/api/v1/tasks", { method: "POST", body: create }),
    ]);
    const snapshots = results.map(({ response, body }) => {
      assert.equal(response.status, 202);
      return workSnapshotWireSchema.parse(body);
    });
    assert.deepEqual(snapshots[0], snapshots[1]);
    task = snapshots[0];
    assert(task);
    assert.equal(task.objective, create.objective);
    assert.equal(task.botId, target.botId);
    assert.equal(task.usage.tokenLimit, 10);
    assert.equal(task.runs.length, 1);
    assert.equal(task.events.filter((event) => event.kind === "task.created").length, 1);
    assert.equal(task.resultSummary, null);
    assert.equal(task.cancelRequested, false);
  });
  assert(task);
  const taskId = task.id;
  await check("changed idempotency payload", () =>
    error("/api/v1/tasks", 409, {
      method: "POST",
      body: { ...create, objective: "Changed objective" },
    }),
  );
  await check("persisted task projection", async () => {
    const result = await request(`/api/v1/tasks/${taskId}`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(workSnapshotWireSchema.parse(result.body), task);
  });
  await check("immutable native scope", async () => {
    const result = await request(`/api/v1/tasks/${taskId}/scope`);
    assert.equal(result.response.status, 200);
    const parsed = z.object({ scope: nativeTaskScopeSchema }).strict().parse(result.body);
    const { sha256, attachments, ...scope } = parsed.scope;
    assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(attachments, []);
    assert.deepEqual(scope, create.scope);
  });
  await check("correction request and idempotent replay", async () => {
    const body = {
      runId: task?.runs[0]?.id,
      instruction: "Retain synthetic evidence",
      requestKey: randomUUID(),
      expectedSequence: 0,
    };
    const path = `/api/v1/tasks/${taskId}/corrections`;
    const first = await request(path, { method: "POST", body });
    assert.equal(first.response.status, 202);
    const correction = workCorrectionSchema.parse(first.body);
    assert.equal(correction.taskId, taskId);
    assert.equal(correction.sequence, 1);
    const replay = await request(path, { method: "POST", body });
    assert.equal(replay.response.status, 202);
    assert.deepEqual(workCorrectionSchema.parse(replay.body), correction);
  });
  await check("missing action decision", () =>
    error(`/api/v1/actions/${missing}/decision`, 404, {
      method: "POST",
      body: { intentDigest: "a".repeat(64), approved: true },
    }),
  );
  await check("missing action reconciliation", () =>
    error(`/api/v1/actions/${missing}/reconcile`, 404, {
      method: "POST",
      body: {
        intentDigest: "a".repeat(64),
        requestKey: randomUUID(),
        expectedSequence: 0,
        reason: "Review",
      },
    }),
  );
  await check("missing artifact", () => error(`/api/v1/artifacts/${missing}`, 404, {}));
  await check("cancel command refuses extra fields", () =>
    error(`/api/v1/tasks/${taskId}/cancel`, 422, {
      method: "POST",
      body: { extra: true },
    }),
  );
  await check("cancel closes authority and persists", async () => {
    const result = await request(`/api/v1/tasks/${taskId}/cancel`, { method: "POST", body: {} });
    assert.equal(result.response.status, 200);
    const cancelled = workSnapshotWireSchema.parse(result.body);
    assert.equal(cancelled.id, taskId);
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.authorityActive, false);
    const read = await request(`/api/v1/tasks/${taskId}`);
    assert.equal(read.response.status, 200);
    assertCancelledSnapshotPersisted(cancelled, workSnapshotWireSchema.parse(read.body));
  });
  if (scenario !== undefined) {
    const work = workScenarioSchema.parse(scenario);
    const action = (kind: keyof typeof work.actions) => `/api/v1/actions/${work.actions[kind]}`;
    const decision = { intentDigest: work.intentDigest, approved: true };
    const read = async () => {
      const result = await request(`/api/v1/tasks/${work.taskId}`);
      assert.equal(result.response.status, 200);
      return workSnapshotWireSchema.parse(result.body);
    };
    await check(
      "published action decisions enforce Owner and Origin before body parsing",
      async () => {
        await error(`${action("approve")}/decision`, 401, {
          method: "POST",
          rawBody: "invalid",
          cookie: false,
        });
        await error(`${action("approve")}/decision`, 403, {
          method: "POST",
          rawBody: "invalid",
          origin: "https://foreign.invalid",
        });
        await error(`${action("unknown")}/reconcile`, 401, {
          method: "POST",
          rawBody: "invalid",
          cookie: false,
        });
        await error(`${action("unknown")}/reconcile`, 403, {
          method: "POST",
          rawBody: "invalid",
          origin: "https://foreign.invalid",
        });
      },
    );
    await check("concurrent identical approval commits one decision and event", async () => {
      const results = await Promise.all(
        [1, 2].map(() =>
          request(`${action("approve")}/decision`, { method: "POST", body: decision }),
        ),
      );
      const views = results.map((result) => {
        assert.equal(result.response.status, 200);
        return workSnapshotWireSchema.parse(result.body);
      });
      assert.deepEqual(views[0], views[1]);
      assert.equal(
        views[0]?.actions.find((item) => item.id === work.actions.approve)?.decision,
        "approved",
      );
      assert.equal(
        views[0]?.events.filter(
          (event) =>
            event.kind === "action.decided" && event.payload.actionId === work.actions.approve,
        ).length,
        1,
      );
      await error(`${action("approve")}/decision`, 409, {
        method: "POST",
        body: { ...decision, approved: false },
      });
    });
    await check("rejection persists denied without admitting or executing an action", async () => {
      const result = await request(`${action("reject")}/decision`, {
        method: "POST",
        body: { ...decision, approved: false },
      });
      assert.equal(result.response.status, 200);
      const rejected = workSnapshotWireSchema
        .parse(result.body)
        .actions.find((item) => item.id === work.actions.reject);
      assert.equal(rejected?.decision, "denied");
      assert.equal(rejected?.status, "proposed");
      assert.equal(rejected?.actualTokens, null);
    });
    await check(
      "expired, stale generation, changed digest and admitted decisions are refused",
      async () => {
        for (const kind of ["expired", "stale", "unknown"] as const)
          await error(`${action(kind)}/decision`, 409, { method: "POST", body: decision });
        await error(`${action("approve")}/decision`, 409, {
          method: "POST",
          body: { ...decision, intentDigest: "0".repeat(64) },
        });
      },
    );
    const repair = {
      intentDigest: work.intentDigest,
      requestKey: randomUUID(),
      expectedSequence: 0,
      reason: "Lookup synthetic unknown outcome",
    };
    let command: ReturnType<typeof workReconciliationSchema.parse>;
    await check(
      "concurrent reconciliation returns one durable lookup command and event",
      async () => {
        const results = await Promise.all(
          [repair, { ...repair, requestKey: randomUUID() }].map((body) =>
            request(`${action("unknown")}/reconcile`, { method: "POST", body }),
          ),
        );
        const commands = results.map((result) => {
          assert.equal(result.response.status, 202);
          return workReconciliationSchema.parse(result.body);
        });
        assert.deepEqual(commands[0], commands[1]);
        command = commands[0]!;
        assert.equal(command.actionId, work.actions.unknown);
        assert.equal(command.sequence, 1);
        assert.equal(command.delivered, false);
        assert.equal(command.outcome, null);
        const view = await read();
        assert.deepEqual(
          view.actions.find((item) => item.id === work.actions.unknown)?.reconciliation,
          command,
        );
        assert.equal(
          view.events.filter((event) => event.kind === "reconciliation.requested").length,
          1,
        );
      },
    );
    await check(
      "reconciliation replay preserves identity and refuses altered requests or stale sequence",
      async () => {
        const replay = await request(`${action("unknown")}/reconcile`, {
          method: "POST",
          body: repair,
        });
        assert.equal(replay.response.status, 202);
        assert.deepEqual(workReconciliationSchema.parse(replay.body), command);
        for (const body of [
          { ...repair, reason: "Changed request" },
          { ...repair, requestKey: randomUUID(), expectedSequence: 2 },
          { ...repair, requestKey: randomUUID(), intentDigest: "0".repeat(64) },
        ])
          await error(`${action("unknown")}/reconcile`, 409, { method: "POST", body });
        await error(`${action("approve")}/reconcile`, 409, {
          method: "POST",
          body: { ...repair, requestKey: randomUUID() },
        });
      },
    );
    await check(
      "cancelled authority preserves lookup replay without granting approval or resolving facts",
      async () => {
        const cancelled = await request(`/api/v1/tasks/${work.taskId}/cancel`, {
          method: "POST",
          body: {},
        });
        assert.equal(cancelled.response.status, 200);
        const result = await request(`${action("unknown")}/reconcile`, {
          method: "POST",
          body: repair,
        });
        assert.equal(result.response.status, 202);
        assert.deepEqual(workReconciliationSchema.parse(result.body), command);
        await error(`${action("approve")}/decision`, 409, { method: "POST", body: decision });
        const view = await read(),
          unknown = view.actions.find((item) => item.id === work.actions.unknown);
        assert.equal(view.authorityActive, false);
        assert.equal(view.cancelRequested, true);
        assert.equal(unknown?.status, "unknown");
        assert.equal(unknown?.actualTokens, null);
        assert.equal(unknown?.evidence, null);
        assert.equal(view.usage.spentTokens, 0);
      },
    );
  }
  return { count: passed.length, passed };
}
