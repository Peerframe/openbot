// @vitest-environment jsdom
import type { Artifact, Bot, Run, RunFrame, RunProgress } from "@openbot/domain";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { indexRunCollaboration } from "./RunCollaboration";
import { TaskSheet } from "./TaskSheet";

const chief: Bot = {
  id: "chief",
  name: "总管",
  role: "Coordinate",
  computerProfile: "none",
  status: "running",
  createdAt: "2026-09-11T00:00:00Z",
};
const researcher: Bot = {
  id: "researcher",
  name: "研究员",
  role: "Research",
  computerProfile: "none",
  status: "running",
  createdAt: "2026-09-11T00:00:00Z",
};
const parent: Run = {
  id: "parent",
  channelId: "channel",
  botId: chief.id,
  instruction: "Prepare a report",
  title: "Prepare a report",
  executionProfile: "none",
  status: "running",
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:01:00Z",
};
const child: Run = {
  ...parent,
  id: "child",
  botId: researcher.id,
  parentRunId: parent.id,
  rootRunId: parent.id,
  delegatedByBotId: chief.id,
  title: "Check sources",
};
const progress: RunProgress[] = [
  {
    id: "p1",
    runId: parent.id,
    channelId: "channel",
    stage: "planning",
    message: "Drafting outline",
    createdAt: "2026-09-11T00:00:30Z",
  },
];
const botsById = new Map([
  [chief.id, chief],
  [researcher.id, researcher],
]);

function sheet(props: Partial<ComponentProps<typeof TaskSheet>> = {}) {
  return renderComponent(
    <TaskSheet
      run={parent}
      bot={chief}
      botsById={botsById}
      artifacts={[]}
      progress={[]}
      liveFrame={undefined}
      node={undefined}
      onClose={vi.fn()}
      onRun={vi.fn()}
      {...props}
    />,
  );
}

describe("TaskSheet", () => {
  it("lists delegated tasks from the same indexRunCollaboration filtering App uses", async () => {
    const childRuns =
      indexRunCollaboration("channel", [parent, child], []).childrenByParent.get(parent.id) ?? [];
    const inspect = vi.fn();
    const view = await sheet({ childRuns, onInspectRun: inspect });
    try {
      expect(childRuns).toHaveLength(1);
      const roles = view.container.querySelector('[aria-label="分工"]');
      expect(roles?.textContent).toContain("Coordinate");
      expect(roles?.textContent).toContain("研究员");
      expect(roles?.textContent).toContain("Check sources");
      await interact(() => roles?.querySelector("button")?.click());
      expect(inspect).toHaveBeenCalledWith("child");
    } finally {
      await view.unmount();
    }
  });

  it("focuses the labelled close control, closes on Escape, and restores prior focus", async () => {
    const opener = document.createElement("button");
    opener.type = "button";
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = await sheet({ onClose });
    try {
      const close = view.container.querySelector<HTMLButtonElement>('[aria-label="关闭任务详情"]');
      expect(document.activeElement).toBe(close);
      expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe(
        "true",
      );
      await interact(() =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    }
  });

  it("shows a computer frame only for Worker tasks and only from a real RunFrame", async () => {
    const worker = { ...parent, executionProfile: "docker-linux" as const, nodeId: "node" };
    const frame: RunFrame = {
      runId: parent.id,
      channelId: "channel",
      nodeId: "node",
      revision: 3,
      mediaType: "image/png",
      sizeBytes: 2048,
      capturedAt: "2026-09-11T00:01:00Z",
    };
    const server = await sheet({ progress });
    try {
      expect(server.container.querySelector("img")).toBeNull();
      expect(server.container.textContent).not.toContain("电脑画面");
      expect(server.container.textContent).toContain("由服务电脑执行");
      expect(server.container.textContent).toContain("Drafting outline");
    } finally {
      await server.unmount();
    }
    const empty = await sheet({ run: worker });
    try {
      expect(empty.container.querySelector("img")).toBeNull();
      expect(empty.container.textContent).toContain("还没有画面");
    } finally {
      await empty.unmount();
    }
    const live = await sheet({ run: worker, liveFrame: frame });
    try {
      expect(live.container.querySelector("img")?.getAttribute("src")).toBe(
        "/api/v1/runs/parent/frame?revision=3",
      );
    } finally {
      await live.unmount();
    }
  });

  it("maps failure codes and never shows the raw Server message", async () => {
    const view = await sheet({
      run: {
        ...parent,
        status: "failed",
        errorCode: "model_credentials",
        errorMessage: "upstream rejected credential blob",
      },
    });
    try {
      expect(view.container.textContent).toContain("模型密钥被拒绝");
      expect(view.container.textContent).toContain("model_credentials");
      expect(view.container.textContent).not.toContain("upstream rejected credential blob");
    } finally {
      await view.unmount();
    }
  });

  it("prefers blocked and completed status over a stale progress line", async () => {
    const blocked = await sheet({ run: { ...parent, status: "blocked" }, progress });
    try {
      const steps = blocked.container.querySelector('[aria-label="进度"]')?.textContent ?? "";
      expect(steps).toContain("需要人工处理");
    } finally {
      await blocked.unmount();
    }
    const done = await sheet({ run: { ...parent, status: "completed" } });
    try {
      expect(done.container.textContent).toContain("任务已结束");
      expect(done.container.textContent).not.toContain("等服务电脑报告下一步");
    } finally {
      await done.unmount();
    }
  });

  it("lists outputs and real or missing token counts", async () => {
    const artifact: Artifact = {
      id: "art-1",
      runId: parent.id,
      name: "report.md",
      mediaType: "text/markdown",
      sha256: "a".repeat(64),
      sizeBytes: 12,
      createdAt: parent.createdAt,
    };
    const view = await sheet({
      artifacts: [artifact],
      run: {
        ...parent,
        status: "cancelled",
        modelUsage: {
          provider: "openai",
          model: "fixture",
          steps: 2,
          inputTokens: 0,
          outputTokens: null,
        },
      },
    });
    try {
      expect(view.container.textContent).toContain("report.md");
      expect(view.container.textContent).toContain("Owner 已停止");
      expect(view.container.textContent).toContain("输入 0 · 输出 未知");
    } finally {
      await view.unmount();
    }
  });
});
