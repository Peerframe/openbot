// @vitest-environment jsdom
import type { Bot, Run } from "@openbot/domain";
import { describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { indexRunCollaboration } from "./RunCollaboration";
import { RunInspector } from "./RunInspector";

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
  updatedAt: "2026-09-11T00:00:00Z",
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

describe("RunInspector production collaboration wiring", () => {
  it("shows childRuns from the same indexRunCollaboration filtering App uses", async () => {
    const botsById = new Map([
      [chief.id, chief],
      [researcher.id, researcher],
    ]);
    const childRuns =
      indexRunCollaboration("channel", [parent, child], []).childrenByParent.get(parent.id) ?? [];
    const inspect = vi.fn();
    const view = await renderComponent(
      <RunInspector
        artifacts={[]}
        bot={chief}
        botsById={botsById}
        childRuns={childRuns}
        liveFrame={undefined}
        node={undefined}
        progress={[]}
        run={parent}
        onClose={vi.fn()}
        onInspectRun={inspect}
        onRun={vi.fn()}
      />,
    );
    try {
      expect(childRuns).toHaveLength(1);
      expect(child.id).toBe("child");
      expect(view.container.textContent).toContain("研究员");
      expect(view.container.textContent).toContain("Research");
      expect(view.container.textContent).toContain("分工");
      const roles = view.container.querySelector('[aria-label="分工"]');
      expect(roles).not.toBeNull();
      const statusButton = [...roles!.querySelectorAll("button")].find(
        (node) => node.textContent?.includes("执行中") || node.textContent?.includes("运行"),
      );
      expect(statusButton).toBeTruthy();
      await interact(() => {
        statusButton!.click();
      });
      expect(inspect).toHaveBeenCalledWith(child.id);
      expect(inspect).toHaveBeenCalledWith("child");
    } finally {
      await view.unmount();
    }
  });
});


describe("RunInspector Escape and focus restore", () => {
  it("focuses the labelled close control on mount, closes on Escape, and restores prior focus on unmount", async () => {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "打开任务";
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const onClose = vi.fn();
    const view = await renderComponent(
      <RunInspector
        artifacts={[]}
        bot={chief}
        botsById={new Map([[chief.id, chief]])}
        childRuns={[]}
        liveFrame={undefined}
        node={undefined}
        progress={[]}
        run={parent}
        onClose={onClose}
        onInspectRun={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    try {
      const close = view.container.querySelector<HTMLButtonElement>('[aria-label="关闭任务详情"]');
      expect(close).not.toBeNull();
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
});

