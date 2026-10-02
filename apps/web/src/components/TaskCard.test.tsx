// @vitest-environment jsdom
import type { Approval, Bot, Run } from "@openbot/domain";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelNativeRun, createMessage } from "../api";
import { nativeRunFailure } from "../run-state";
import { deferred, interact, renderComponent } from "../test/render-component";
import { TaskCard } from "./TaskCard";

vi.mock("../api", () => ({
  cancelNativeRun: vi.fn(),
  createMessage: vi.fn(),
  steerRun: vi.fn(),
  ApiError: class extends Error {
    status = 500;
  },
}));

const bot: Bot = {
  id: "bot-1",
  name: "研究助理",
  role: "研究",
  status: "running",
  computerProfile: "none",
  createdAt: "2026-09-08T00:00:00Z",
};
const helper: Bot = { ...bot, id: "bot-2", name: "客服小橙" };
const run: Run = {
  id: "run-1",
  channelId: "channel-1",
  botId: bot.id,
  executionProfile: "none",
  instruction: "Prepare a report",
  title: "Report",
  status: "running",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:01Z",
};

function card(props: Partial<ComponentProps<typeof TaskCard>> = {}) {
  return renderComponent(
    <TaskCard
      run={run}
      bot={bot}
      botsById={
        new Map([
          [bot.id, bot],
          [helper.id, helper],
        ])
      }
      progress={undefined}
      artifacts={[]}
      approvals={[]}
      frame={undefined}
      node={undefined}
      childRuns={[]}
      waiting={false}
      collapsed={false}
      showAvatar
      onInspect={vi.fn()}
      onRun={vi.fn()}
      onDecideApproval={vi.fn(async () => undefined)}
      {...props}
    />,
  );
}
function button(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === text,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("task card controls", () => {
  it.each(["none", "model"] as const)(
    "waits for durable %s cancellation and prevents duplicate requests",
    async (executionProfile) => {
      const pending = deferred<Run>();
      vi.mocked(cancelNativeRun).mockReturnValue(pending.promise);
      const onRun = vi.fn();
      const view = await card({ run: { ...run, executionProfile }, onRun });
      try {
        const stop = button(view.container, "停止");
        await interact(() => stop?.click());
        expect(stop?.disabled).toBe(true);
        await interact(() => stop?.click());
        expect(cancelNativeRun).toHaveBeenCalledExactlyOnceWith(run.id);
        const cancelled = { ...run, status: "cancelled" as const };
        await interact(() => pending.resolve(cancelled));
        expect(onRun).toHaveBeenCalledExactlyOnceWith(cancelled);
      } finally {
        await view.unmount();
      }
    },
  );

  it("resubmits the original instruction only on an explicit click", async () => {
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
    const view = await card({
      run: { ...run, status: "failed", errorCode: "model_credentials" },
      onRun,
    });
    try {
      expect(view.container.textContent).toContain("没能完成 · Report");
      expect(view.container.textContent).toContain("原记录保留");
      expect(createMessage).not.toHaveBeenCalled();
      await interact(() => button(view.container, "重新提交")?.click());
      expect(createMessage).toHaveBeenCalledExactlyOnceWith(run.channelId, {
        content: run.instruction,
        botId: run.botId,
      });
      expect(onRun).toHaveBeenCalledExactlyOnceWith(next);
    } finally {
      await view.unmount();
    }
  });

  it("offers no stop or steering for Worker tasks", async () => {
    const view = await card({ run: { ...run, executionProfile: "docker-linux", nodeId: "n" } });
    try {
      expect(button(view.container, "停止")).toBeUndefined();
      expect(button(view.container, "补充指令")).toBeUndefined();
      expect(button(view.container, "任务详情 ›")).toBeDefined();
    } finally {
      await view.unmount();
    }
  });
});

describe("task card states", () => {
  it("shows the reported progress line, never a step total", async () => {
    const view = await card({
      progress: {
        id: "p",
        runId: run.id,
        channelId: run.channelId,
        stage: "navigate",
        message: "打开网页 b.example",
        createdAt: run.createdAt,
      },
    });
    try {
      expect(view.container.textContent).toContain("正在工作 · Report");
      expect(view.container.textContent).toContain("现在：打开网页 b.example");
      expect(view.container.textContent).not.toMatch(/已完成 \d+ 步/);
    } finally {
      await view.unmount();
    }
  });

  it("decides a pending approval on the card", async () => {
    const approval: Approval = {
      id: "ap-1",
      runId: run.id,
      channelId: run.channelId,
      botId: bot.id,
      nodeId: "n",
      action: "email.send",
      target: "team@example.com",
      summary: "发送邮件给 team@example.com",
      risk: "write",
      targetFingerprint: "0".repeat(64),
      beforeState: {},
      status: "pending",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      createdAt: run.createdAt,
    } as Approval;
    const decide = vi.fn(async () => undefined);
    const view = await card({
      run: { ...run, status: "waiting_approval" },
      approvals: [approval],
      onDecideApproval: decide,
    });
    try {
      expect(view.container.textContent).toContain("写入动作");
      await interact(() => button(view.container, "发送这封邮件")?.click());
      expect(decide).toHaveBeenCalledWith("ap-1", "approve");
    } finally {
      await view.unmount();
    }
  });

  it("collapses queued, stopped and older finished tasks to one line", async () => {
    const queued = await card({ run: { ...run, status: "queued" }, waiting: true });
    try {
      expect(queued.container.textContent).toContain("等待接续 · Report");
      expect(button(queued.container, "取消")).toBeDefined();
    } finally {
      await queued.unmount();
    }
    const old = await card({ run: { ...run, status: "completed" }, collapsed: true });
    try {
      expect(old.container.querySelector(".task-top.is-line")?.textContent).toContain(
        "已完成 · Report",
      );
    } finally {
      await old.unmount();
    }
  });

  it("shows delegated work inside the lead task", async () => {
    const inspect = vi.fn();
    const view = await card({
      childRuns: [
        { ...run, id: "child", botId: helper.id, parentRunId: run.id, title: "统计工单" },
      ],
      onInspect: inspect,
    });
    try {
      expect(view.container.textContent).toContain("研究助理请");
      expect(view.container.textContent).toContain("客服小橙");
      await interact(() =>
        view.container.querySelector<HTMLButtonElement>(".task-collab-row")?.click(),
      );
      expect(inspect).toHaveBeenCalledWith("child");
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

describe("补充指令 on a working card", () => {
  it("收起 closes the form without sending anything", async () => {
    // A running 服务电脑 task (profile "none") accepts 补充指令.
    const view = await card();
    try {
      await interact(() => button(view.container, "补充指令")?.click());
      expect(view.container.querySelector(".task-steer textarea")).not.toBeNull();
      await interact(() => button(view.container, "收起")?.click());
      expect(view.container.querySelector(".task-steer textarea")).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
