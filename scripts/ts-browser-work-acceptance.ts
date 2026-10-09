import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { workSnapshotWireSchema, type BrowserCommand } from "../packages/protocol/dist/index.js";
export type WorkerExercise = {
  api: (
    path: string,
    method?: string,
    body?: unknown,
    authenticated?: boolean,
  ) => Promise<{ status: number; value: unknown }>;
  commands: BrowserCommand[];
  download: (path: string) => Promise<Buffer>;
  humanSession: string;
  disconnectNext: () => void;
  redirectNext: () => void;
  reconnect: () => Promise<void>;
};
/** Product authority and durable effects on actual PG/Temporal/WS; peer page/image data is deterministic, not a real browser engine. */
export async function qualifyBrowserWork(
  context: WorkerExercise,
  botId: string,
  channelId: string,
) {
  const { api, commands } = context;
  const snapshot = async (id: string) => {
    const response = await api("/api/v1/tasks/" + id);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return workSnapshotWireSchema.parse(response.value);
  };
  type Task = Awaited<ReturnType<typeof snapshot>>;
  const wait = async (id: string, predicate: (task: Task) => boolean) => {
    const deadline = Date.now() + 45000;
    let value: Task;
    do {
      value = await snapshot(id);
      if (predicate(value)) return value;
      await delay(150);
    } while (Date.now() < deadline);
    assert.fail("Browser Work state: " + JSON.stringify(value));
  };
  const create = async (label: string) => {
    const response = await api(`/api/v1/channels/${channelId}/messages`, "POST", {
      botId,
      content: label,
    });
    assert.equal(response.status, 201, JSON.stringify(response.value));
    const value = response.value as { run: { workTaskId: string } };
    return value.run.workTaskId;
  };
  const approve = async (action: Task["actions"][number]) => {
    const response = await api(`/api/v1/actions/${action.id}/decision`, "POST", {
      intentDigest: action.intentDigest,
      approved: true,
    });
    assert.equal(response.status, 200, JSON.stringify(response.value));
  };
  const pending = async (id: string) => {
    const task = await wait(
      id,
      (t) => t.actions.some((a) => a.decision === "pending") || t.status === "failed",
    );
    assert.notEqual(task.status, "failed", JSON.stringify(task));
    return task.actions.find((a) => a.decision === "pending")!;
  };
  const taskId = await create("Browser Task complete"),
    before = commands.length;
  let approved = 0;
  while (true) {
    const state = await wait(
      taskId,
      (t) =>
        t.actions.some((a) => a.decision === "pending") ||
        ["completed", "failed"].includes(t.status),
    );
    if (state.status === "completed") {
      assert.equal(approved, 4);
      assert.equal(state.artifacts.filter((a) => a.mediaType === "image/png").length, 1);
      assert.equal(
        state.actions
          .filter(
            (a) =>
              a.intent.tool === "capture_browser" || String(a.intent.tool).endsWith("_browser"),
          )
          .every((a) => a.status === "applied" && a.decision === "approved"),
        true,
      );
      break;
    }
    assert.notEqual(state.status, "failed", JSON.stringify(state));
    assert.equal(
      commands.length,
      before + approved,
      "Only previously approved operations may reach the Worker",
    );
    assert.equal(state.artifacts.length, 0, "Capture is private until review and completion");
    await approve(state.actions.find((a) => a.decision === "pending")!);
    approved++;
  }
  assert.deepEqual(
    commands
      .slice(before)
      .map((c) => (c.action.kind === "agent" ? c.action.operation.kind : c.action.kind)),
    ["observe", "navigate", "type", "read"],
  );
  const completed = await snapshot(taskId),
    image = completed.artifacts.find((a) => a.mediaType === "image/png")!;
  const imageBytes = await context.download(image.downloadUrl);
  assert.equal(imageBytes.length, 24);
  assert.equal(imageBytes.readUInt32BE(16), 1);
  console.log(
    "PASS TS browser Work: real channel/Temporal/approval/WS, frozen page origin and observation binding, four separately approved effects, independent review and PNG publication",
  );
  const stale = await create("Browser Task human takeover"),
    staleAction = await pending(stale),
    staleBefore = commands.length;
  for (const kind of ["take", "release"])
    assert.equal(
      (await api(`/api/v1/browser-sessions/${context.humanSession}/commands`, "POST", { kind }))
        .status,
      200,
    );
  await approve(staleAction);
  const stopped = await wait(stale, (t) => t.status === "failed");
  assert.equal(stopped.artifacts.length, 0);
  assert.equal(
    commands.length,
    staleBefore + 2,
    "Human revision change must prevent the approved old task effect",
  );
  console.log(
    "PASS human takeover/release invalidates a pending browser Task operation before dispatch",
  );
  const lost = await create("Browser Task lost reply"),
    lostAction = await pending(lost),
    lostBefore = commands.length;
  context.disconnectNext();
  await approve(lostAction);
  const unknown = await wait(lost, (t) =>
    t.actions.some((a) => a.id === lostAction.id && a.status === "unknown"),
  );
  assert.equal(unknown.artifacts.length, 0);
  assert.equal(commands.length, lostBefore + 1);
  await context.reconnect();
  assert.equal(
    (
      await api(`/api/v1/actions/${lostAction.id}/reconcile`, "POST", {
        intentDigest: lostAction.intentDigest,
        requestKey: randomUUID(),
        expectedSequence: 0,
        reason: "Lookup original browser receipt",
      })
    ).status,
    202,
  );
  await wait(lost, (t) =>
    t.actions.some((a) => a.id === lostAction.id && a.reconciliation?.outcome === "unresolved"),
  );
  assert.equal(
    commands.length,
    lostBefore + 1,
    "Recovery must not recapture on a replacement connection",
  );
  assert.equal(
    (await snapshot(lost)).actions.find((a) => a.id === lostAction.id)?.status,
    "unknown",
  );
  assert.equal((await api(`/api/v1/tasks/${lost}/cancel`, "POST", {})).status, 200);
  console.log(
    "PASS lost browser reply remains unknown across reconnect/reconciliation with exactly one dispatch and no publication",
  );
  // Opening only binds the same stable credential. The new connection has a new transport identity.
  assert.equal((await api(`/api/v1/bots/${botId}/browser`, "POST")).status, 201);
  const redirect = await create("Browser Task redirect"),
    redirectAction = await pending(redirect),
    redirectBefore = commands.length;
  context.redirectNext();
  await approve(redirectAction);
  const denied = await wait(redirect, (t) =>
    t.actions.some((a) => a.id === redirectAction.id && a.status === "unknown"),
  );
  assert.equal(denied.artifacts.length, 0);
  assert.equal(commands.length, redirectBefore + 1);
  assert.equal((await api(`/api/v1/tasks/${redirect}/cancel`, "POST", {})).status, 200);
  console.log(
    "PASS executor page redirect outside the frozen trusted origin produces no accepted observation or artifact",
  );
}
