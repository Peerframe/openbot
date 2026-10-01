// @vitest-environment jsdom

import type { Approval, ExecutionNode, Run, WorkspaceSnapshot } from "@openbot/domain";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { ContextRail } from "./ContextRail";

function workspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    channels: [],
    bots: [],
    nodes: [],
    runs: [],
    approvals: [],
    artifacts: [],
    progress: [],
    counts: { channels: 0, bots: 0, connectedNodes: 0, activeRuns: 0 },
    ...overrides,
  };
}

function run(id: string, status: Run["status"], updatedAt = "2026-09-05T01:00:00Z"): Run {
  return {
    id,
    channelId: "channel-1",
    botId: "bot-1",
    executionProfile: "docker-linux",
    instruction: `Task ${id}`,
    title: `Task ${id}`,
    status,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt,
  };
}

describe("ContextRail", () => {
  it("keeps durable status explanations consistent with task details", async () => {
    const blocked = run("blocked-summary", "blocked");
    const failed = {
      ...run("failed-summary", "failed"),
      executionProfile: "none" as const,
      errorCode: "model_credentials",
      errorMessage: "synthetic-provider-raw-error",
    };
    const completed = run("completed-summary", "completed");
    const rendered = await renderComponent(
      <ContextRail
        selectedChannelId="channel-1"
        workspace={workspace({
          runs: [blocked, failed, completed],
          progress: [blocked, failed].map((task) => ({
            id: `progress-${task.id}`,
            runId: task.id,
            channelId: task.channelId,
            stage: "planning",
            message: "stale planning message",
            createdAt: task.createdAt,
          })),
        })}
        onDecideApproval={vi.fn()}
        onInspectRun={vi.fn()}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("任务遇到阻塞，需要人工处理。");
      expect(rendered.container.textContent).toContain("模型密钥被拒绝");
      expect(rendered.container.textContent).toContain("任务已结束。");
      expect(rendered.container.textContent).not.toContain("synthetic-provider-raw-error");
      expect(rendered.container.textContent).not.toContain("stale planning message");
    } finally {
      await rendered.unmount();
    }
  });

  it("distinguishes absent token usage from observed zero task records", async () => {
    const rendered = await renderComponent(
      <ContextRail workspace={workspace()} onDecideApproval={vi.fn()} onInspectRun={vi.fn()} />,
    );
    try {
      const tokens = rendered.container.querySelector('[aria-label="Token 用量"]');
      expect(tokens?.textContent).toContain("暂无用量记录");
      expect(tokens?.textContent).not.toContain("0");
      expect(tokens?.querySelector("dd")).toBeNull();
      expect(metric(rendered.container, "进行中")).toBe("0");
      expect(metric(rendered.container, "已完成")).toBe("0");
      expect(metric(rendered.container, "记录数")).toBe("0");
      expect(rendered.container.textContent).toContain("尚未连接工作电脑");
      expect(rendered.container.textContent).not.toContain("节省");
      const overview = rendered.container.querySelector("details");
      expect(overview?.open).toBe(false);
      expect(overview?.querySelector('[aria-label="最近任务统计"]')).not.toBeNull();
      await interact(() => overview?.querySelector("summary")?.click());
      expect(overview?.open).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  it("shows only reported usage in the selected channel without inventing missing totals", async () => {
    const measured = {
      ...run("measured", "completed"),
      executionProfile: "none" as const,
      modelUsage: {
        provider: "openai" as const,
        model: "fixture",
        steps: 2,
        inputTokens: 120,
        outputTokens: null,
      },
    };
    const elsewhere = {
      ...measured,
      id: "elsewhere",
      channelId: "other",
      modelUsage: { ...measured.modelUsage, inputTokens: 99999, outputTokens: 99999 },
    };
    const view = await renderComponent(
      <ContextRail
        selectedChannelId="channel-1"
        workspace={workspace({ runs: [measured, elsewhere] })}
        onDecideApproval={vi.fn()}
        onInspectRun={vi.fn()}
      />,
    );
    try {
      const tokens = view.container.querySelector('[aria-label="Token 用量"]');
      expect(tokens?.textContent).toContain("输入 120 · 输出 未知");
      expect(tokens?.textContent).not.toContain("99,999");
      expect(tokens?.textContent).toContain("不代表账单");
    } finally {
      await view.unmount();
    }
  });
  it("counts the recent snapshot without treating failures or cancellations as completion", async () => {
    const runs = [
      run("queued", "queued"),
      run("waiting", "waiting_approval"),
      run("blocked", "blocked"),
      run("completed", "completed", "2026-09-05T02:00:00Z"),
      run("failed", "failed", "2026-09-05T04:00:00Z"),
      run("cancelled", "cancelled", "2026-09-05T03:00:00Z"),
    ];
    const orderBefore = runs.map((item) => item.id);
    const onInspectRun = vi.fn();
    const rendered = await renderComponent(
      <ContextRail
        workspace={workspace({ runs })}
        onDecideApproval={vi.fn()}
        onInspectRun={onInspectRun}
      />,
    );
    try {
      expect(metric(rendered.container, "进行中")).toBe("3");
      expect(metric(rendered.container, "已完成")).toBe("1");
      expect(metric(rendered.container, "记录数")).toBe("6");
      expect(rendered.container.textContent).toContain("最近任务6 条记录");
      const results = rendered.container.querySelector('[aria-label="最近结果"]');
      expect(
        Array.from(results?.querySelectorAll("button") ?? [], (item) => item.ariaLabel),
      ).toEqual(["查看任务：Task failed", "查看任务：Task cancelled", "查看任务：Task completed"]);
      await interact(() => getButton(rendered.container, "查看任务：Task cancelled").click());
      expect(onInspectRun).toHaveBeenCalledWith("cancelled");
      await interact(() => getButton(rendered.container, "查看任务：Task queued").click());
      expect(onInspectRun).toHaveBeenCalledWith("queued");
      expect(runs.map((item) => item.id)).toEqual(orderBefore);
    } finally {
      await rendered.unmount();
    }
  });

  it("preserves pending approval actions and reports connected computer capacity", async () => {
    const approval: Approval = {
      id: "approval-1",
      runId: "run-1",
      channelId: "channel-1",
      botId: "bot-1",
      nodeId: "node-1",
      action: "form.submit",
      target: "https://example.test/form",
      summary: "提交登记表",
      risk: "write",
      targetFingerprint: "0".repeat(64),
      beforeState: {},
      status: "pending",
      expiresAt: "2999-01-01T00:00:00Z",
      createdAt: "2026-09-05T00:00:00Z",
    };
    const node: ExecutionNode = {
      id: "node-1",
      name: "Design Mac",
      platform: "macos",
      osVersion: "26",
      architecture: "arm64",
      deviceClass: "server",
      isolation: "container",
      trustTier: "dedicated",
      capabilities: [],
      capabilityManifest: [],
      activeRunIds: ["run-1"],
      maxConcurrentRuns: 2,
      connectedAt: "2026-09-05T00:00:00Z",
      lastSeenAt: "2026-09-05T01:00:00Z",
    };
    const onDecideApproval = vi.fn(async () => undefined);
    const rendered = await renderComponent(
      <ContextRail
        workspace={workspace({
          nodes: [node],
          approvals: [approval, { ...approval, id: "approved-2", status: "approved" }],
        })}
        onDecideApproval={onDecideApproval}
        onInspectRun={vi.fn()}
      />,
    );
    try {
      expect(rendered.container.querySelectorAll(".approval-card")).toHaveLength(1);
      expect(rendered.container.textContent).toContain("电脑1 台已连接");
      expect(rendered.container.textContent).toContain("Design Mac");
      expect(rendered.container.textContent).toContain("macos · 1/2 任务");
      const reject = Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent === "拒绝",
      );
      if (reject === undefined) throw new Error("Approval rejection action is missing");
      await interact(() => reject.click());
      expect(onDecideApproval).toHaveBeenCalledWith("approval-1", "reject");
    } finally {
      await rendered.unmount();
    }
  });

  it("shows only the selected channel's tasks, progress, results and attachments", async () => {
    const runs = [
      run("current", "running"),
      { ...run("elsewhere", "running"), channelId: "channel-2" },
      run("finished", "completed"),
      { ...run("other-result", "completed"), channelId: "channel-2" },
    ];
    const snapshot = workspace({
      runs,
      progress: [
        {
          id: "progress-new",
          runId: "current",
          channelId: "channel-1",
          nodeId: "node-1",
          stage: "working",
          message: "正在整理本频道结果",
          createdAt: "2026-09-05T02:00:00Z",
        },
        {
          id: "progress-old",
          runId: "current",
          channelId: "channel-1",
          nodeId: "node-1",
          stage: "working",
          message: "旧的任务进度",
          createdAt: "2026-09-05T01:00:00Z",
        },
        {
          id: "progress-conflict",
          runId: "current",
          channelId: "channel-2",
          nodeId: "node-1",
          stage: "working",
          message: "频道关联不符的进度",
          createdAt: "2026-09-05T03:00:00Z",
        },
      ],
      artifacts: [
        {
          id: "artifact-current",
          runId: "finished",
          name: "本频道截图.png",
          mediaType: "image/png",
          sha256: "0".repeat(64),
          sizeBytes: 64,
          createdAt: "2026-09-05T01:00:00Z",
        },
        {
          id: "artifact-other",
          runId: "other-result",
          name: "另一个频道的截图.png",
          mediaType: "image/png",
          sha256: "0".repeat(64),
          sizeBytes: 64,
          createdAt: "2026-09-05T01:00:00Z",
        },
      ],
    });
    const originalSnapshot = JSON.stringify(snapshot);
    const rendered = await renderComponent(
      <ContextRail
        selectedChannelId="channel-1"
        workspace={snapshot}
        onDecideApproval={vi.fn()}
        onInspectRun={vi.fn()}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("正在整理本频道结果");
      expect(rendered.container.textContent).not.toContain("旧的任务进度");
      expect(rendered.container.textContent).not.toContain("频道关联不符的进度");
      expect(rendered.container.textContent).not.toContain("Task elsewhere");
      expect(rendered.container.textContent).not.toContain("Task other-result");
      expect(rendered.container.textContent).not.toContain("另一个频道的截图");
      expect(rendered.container.querySelector("a")?.getAttribute("href")).toBe(
        "/api/v1/artifacts/artifact-current/content",
      );
      expect(metric(rendered.container, "记录数")).toBe("4");
      expect(JSON.stringify(snapshot)).toBe(originalSnapshot);
    } finally {
      await rendered.unmount();
    }
  });

  it("retains channel approvals outside the recent-run sample and rejects conflicting associations", async () => {
    const base: Approval = {
      id: "approval-outside-sample",
      runId: "old-run",
      channelId: "channel-1",
      botId: "bot-1",
      nodeId: "node-1",
      action: "form.submit",
      target: "https://example.test/form",
      summary: "本频道仍需确认",
      risk: "write",
      targetFingerprint: "0".repeat(64),
      beforeState: {},
      status: "pending",
      expiresAt: "2999-01-01T00:00:00Z",
      createdAt: "2026-09-05T00:00:00Z",
    };
    const onDecideApproval = vi.fn(async () => undefined);
    const rendered = await renderComponent(
      <ContextRail
        selectedChannelId="channel-1"
        workspace={workspace({
          runs: [{ ...run("other-run", "waiting_approval"), channelId: "channel-2" }],
          approvals: [
            base,
            {
              ...base,
              id: "conflicting-approval",
              runId: "other-run",
              summary: "已知关联冲突",
            },
            {
              ...base,
              id: "other-channel-approval",
              channelId: "channel-2",
              summary: "其他频道的确认",
            },
          ],
        })}
        onDecideApproval={onDecideApproval}
        onInspectRun={vi.fn()}
      />,
    );
    try {
      expect(rendered.container.querySelectorAll(".approval-card")).toHaveLength(1);
      expect(rendered.container.textContent).toContain("本频道仍需确认");
      expect(rendered.container.textContent).not.toContain("已知关联冲突");
      expect(rendered.container.textContent).not.toContain("其他频道的确认");
      const firstSection = rendered.container.querySelector(".ci-body > section");
      expect(firstSection?.getAttribute("aria-label")).toBe("需要确认的操作");
      const approve = rendered.container.querySelector<HTMLButtonElement>(".approval-approve");
      await interact(() => approve?.click());
      expect(onDecideApproval).toHaveBeenCalledWith("approval-outside-sample", "approve");
    } finally {
      await rendered.unmount();
    }
  });

  it("switches scope immediately and leaves an empty channel empty", async () => {
    function ScopeHarness() {
      const [selectedChannelId, setSelectedChannelId] = useState("channel-1");
      return (
        <>
          <button type="button" onClick={() => setSelectedChannelId("empty-channel")}>
            切换频道
          </button>
          <ContextRail
            selectedChannelId={selectedChannelId}
            workspace={workspace({ runs: [run("selected", "running")] })}
            onDecideApproval={vi.fn()}
            onInspectRun={vi.fn()}
          />
        </>
      );
    }
    const rendered = await renderComponent(<ScopeHarness />);
    try {
      expect(rendered.container.textContent).toContain("Task selected");
      await interact(() => rendered.container.querySelector("button")?.click());
      expect(rendered.container.textContent).not.toContain("Task selected");
      expect(rendered.container.textContent).toContain("这个频道暂无任务动态");
      expect(rendered.container.querySelector('[aria-label="当前任务"]')).toBeNull();
      expect(rendered.container.querySelector('[aria-label="最近结果"]')).toBeNull();
      expect(rendered.container.querySelector('[aria-label="需要确认的操作"]')).toBeNull();
      expect(metric(rendered.container, "记录数")).toBe("1");
    } finally {
      await rendered.unmount();
    }
  });
});

function metric(container: HTMLElement, label: string): string | null {
  const term = Array.from(container.querySelectorAll("dt")).find(
    (item) => item.textContent === label,
  );
  return term?.nextElementSibling?.textContent ?? null;
}

function tab(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (candidate) => candidate.textContent?.startsWith(label),
  );
  if (button === undefined) throw new Error(`Tab missing: ${label}`);
  return button;
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.ariaLabel === label,
  );
  if (button === undefined) throw new Error(`Button missing: ${label}`);
  return button;
}

it("adds and removes channel members from the rail and collapses it", async () => {
  const onJoin = vi.fn(async () => undefined);
  const onRemove = vi.fn(async () => undefined);
  const onCollapse = vi.fn();
  const bot = (id: string, name: string) => ({
    id,
    name,
    role: "",
    status: "idle" as const,
    computerProfile: "none" as const,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const channel = {
    id: "c",
    name: "频道",
    description: "",
    botIds: ["alpha"],
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const rendered = await renderComponent(
    <ContextRail
      selectedChannelId="c"
      workspace={workspace({
        bots: [bot("alpha", "Alpha"), bot("beta", "Beta")],
        channels: [channel],
      })}
      onDecideApproval={vi.fn()}
      onInspectRun={vi.fn()}
      onJoin={onJoin}
      onRemove={onRemove}
      onCollapse={onCollapse}
    />,
  );
  try {
    expect(rendered.container.querySelector(".ci-header h2")?.textContent).toBe("频道信息");
    expect(tab(rendered.container, "成员").ariaSelected).toBe("true");
    await interact(() =>
      Array.from(rendered.container.querySelectorAll("button"))
        .find((item) => item.textContent === "添加成员")
        ?.click(),
    );
    await interact(() =>
      rendered.container
        .querySelector(".ci-add-form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onJoin).toHaveBeenCalledWith("beta");
    await interact(() => getButton(rendered.container, "将 Alpha 移出频道").click());
    expect(onRemove).toHaveBeenCalledWith("alpha");
    await interact(() => getButton(rendered.container, "收起").click());
    expect(onCollapse).toHaveBeenCalledOnce();
  } finally {
    await rendered.unmount();
  }
});

it("opens 详情 for pending approvals and lists task outputs and channel files in 资料库", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          channelId: "c",
          name: "brief.pdf",
          mediaType: "application/pdf",
          sizeBytes: 2048,
          sha256: "a".repeat(64),
          createdAt: "2026-09-25T00:00:00Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          channelId: "c",
          name: "old.txt",
          mediaType: "text/plain",
          sizeBytes: 10,
          sha256: "b".repeat(64),
          createdAt: "2026-09-20T00:00:00Z",
          deletedAt: "2026-09-21T00:00:00Z",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const composerAttach = vi.fn();
  window.addEventListener("openbot:composer-attach", composerAttach);
  const channel = {
    id: "c",
    name: "频道",
    description: "",
    botIds: ["bot-1"],
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const finished = { ...run("finished", "completed"), channelId: "c" };
  const rendered = await renderComponent(
    <ContextRail
      selectedChannelId="c"
      workspace={workspace({
        channels: [channel],
        bots: [
          {
            id: "bot-1",
            name: "研究助理",
            role: "研究",
            status: "idle",
            computerProfile: "none",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
        runs: [finished],
        approvals: [
          {
            id: "approval-1",
            runId: "finished",
            channelId: "c",
            botId: "bot-1",
            nodeId: "node-1",
            action: "form.submit",
            target: "https://example.test/form",
            summary: "提交登记表",
            risk: "write",
            targetFingerprint: "0".repeat(64),
            beforeState: {},
            status: "pending",
            expiresAt: "2999-01-01T00:00:00Z",
            createdAt: "2026-09-05T00:00:00Z",
          },
        ],
        artifacts: [
          {
            id: "artifact-1",
            runId: "finished",
            name: "weekly.md",
            mediaType: "text/markdown",
            sha256: "0".repeat(64),
            sizeBytes: 2048,
            createdAt: "2026-09-05T01:00:00Z",
          },
        ],
      })}
      onDecideApproval={vi.fn()}
      onInspectRun={vi.fn()}
    />,
  );
  try {
    expect(tab(rendered.container, "详情").ariaSelected).toBe("true");
    expect(rendered.container.querySelectorAll(".approval-card")).toHaveLength(1);
    await interact(() => tab(rendered.container, "资料库").click());
    expect(rendered.container.querySelector(".approval-card")).toBeNull();
    expect(tab(rendered.container, "详情").textContent).toBe("详情1");
    const output = rendered.container.querySelector<HTMLAnchorElement>("a.ci-file");
    expect(output?.getAttribute("href")).toBe("/api/v1/artifacts/artifact-1/content");
    expect(output?.textContent).toContain("研究助理");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/channels/c/attachments", expect.anything());
    expect(rendered.container.textContent).toContain("频道文件 · 1");
    expect(rendered.container.textContent).toContain("brief.pdf");
    expect(rendered.container.textContent).not.toContain("old.txt");
    await interact(() =>
      Array.from(rendered.container.querySelectorAll("button"))
        .find((item) => item.textContent === "上传文件")
        ?.click(),
    );
    expect(composerAttach).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("openbot:composer-attach", composerAttach);
    vi.unstubAllGlobals();
    await rendered.unmount();
  }
});
