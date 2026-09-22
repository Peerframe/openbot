import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@openbot/domain";
import type { PluginCallReceipt } from "@openbot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  insertCallReceipt,
  pluginCallReceiptLimit,
  sortedCallReceipts,
} from "./plugin-call-receipts.js";
import { createPluginRoutes } from "./plugin-routes.js";
import { PluginService } from "./plugin-service.js";
import { FilePluginStore, type PluginState, recordPluginAudit } from "./plugin-store.js";
import { PluginError } from "./plugin-types.js";

const run = { id: "receipt-run", botId: "receipt-bot", channelId: "receipt-channel" } as Run;
const tool = {
  name: "record",
  description: "Record a synthetic test value.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const acl = {
  protectDirectory: async () => {},
  verifyDirectory: async () => {},
  protectAndVerifyFile: async () => {},
  verifyFile: async () => {},
};

async function fixture(mode: "read" | "confirm" = "read", timeout = 60000) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-call-receipts-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new FilePluginStore(join(directory, "private", "plugins.json"), {
    windowsAcl: acl,
    windowsTrustRoot: directory,
  });
  const effect = vi.fn(async () => ({ content: [{ type: "text", text: "PRIVATE RESULT" }] }));
  const connection = {
    tools: vi.fn(async () => [tool]),
    call: effect,
    close: vi.fn(async () => {}),
  };
  const connector = vi.fn(async () => connection);
  const options = {
    store,
    connector,
    assertScope: async () => {},
    botExists: async () => true,
    runExists: async (id: string) => id === run.id || id === "empty-run",
    approvalTimeoutMs: timeout,
  };
  const service = new PluginService(options);
  cleanups.push(async () => service.close());
  const input = {
    name: "Receipt fixture",
    endpoint: "https://receipt.example.com/mcp",
    token: "PRIVATE-TOKEN",
  };
  const preview = await service.preview(input, AbortSignal.timeout(1000));
  const installed = await service.install(
    { ...input, reviewedDigest: preview.digest },
    AbortSignal.timeout(1000),
  );
  const grant = await service.grant(installed.id, run.botId, {
    revision: installed.revision,
    tools: [{ name: tool.name, mode }],
  });
  const enabled = await service.setEnabled(installed.id, {
    revision: grant.revision,
    enabled: true,
  });
  await service.recover();
  connector.mockClear();
  const call = (signal = AbortSignal.timeout(3000)) =>
    service.call(
      run,
      {
        pluginId: enabled.id,
        revision: enabled.revision,
        toolName: tool.name,
        arguments: { text: "PRIVATE ARGUMENT" },
      },
      signal,
    );
  const pending = async () => {
    let id = "";
    await vi.waitFor(async () => {
      id = (await service.snapshot()).pendingCalls[0]?.id ?? "";
      expect(id).not.toBe("");
    });
    return id;
  };
  return { directory, store, service, options, effect, connection, connector, call, pending };
}

function receipt(state: PluginCallReceipt["state"] = "outcome_unknown"): PluginCallReceipt {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    runId: run.id,
    channelId: run.channelId,
    botId: run.botId,
    pluginId: randomUUID(),
    pluginRevision: randomUUID(),
    pluginName: "Historical fixture",
    toolName: "record",
    mode: "confirm",
    state,
    approvalDecision: "approved",
    createdAt: now,
    updatedAt: now,
  };
}

describe("durable plugin call receipts", () => {
  it("retains the approval decision and safe response metadata after restart without replay", async () => {
    const f = await fixture("confirm");
    const execution = f.call();
    const id = await f.pending();
    await f.service.decide(id, "approve");
    await execution;
    const restarted = new PluginService(f.options);
    const saved = await restarted.receipt(id);
    expect(saved).toMatchObject({
      state: "response_received",
      approvalDecision: "approved",
      runId: run.id,
    });
    expect(saved.approvalDecidedAt).toBeDefined();
    expect(saved.dispatchedAt).toBeDefined();
    expect(saved.responseReceivedAt).toBeDefined();
    await expect(restarted.decide(id, "approve")).rejects.toMatchObject({ code: "not_found" });
    expect(f.effect).toHaveBeenCalledOnce();
    const publicData = JSON.stringify(await restarted.receiptsForRun(run.id));
    for (const secret of ["PRIVATE", "https:", "arguments", "content"])
      expect(publicData).not.toContain(secret);
    expect(await readFile(f.store.path, "utf8")).not.toContain("Receipt fixture");
  });

  it.each(["dispatch", "terminal"])(
    "fails closed when the %s receipt commit fails",
    async (stage) => {
      const f = await fixture();
      const original = f.store.transaction.bind(f.store);
      vi.spyOn(f.store, "transaction").mockImplementation(async (change) =>
        original(async (state) => {
          const value = await change(state);
          if (
            state.callReceipts?.some(
              (call) => call.state === (stage === "dispatch" ? "dispatching" : "response_received"),
            )
          )
            throw new Error("PRIVATE STORAGE FAULT");
          return value;
        }),
      );
      await expect(f.call()).rejects.toMatchObject({ code: "unavailable" });
      const [saved] = await f.service.receiptsForRun(run.id);
      expect(saved?.state).toBe(stage === "dispatch" ? "not_dispatched" : "outcome_unknown");
      expect(f.effect).toHaveBeenCalledTimes(stage === "dispatch" ? 0 : 1);
    },
  );

  it("keeps durable dispatch intent when both completion and error recording fail", async () => {
    const f = await fixture();
    const original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, "transaction").mockImplementation(async (change) =>
      original(async (state) => {
        const value = await change(state);
        if (
          state.callReceipts?.some((call) =>
            ["response_received", "outcome_unknown"].includes(call.state),
          )
        )
          throw new Error("storage lost");
        return value;
      }),
    );
    await expect(f.call()).rejects.toMatchObject({ code: "unavailable" });
    expect((await f.store.read()).callReceipts?.[0]?.state).toBe("dispatching");
    vi.mocked(f.store.transaction).mockRestore();
    expect((await f.service.receiptsForRun(run.id))[0]?.state).toBe("outcome_unknown");
    const restarted = new PluginService(f.options);
    expect((await restarted.receiptsForRun(run.id))[0]?.state).toBe("outcome_unknown");
    expect(f.effect).toHaveBeenCalledOnce();
  });

  it("keeps unknown evidence after cancellation and ignores a late successful response", async () => {
    const f = await fixture();
    const deferred = Promise.withResolvers<Awaited<ReturnType<typeof f.effect>>>();
    f.effect.mockImplementation(() => deferred.promise);
    const abort = new AbortController();
    const execution = f.call(abort.signal);
    const denied = expect(execution).rejects.toMatchObject({ code: "unavailable" });
    await vi.waitFor(() => expect(f.effect).toHaveBeenCalledOnce());
    abort.abort();
    await denied;
    deferred.resolve({ content: [{ type: "text", text: "too late" }] });
    expect((await f.service.receiptsForRun(run.id))[0]?.state).toBe("outcome_unknown");
  });

  it.each(["rejected", "expired", "interrupted"] as const)(
    "records %s approval without an effect",
    async (decision) => {
      const f = await fixture("confirm", decision === "expired" ? 150 : 60000);
      const abort = new AbortController();
      const execution = f.call(abort.signal);
      const denied = expect(execution).rejects.toBeInstanceOf(PluginError);
      const id = await f.pending();
      if (decision === "rejected") await f.service.decide(id, "reject");
      if (decision === "interrupted") abort.abort();
      await denied;
      expect(await f.service.receipt(id)).toMatchObject({
        state: "not_dispatched",
        approvalDecision: decision,
      });
      expect(f.effect).not.toHaveBeenCalled();
    },
  );

  it("preserves unknown calls across 500-event rollover and rejects a full protected ledger before connecting", async () => {
    const f = await fixture();
    const calls = Array.from({ length: pluginCallReceiptLimit }, () => receipt());
    await f.store.transaction((state) => {
      state.callReceipts = calls;
      for (let index = 0; index < 510; index++)
        recordPluginAudit(state, { phase: "unrelated", pluginId: "fixture" });
    });
    await expect(f.call()).rejects.toMatchObject({ code: "unavailable" });
    expect(f.connector).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
    const saved = await f.store.read();
    expect(saved.audit).toHaveLength(500);
    expect(saved.callReceipts).toEqual(calls);
    expect(await new PluginService(f.options).receiptsForRun(run.id)).toHaveLength(256);
  });

  it("evicts only old settled history and lists unknown records before completed ones", async () => {
    const unknown = receipt();
    const state: PluginState = {
      plugins: [],
      audit: [],
      callReceipts: [unknown, ...Array.from({ length: 255 }, () => receipt("response_received"))],
    };
    const next = receipt("preparing");
    insertCallReceipt(state, next);
    expect(state.callReceipts).toHaveLength(256);
    expect(state.callReceipts).toContain(unknown);
    const ordered = sortedCallReceipts(state.callReceipts ?? []);
    expect(ordered[0]?.id).toBe(unknown.id);
    expect(ordered[1]?.id).toBe(next.id);
    expect(sortedCallReceipts(state.callReceipts ?? [])).toEqual(ordered);
  });

  it("loads legacy encrypted files and recovers once without changing decided approval facts", async () => {
    const f = await fixture();
    expect((await f.store.read()).callReceipts).toBeUndefined();
    const approved = receipt("awaiting_approval");
    const waiting = { ...receipt("awaiting_approval"), approvalDecision: null };
    await f.store.transaction((state) => {
      state.callReceipts = [approved, waiting, receipt("dispatching")];
    });
    const restarted = new PluginService(f.options);
    await restarted.recover();
    expect(await restarted.receipt(approved.id)).toMatchObject({
      state: "not_dispatched",
      approvalDecision: "approved",
    });
    expect(await restarted.receipt(waiting.id)).toMatchObject({
      state: "not_dispatched",
      approvalDecision: "interrupted",
    });
    const saved = await f.store.read();
    await restarted.recover();
    expect(await f.store.read()).toEqual(saved);
  });

  it("provides bounded lookups with explicit absent, invalid and unavailable responses", async () => {
    const f = await fixture();
    await f.call();
    const routes = createPluginRoutes(f.service);
    expect((await routes.request("/runs/missing/plugin-calls")).status).toBe(404);
    expect(await (await routes.request("/runs/empty-run/plugin-calls")).json()).toEqual({
      calls: [],
    });
    expect((await routes.request(`/plugin-calls/${randomUUID()}`)).status).toBe(404);
    expect((await routes.request("/plugin-calls/invalid")).status).toBe(400);
    const { calls } = await (await routes.request(`/runs/${run.id}/plugin-calls`)).json();
    expect(await (await routes.request(`/plugin-calls/${calls[0].id}`)).json()).toEqual({
      call: calls[0],
    });
    vi.spyOn(f.store, "read").mockRejectedValueOnce(new Error("PRIVATE FAILURE"));
    const failed = await routes.request(`/plugin-calls/${calls[0].id}`);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("PRIVATE");
  });
});
