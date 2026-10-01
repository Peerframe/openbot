// @vitest-environment jsdom
import type { Artifact, Bot, Run, RunFrame, RunProgress } from "@openbot/domain";
import { describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { RunProgressPanel } from "./RunProgressPanel";

const bot: Bot = {
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
  computerProfile: "browser",
  status: "running",
  createdAt: "2026-09-11T00:00:00Z",
};
const run: Run = {
  id: "run-1",
  channelId: "channel",
  botId: bot.id,
  instruction: "Prepare a report",
  title: "Prepare a report",
  executionProfile: "none",
  status: "running",
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:01:00Z",
};
const progress: RunProgress[] = [
  {
    id: "p1",
    runId: run.id,
    channelId: "channel",
    stage: "planning",
    message: "Drafting outline",
    createdAt: "2026-09-11T00:00:30Z",
  },
];

describe("RunProgressPanel", () => {
  it("shows an honest empty computer preview without fabricating a screenshot", async () => {
    const view = await renderComponent(
      <RunProgressPanel
        artifacts={[]}
        bot={bot}
        liveFrame={undefined}
        progress={progress}
        run={run}
      />,
    );
    try {
      expect(view.container.querySelector("img")).toBeNull();
      expect(view.container.textContent).toContain("暂无执行画面");
      expect(view.container.textContent).not.toContain("不会使用占位图");
      expect(view.container.textContent).toContain("Coordinate");
      expect(view.container.textContent).toContain("Drafting outline");
    } finally {
      await view.unmount();
    }
  });

  it("renders a real frame URL only when a RunFrame projection exists", async () => {
    const frame: RunFrame = {
      runId: run.id,
      channelId: "channel",
      nodeId: "node",
      revision: 3,
      mediaType: "image/png",
      sizeBytes: 2048,
      width: 1280,
      height: 800,
      capturedAt: "2026-09-11T00:01:00Z",
    };
    const view = await renderComponent(
      <RunProgressPanel artifacts={[]} bot={bot} liveFrame={frame} progress={progress} run={run} />,
    );
    try {
      const image = view.container.querySelector("img");
      expect(image?.getAttribute("src")).toBe("/api/v1/runs/run-1/frame?revision=3");
      expect(view.container.textContent).not.toContain("暂无执行画面");
    } finally {
      await view.unmount();
    }
  });

  it("surfaces waiting_approval and collaboration roles from real run records", async () => {
    const waiting = { ...run, status: "waiting_approval" as const };
    const child = {
      ...run,
      id: "child",
      botId: researcher.id,
      parentRunId: run.id,
      delegatedByBotId: bot.id,
      status: "running" as const,
      title: "Check sources",
    };
    const inspect = vi.fn();
    const view = await renderComponent(
      <RunProgressPanel
        artifacts={[]}
        bot={bot}
        botsById={
          new Map([
            [bot.id, bot],
            [researcher.id, researcher],
          ])
        }
        childRuns={[child]}
        liveFrame={undefined}
        onInspectRun={inspect}
        progress={[]}
        run={waiting}
      />,
    );
    try {
      expect(view.container.textContent).toContain("等待审批");
      expect(view.container.textContent).toContain("研究员");
      expect(view.container.textContent).toContain("Research");
      await interact(() => view.container.querySelector<HTMLButtonElement>("button")?.click());
      expect(inspect).toHaveBeenCalledWith("child");
    } finally {
      await view.unmount();
    }
  });

  it("maps native failure codes instead of raw errorMessage", async () => {
    const failed = {
      ...run,
      status: "failed" as const,
      errorCode: "model_credentials",
      errorMessage: "upstream rejected credential blob",
    };
    const view = await renderComponent(
      <RunProgressPanel
        artifacts={[]}
        bot={bot}
        liveFrame={undefined}
        progress={[]}
        run={failed}
      />,
    );
    try {
      expect(view.container.textContent).toContain("模型密钥被拒绝");
      expect(view.container.textContent).not.toContain("upstream rejected credential blob");
    } finally {
      await view.unmount();
    }
  });

  it("prefers blocked status over a stale progress stage", async () => {
    const blocked = { ...run, status: "blocked" as const };
    const stale: RunProgress[] = [
      {
        id: "p-old",
        runId: run.id,
        channelId: "channel",
        stage: "planning",
        message: "Still drafting",
        createdAt: "2026-09-11T00:00:30Z",
      },
    ];
    const view = await renderComponent(
      <RunProgressPanel
        artifacts={[]}
        bot={bot}
        liveFrame={undefined}
        progress={stale}
        run={blocked}
      />,
    );
    try {
      const step = view.container.querySelector('[aria-label="当前步骤"]')?.textContent ?? "";
      expect(step).toContain("阻塞");
      expect(step).not.toContain("模型步骤");
      expect(view.container.textContent).toContain("需要人工处理");
    } finally {
      await view.unmount();
    }
  });

  it("says a completed run without summary has ended", async () => {
    const completed = { ...run, status: "completed" as const, resultSummary: undefined };
    const view = await renderComponent(
      <RunProgressPanel
        artifacts={[]}
        bot={bot}
        liveFrame={undefined}
        progress={[]}
        run={completed}
      />,
    );
    try {
      expect(view.container.textContent).toContain("任务已结束");
      expect(view.container.textContent).not.toContain("等待服务电脑报告下一步");
    } finally {
      await view.unmount();
    }
  });

  it("lists artifact cards as result entry points and keeps empty results honest", async () => {
    const artifact: Artifact = {
      id: "art-1",
      runId: run.id,
      name: "report.md",
      mediaType: "text/markdown",
      sha256: "a".repeat(64),
      sizeBytes: 12,
      createdAt: run.createdAt,
    };
    const withArtifact = await renderComponent(
      <RunProgressPanel
        artifacts={[artifact]}
        bot={bot}
        liveFrame={undefined}
        progress={[]}
        run={{ ...run, status: "completed", resultSummary: "Done" }}
      />,
    );
    try {
      expect(withArtifact.container.textContent).toMatch(/report\.md|Done/);
    } finally {
      await withArtifact.unmount();
    }

    const empty = await renderComponent(
      <RunProgressPanel
        artifacts={[]}
        bot={bot}
        liveFrame={undefined}
        progress={[]}
        run={{ ...run, status: "running" }}
      />,
    );
    try {
      expect(empty.container.textContent).toContain("暂无产出");
    } finally {
      await empty.unmount();
    }
  });
});
