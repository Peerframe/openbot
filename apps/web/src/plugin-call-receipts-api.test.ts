import type { PluginCallReceipt } from "@openbot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listPluginCallReceipts } from "./plugin-api";

const receipt: PluginCallReceipt = {
  id: "10000000-0000-4000-8000-000000000001",
  pluginId: "10000000-0000-4000-8000-000000000002",
  pluginRevision: "10000000-0000-4000-8000-000000000003",
  runId: "run/1",
  channelId: "channel-1",
  botId: "bot-1",
  pluginName: "Public fixture",
  toolName: "write_report",
  mode: "confirm",
  state: "outcome_unknown",
  approvalDecision: "approved",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:01:00Z",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Owner receipt read boundary", () => {
  it("uses an encoded, credentialed GET, preserves Server order and composes abort", async () => {
    const second = { ...receipt, id: "10000000-0000-4000-8000-000000000004" };
    const fetch = vi.fn(async () => Response.json({ calls: [receipt, second] }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await listPluginCallReceipts(receipt.runId, controller.signal)).toEqual([
      receipt,
      second,
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/runs/run%2F1/plugin-calls");
    expect(init.credentials).toBe("include");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.method).toBeUndefined();
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });
  it.each([
    { calls: [{ ...receipt, runId: "another-run" }] },
    { calls: [receipt, receipt] },
    { calls: [{ ...receipt, token: "private" }] },
    { calls: [{ ...receipt, state: "success" }] },
    { calls: [{ ...receipt, updatedAt: "invalid" }] },
    { calls: Array(257).fill(receipt) },
    { error: "private detail" },
  ])("rejects invalid, oversized, duplicate or out-of-scope payloads", async (payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload)),
    );
    await expect(listPluginCallReceipts(receipt.runId)).rejects.toThrow("工具调用回执无效。");
  });
  it("does not issue an already aborted request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(listPluginCallReceipts(receipt.runId, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the ten-second deadline even when the caller supplies a lifetime signal", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const reading = listPluginCallReceipts(receipt.runId, new AbortController().signal);
    timeout.abort(new DOMException("Read timeout", "TimeoutError"));
    await expect(reading).rejects.toThrow("Read timeout");
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(10_000);
  });
});
