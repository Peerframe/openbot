// @vitest-environment jsdom
import type { Run } from "@openbot/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelNativeRun, createMessage } from "../api";
import { deferred, interact, renderComponent } from "../test/render-component";
import { NativeRunControls, nativeRunFailure } from "./NativeRunControls";
import { RunInspector } from "./RunInspector";

vi.mock("../api", () => ({
  cancelNativeRun: vi.fn(),
  createMessage: vi.fn(),
  ApiError: class extends Error {
    status = 500;
  },
}));
const run: Run = {
  id: "run-1",
  channelId: "channel-1",
  botId: "bot-1",
  executionProfile: "none",
  instruction: "Prepare a report",
  title: "Report",
  status: "running",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:01Z",
};
beforeEach(() => vi.clearAllMocks());
describe("native task execution controls", () => {
  it.each(["none", "model"] as const)(
    "waits for durable %s cancellation and prevents duplicate requests",
    async (executionProfile) => {
      const pending = deferred<Run>();
      vi.mocked(cancelNativeRun).mockReturnValue(pending.promise);
      const onRun = vi.fn();
      const view = await renderComponent(
        <NativeRunControls run={{ ...run, executionProfile }} onRun={onRun} />,
      );
      try {
        const button = view.container.querySelector("button");
        await interact(() => button?.click());
        expect(button?.disabled).toBe(true);
        expect(onRun).not.toHaveBeenCalled();
        await interact(() => button?.click());
        expect(cancelNativeRun).toHaveBeenCalledExactlyOnceWith(run.id);
        const cancelled = { ...run, status: "cancelled" as const };
        await interact(() => pending.resolve(cancelled));
        expect(onRun).toHaveBeenCalledExactlyOnceWith(cancelled);
      } finally {
        await view.unmount();
      }
    },
  );
  it("resubmits the original instruction through normal task creation only on explicit click", async () => {
    const next = { ...run, id: "new-run", status: "queued" as const };
    vi.mocked(createMessage).mockResolvedValue({
      run: next,
      message: {
        id: "message",
        channelId: run.channelId,
        authorType: "human",
        content: run.instruction,
        createdAt: run.createdAt,
      },
    });
    const onRun = vi.fn();
    const view = await renderComponent(
      <NativeRunControls run={{ ...run, status: "cancelled" }} onRun={onRun} />,
    );
    try {
      expect(createMessage).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("从头创建");
      await interact(() => view.container.querySelector("button")?.click());
      expect(createMessage).toHaveBeenCalledExactlyOnceWith(run.channelId, {
        content: run.instruction,
        botId: run.botId,
      });
      expect(onRun).toHaveBeenCalledExactlyOnceWith(next);
    } finally {
      await view.unmount();
    }
  });
  it("does not expose native cancellation for Worker tasks", async () => {
    const view = await renderComponent(
      <NativeRunControls run={{ ...run, executionProfile: "docker-linux" }} onRun={vi.fn()} />,
    );
    try {
      expect(view.container.querySelector("button")).toBeNull();
    } finally {
      await view.unmount();
    }
  });
  it("explains Server execution, stopped state and real or missing token counts", async () => {
    const view = await renderComponent(
      <RunInspector
        run={{
          ...run,
          status: "cancelled",
          modelUsage: {
            provider: "openai",
            model: "fixture",
            steps: 2,
            inputTokens: 0,
            outputTokens: null,
          },
        }}
        onClose={vi.fn()}
        onRun={vi.fn()}
        bot={undefined}
        node={undefined}
        artifacts={[]}
        progress={[]}
        liveFrame={undefined}
      />,
    );
    try {
      expect(view.container.textContent).toContain("由 Server 执行");
      expect(view.container.textContent).toContain("Owner 已停止");
      expect(view.container.textContent).toContain("输入 0 · 输出 未知");
      expect(view.container.textContent).not.toContain("等待可用节点");
    } finally {
      await view.unmount();
    }
  });
});

describe("native failure classification messages", () => {
  it("distinguishes invalid targets and changed resources from lost channel permission", () => {
    const base = { ...run, status: "failed" as const };
    expect(nativeRunFailure({ ...base, errorCode: "scope_revoked" })).toContain(
      "失去当前频道访问权限",
    );
    expect(nativeRunFailure({ ...base, errorCode: "invalid_target" })).toContain(
      "协作对象或资料无效",
    );
    expect(nativeRunFailure({ ...base, errorCode: "invalid_target" })).not.toContain(
      "失去当前频道访问权限",
    );
    expect(nativeRunFailure({ ...base, errorCode: "conflict" })).toContain("任务状态已变化");
    expect(nativeRunFailure({ ...base, errorCode: "conflict" })).not.toContain(
      "失去当前频道访问权限",
    );
    expect(nativeRunFailure({ ...base, errorCode: "skills_changed" })).toContain("技能发生变化");
    expect(nativeRunFailure({ ...base, errorCode: "memory_changed" })).toContain("记忆发生变化");
  });
});
