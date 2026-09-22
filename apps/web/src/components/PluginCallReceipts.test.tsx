// @vitest-environment jsdom
import type { Run } from "@openbot/domain";
import type { PluginCallReceipt } from "@openbot/protocol";
import { act, StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPluginCallReceipts } from "../plugin-api";
import {
  deferred,
  interact,
  type RenderedComponent,
  renderComponent,
} from "../test/render-component";
import { PluginCallReceipts } from "./PluginCallReceipts";
import { RunInspector } from "./RunInspector";

vi.mock("../plugin-api", () => ({ listPluginCallReceipts: vi.fn() }));
const receipt: PluginCallReceipt = {
  id: "10000000-0000-4000-8000-000000000001",
  pluginId: "10000000-0000-4000-8000-000000000002",
  pluginRevision: "10000000-0000-4000-8000-000000000003",
  runId: "run-1",
  channelId: "channel-1",
  botId: "bot-1",
  pluginName: "Fixture plugin",
  toolName: "write_report",
  mode: "confirm",
  state: "outcome_unknown",
  approvalDecision: "approved",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:01:00Z",
  approvalRequestedAt: "2026-09-23T00:00:10Z",
  approvalDecidedAt: "2026-09-23T00:00:20Z",
  dispatchedAt: "2026-09-23T00:00:30Z",
};
const views: RenderedComponent[] = [];
const read = vi.mocked(listPluginCallReceipts);
async function render(element = <PluginCallReceipts runId={receipt.runId} />) {
  const view = await renderComponent(element);
  views.push(view);
  return view.container;
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
beforeEach(() => {
  vi.useFakeTimers();
  read.mockReset().mockResolvedValue([receipt]);
});
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  vi.useRealTimers();
});

describe("task call receipts", () => {
  it("keeps Server order, prioritizes unknown outcomes and collapses settled metadata", async () => {
    read.mockResolvedValue([
      receipt,
      { ...receipt, id: "pending", state: "dispatching" },
      {
        ...receipt,
        id: "received",
        state: "response_received",
        responseReceivedAt: receipt.updatedAt,
      },
      { ...receipt, id: "refused", state: "not_dispatched", approvalDecision: "rejected" },
    ]);
    const container = await render();
    expect(container.textContent).toContain("任务失败或取消不代表外部动作未发生");
    expect(container.textContent).toContain("请先在原服务核对");
    expect(container.textContent).toContain("收到答复不代表已独立证实外部结果");
    expect(container.textContent).toContain("Owner 已批准");
    expect(container.textContent).toContain("Owner 已拒绝");
    expect(container.textContent).toContain("工具答复已收到");
    expect(container.textContent).toContain("尚未派发");
    expect(container.textContent).toContain(receipt.id);
    expect(container.querySelector("time")?.dateTime).toBe(receipt.createdAt);
    expect([...container.querySelectorAll(".receipt-state")].map((el) => el.textContent)).toEqual([
      "结果待核对",
      "正在派发调用",
      "工具答复已收到",
      "尚未派发",
    ]);
    expect([...container.querySelectorAll("details")].every((details) => !details.open)).toBe(true);
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "刷新回执",
    ]);
  });
  it.each([
    ["preparing", null, "准备调用", "尚无审批决定"],
    ["awaiting_approval", null, "等待审批", "尚无审批决定"],
    ["not_dispatched", "expired", "尚未派发", "审批已过期"],
    ["not_dispatched", "interrupted", "尚未派发", "审批已中断"],
  ] as const)("renders %s and its approval fact", async (state, approvalDecision, label, fact) => {
    read.mockResolvedValue([{ ...receipt, state, approvalDecision }]);
    const container = await render();
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain(fact);
  });
  it("does not invent an approval for read grants or interpret plugin text as markup", async () => {
    read.mockResolvedValue([
      { ...receipt, mode: "read", approvalDecision: null, pluginName: "<img src=x>" },
    ]);
    const container = await render();
    expect(container.textContent).toContain("只读授权，无需逐次审批");
    expect(container.textContent).toContain("<img src=x>");
    expect(container.querySelector("img")).toBeNull();
  });
  it("keeps empty fixture receipts invisible", async () => {
    read.mockResolvedValue([]);
    const container = await render();
    expect(container.textContent).toBe("");
  });
  it("reads a terminal Run independently and places unknown guidance before task submission", async () => {
    const run: Run = {
      id: receipt.runId,
      channelId: receipt.channelId,
      botId: receipt.botId,
      title: "Fixture",
      instruction: "Synthetic",
      status: "cancelled",
      executionProfile: "none",
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
    };
    const container = await render(
      <RunInspector
        run={run}
        artifacts={[]}
        bot={undefined}
        node={undefined}
        progress={[]}
        liveFrame={undefined}
        onClose={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(container.textContent?.indexOf("结果待核对")).toBeLessThan(
      container.textContent?.indexOf("重新提交任务") ?? 0,
    );
    await advance(5000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("never overlaps slow reads and pauses after 24 reads", async () => {
    const pending = deferred<PluginCallReceipt[]>();
    read.mockReturnValueOnce(pending.promise);
    const container = await render();
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    await interact(() => pending.resolve([receipt]));
    await advance(5000 * 23);
    expect(read).toHaveBeenCalledTimes(24);
    expect(container.textContent).toContain("自动更新已暂停");
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(24);
  });
  it("retains known receipts on error, stops automatic reads, and refresh only reads again", async () => {
    read.mockResolvedValueOnce([receipt]).mockRejectedValueOnce(new Error("secret remote detail"));
    const container = await render();
    await advance(5000);
    expect(container.textContent).toContain(receipt.id);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "已有记录不代表最新状态",
    );
    expect(container.textContent).not.toContain("secret remote detail");
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    await interact(() => container.querySelector("button")?.click());
    expect(read).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("aborts and hides previous Run data before late reads can settle", async () => {
    const stale = deferred<PluginCallReceipt[]>();
    read.mockResolvedValueOnce([receipt]).mockReturnValueOnce(stale.promise).mockResolvedValue([]);
    function Selection() {
      const [runId, setRunId] = useState(receipt.runId);
      return (
        <>
          <button type="button" onClick={() => setRunId("run-2")}>
            Switch
          </button>
          <PluginCallReceipts runId={runId} />
        </>
      );
    }
    const container = await render(<Selection />);
    await advance(5000);
    const signal = read.mock.calls[1]?.[1];
    await interact(() => container.querySelector("button")?.click());
    expect(signal?.aborted).toBe(true);
    expect(container.textContent).not.toContain(receipt.id);
    await interact(() => stale.resolve([receipt]));
    expect(container.textContent).toBe("Switch");
  });
  it("cleans StrictMode lifetimes and aborts active reads on unmount", async () => {
    const pending = deferred<PluginCallReceipt[]>();
    read.mockReturnValue(pending.promise);
    await render(
      <StrictMode>
        <PluginCallReceipts runId={receipt.runId} />
      </StrictMode>,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[1]?.aborted).toBe(true);
    const view = views.pop();
    await view?.unmount();
    expect(read.mock.calls[1]?.[1]?.aborted).toBe(true);
    await interact(() => pending.resolve([receipt]));
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("clears the next scheduled read on unmount and keeps 256 settled calls collapsed", async () => {
    read.mockResolvedValue(
      Array.from({ length: 256 }, (_, index) => ({
        ...receipt,
        id: String(index),
        state: "response_received" as const,
      })),
    );
    const container = await render();
    expect(container.textContent).toContain("已终结回执（256）");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("本次查询上限 256 条");
    await views.pop()?.unmount();
    await advance(60_000);
    expect(read).toHaveBeenCalledOnce();
  });
});
