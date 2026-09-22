import { randomUUID } from "node:crypto";
import { createDatabase } from "@openbot/db";
import type { ExecutionNode } from "@openbot/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresChannelInteractions } from "./channel-interactions-store.js";
import { StoreConflictError, StoreNotFoundError } from "./control-plane-store.js";
import { PostgresControlPlaneStore } from "./postgres-store.js";

const url = process.env.OPENBOT_WORKER_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/(?:openbot_worker_test_[a-z0-9_]+|openbot_dev_smoke)$/.test(target.pathname) ||
    target.search ||
    target.hash
  )
    throw new Error(
      "Worker tests require a disposable loopback openbot_worker_test_* or driver-owned openbot_dev_smoke database.",
    );
}
const node: ExecutionNode = {
  id: "cancellation-node",
  name: "Cancellation fixture",
  platform: "linux",
  osVersion: "fixture",
  architecture: "x64",
  deviceClass: "server",
  isolation: "unknown",
  trustTier: "development",
  capabilities: ["browser"],
  capabilityManifest: [],
  maxConcurrentRuns: 2,
  activeRunIds: [],
  connectedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
};

describe.skipIf(!url)("Worker cancellation PostgreSQL transactions", () => {
  const database = url ? createDatabase(url) : undefined;
  const peer = url ? createDatabase(url) : undefined;
  const store = database ? new PostgresControlPlaneStore(database.db) : undefined;
  const other = peer ? new PostgresControlPlaneStore(peer.db) : undefined;
  beforeAll(async () => {
    await database?.migrate();
  });
  beforeEach(async () => {
    if (!database) return;
    await database.client`set client_min_messages = warning`;
    await database.client`truncate bots, channels, nodes cascade`;
  });
  afterAll(async () => {
    await Promise.all([database?.close(), peer?.close()]);
  });
  async function fixture(
    status: "queued" | "assigned" | "running" | "waiting_approval" = "running",
  ) {
    if (!store || !other || !database) throw new Error("Missing fixture database.");
    await store.upsertNode(node);
    const bot = await store.createBot({
      name: `Worker ${randomUUID()}`,
      role: "fixture",
      computerProfile: "docker-linux",
    });
    const channel = await store.createChannel({
      name: `Cancellation ${randomUUID()}`,
      description: "fixture",
      botIds: [bot.id],
    });
    const { run } = await store.submitTask(channel.id, {
      botId: bot.id,
      content: "Open https://example.test",
    });
    if (status !== "queued") await store.assignRun(run.id, node.id);
    if (status === "running" || status === "waiting_approval")
      await store.startRun(run.id, node.id);
    const approval =
      status === "waiting_approval"
        ? (
            await store.requestApproval(run.id, node.id, {
              requestId: randomUUID(),
              action: "browser.click",
              target: "https://example.test",
              summary: "Click",
              risk: "privileged",
              beforeState: { ref: "fixture" },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            })
          )?.approval
        : undefined;
    return { store, other, database, bot, channel, run, approval };
  }
  it.each(["queued", "assigned", "running", "waiting_approval"] as const)(
    "cancels %s once, rejects late writes, and preserves the audit reason",
    async (status) => {
      const f = await fixture(status);
      const results = await Promise.all([
        f.store.cancelWorkerRun(f.run.id),
        f.other.cancelWorkerRun(f.run.id),
      ]);
      expect(results.every(({ run }) => run.status === "cancelled")).toBe(true);
      expect(await f.store.assignRun(f.run.id, node.id)).toBeUndefined();
      expect(await f.store.startRun(f.run.id, node.id)).toBeUndefined();
      expect(
        await f.store.completeRun(f.run.id, node.id, "Late result", [artifact(f.run.id)]),
      ).toBeUndefined();
      expect(await f.store.failRun(f.run.id, node.id, "Late failure")).toBeUndefined();
      expect(
        await f.store.appendRunProgress(f.run.id, node.id, "late", "Late progress"),
      ).toBeUndefined();
      expect(await f.store.listArtifacts(f.run.id)).toEqual([]);
      expect(
        (await f.store.listMessages(f.channel.id)).some((m) => m.content === "Late result"),
      ).toBe(false);
      if (f.approval) {
        expect((await f.store.listApprovals()).find((a) => a.id === f.approval?.id)?.status).toBe(
          "expired",
        );
        await expect(
          f.other.decideApproval(f.approval.id, "approve", "owner"),
        ).rejects.toBeInstanceOf(StoreConflictError);
      }
      const events = await f.database
        .client`select type, payload from run_events where run_id = ${f.run.id}`;
      expect(events.filter((e) => e.type === "RUN_CANCELLED")).toHaveLength(1);
      expect(events.find((e) => e.type === "RUN_CANCELLED")?.payload).toMatchObject({
        reason: "owner_cancelled",
        externalOutcome: ["queued", "assigned"].includes(status) ? "not_started" : "unknown",
      });
      expect(events.filter((e) => e.type === "APPROVAL_EXPIRED")).toHaveLength(f.approval ? 1 : 0);
    },
  );
  it.each(["approval", "assignment", "completion", "approval-request"])(
    "serializes concurrent cancellation and %s without resurrection",
    async (operation) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const f = await fixture(
          operation === "approval"
            ? "waiting_approval"
            : operation === "assignment"
              ? "queued"
              : "running",
        );
        const competing = () =>
          operation === "approval"
            ? f.other.decideApproval(required(f.approval).id, "approve", "owner")
            : operation === "assignment"
              ? f.other.assignRun(f.run.id, node.id)
              : operation === "completion"
                ? f.other.completeRun(f.run.id, node.id, "Winner", [artifact(f.run.id)])
                : f.other.requestApproval(f.run.id, node.id, {
                    requestId: randomUUID(),
                    action: "browser.click",
                    target: "https://example.test",
                    summary: "Click",
                    risk: "privileged",
                    beforeState: {},
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  });
        const cancel = () => f.store.cancelWorkerRun(f.run.id);
        const outcomes = await Promise.allSettled(
          attempt % 2 ? [competing(), cancel()] : [cancel(), competing()],
        );
        for (const outcome of outcomes)
          if (outcome.status === "rejected")
            expect(outcome.reason).toBeInstanceOf(StoreConflictError);
        const current = required(
          (await f.store.listRuns(f.channel.id)).find((r) => r.id === f.run.id),
        );
        expect(operation === "completion" ? ["cancelled", "completed"] : ["cancelled"]).toContain(
          current.status,
        );
        expect(await f.store.listArtifacts(f.run.id)).toHaveLength(
          current.status === "completed" ? 1 : 0,
        );
        const approvals = (await f.store.listApprovals()).filter((a) => a.runId === f.run.id);
        expect(approvals.every((a) => ["approved", "expired"].includes(a.status))).toBe(true);
        if (f.approval)
          await expect(
            f.store.decideApproval(f.approval.id, "approve", "owner"),
          ).rejects.toBeInstanceOf(StoreConflictError);
      }
    },
  );
  it("retains a committed approval decision after cancellation and a completed result after a late cancel", async () => {
    const f = await fixture("waiting_approval");
    await f.store.decideApproval(required(f.approval).id, "approve", "owner");
    await f.other.cancelWorkerRun(f.run.id);
    expect(
      (await f.store.listApprovals()).find((a) => a.id === required(f.approval).id)?.status,
    ).toBe("approved");
    const finished = await fixture();
    await finished.store.completeRun(finished.run.id, node.id, "Committed", [
      artifact(finished.run.id),
    ]);
    await expect(finished.other.cancelWorkerRun(finished.run.id)).rejects.toBeInstanceOf(
      StoreConflictError,
    );
    expect((await finished.store.listRuns(finished.channel.id))[0]?.status).toBe("completed");
    expect(await finished.store.listArtifacts(finished.run.id)).toHaveLength(1);
    await expect(finished.store.cancelWorkerRun(randomUUID())).rejects.toBeInstanceOf(
      StoreNotFoundError,
    );
  });
  it("rolls back cancellation and approval invalidation when its audit write fails", async () => {
    const f = await fixture("waiting_approval");
    await f.database
      .client`create function worker_cancel_audit_fault() returns trigger language plpgsql as $$ begin if NEW.type = 'RUN_CANCELLED' then raise exception 'fixture audit unavailable'; end if; return NEW; end $$`;
    await f.database
      .client`create trigger worker_cancel_audit_fault before insert on run_events for each row execute function worker_cancel_audit_fault()`;
    try {
      await expect(f.store.cancelWorkerRun(f.run.id)).rejects.toThrow();
      expect((await f.store.listRuns(f.channel.id))[0]?.status).toBe("waiting_approval");
      expect((await f.store.listApprovals())[0]?.status).toBe("pending");
      const events = await f.database
        .client`select type from run_events where run_id = ${f.run.id}`;
      expect(
        events.some((event) => ["RUN_CANCELLED", "APPROVAL_EXPIRED"].includes(event.type)),
      ).toBe(false);
    } finally {
      await f.database.client`drop trigger worker_cancel_audit_fault on run_events`;
      await f.database.client`drop function worker_cancel_audit_fault()`;
    }
    expect((await f.store.cancelWorkerRun(f.run.id)).run.status).toBe("cancelled");
  });
  it.each(["disconnect", "restart"])(
    "%s closes pending approvals in the same transaction and rejects later decisions",
    async (mode) => {
      const f = await fixture("waiting_approval");
      const failed = await f.store.failRunningRuns(mode === "disconnect" ? node.id : undefined);
      expect(failed.map((r) => [r.id, r.status])).toEqual([[f.run.id, "failed"]]);
      expect(await f.store.failRunningRuns()).toEqual([]);
      expect((await f.store.listApprovals())[0]?.status).toBe("expired");
      await expect(
        f.other.decideApproval(required(f.approval).id, "approve", "owner"),
      ).rejects.toBeInstanceOf(StoreConflictError);
      const events = await f.database
        .client`select type, payload from run_events where run_id = ${f.run.id}`;
      expect(events.filter((e) => e.type === "APPROVAL_EXPIRED")).toHaveLength(1);
      expect(events.find((e) => e.type === "APPROVAL_EXPIRED")?.payload.reason).toBe(
        mode === "disconnect" ? "node_unavailable" : "server_recovery",
      );
    },
  );
  it("uses the same Run-to-approval lock order as channel membership removal", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const f = await fixture("waiting_approval");
      const interactions = new PostgresChannelInteractions(required(peer).db);
      const results = await Promise.allSettled([
        f.store.decideApproval(required(f.approval).id, "approve", "owner"),
        interactions.removeMember(f.channel.id, f.bot.id),
      ]);
      for (const result of results)
        if (result.status === "rejected") {
          if (!(result.reason instanceof StoreConflictError))
            throw new Error("Unexpected concurrent transaction failure", { cause: result.reason });
        }
      expect((await f.store.listRuns(f.channel.id))[0]?.status).toBe("cancelled");
      expect(
        (await f.store.listApprovals()).find((a) => a.id === required(f.approval).id)?.status,
      ).not.toBe("pending");
    }
  });
});
function artifact(runId: string) {
  return {
    id: randomUUID(),
    runId,
    name: "result.txt",
    mediaType: "text/plain",
    storageKey: `fixture/${runId}`,
    sha256: "a".repeat(64),
    metadata: {},
    createdAt: new Date().toISOString(),
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing Worker transaction fixture.");
  return value;
}
