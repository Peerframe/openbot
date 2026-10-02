// @vitest-environment jsdom
import type { Artifact, Bot, Channel, Run } from "@openbot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { ShareConversationDialog } from "./ShareConversationDialog";

const bot = { id: "bot-a", name: "Research", computerProfile: "none" } as Bot;
const channel = { id: "channel-a", name: "Research", botIds: [bot.id] } as Channel;
const runs = [{ id: "run-a", channelId: channel.id }] as Run[];
const artifact = {
  id: "file-a",
  runId: "run-a",
  name: "成果.md",
  mediaType: "text/markdown",
  sizeBytes: 120,
} as Artifact;

function buttonText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("deliverable and Bot sharing", () => {
  it("lists only current-channel files and Bots, without loading transcripts or generating tasks", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const share = vi.fn();
    const view = await renderComponent(
      <ShareConversationDialog
        runs={runs}
        channel={channel}
        bots={[bot, { ...bot, id: "other", name: "Private Bot" }]}
        artifacts={[artifact, { ...artifact, id: "other", runId: "other", name: "私人文件.md" }]}
        onShareBot={share}
        onClose={vi.fn()}
      />,
    );
    try {
      expect(view.container.textContent).toContain("成果.md");
      expect(view.container.textContent).not.toContain("私人文件.md");
      expect(view.container.textContent).not.toContain("Private Bot");
      expect(view.container.textContent).not.toContain("复制对话");
      expect(share).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(view.container.querySelector('[aria-label="下载 成果.md"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });
  it("opens the selected Bot export preview only on explicit click", async () => {
    const share = vi.fn();
    const view = await renderComponent(
      <ShareConversationDialog
        runs={runs}
        channel={channel}
        bots={[bot]}
        artifacts={[]}
        onShareBot={share}
        onClose={vi.fn()}
      />,
    );
    try {
      expect(share).not.toHaveBeenCalled();
      await interact(() => buttonText(view.container, "Bot 模板")?.click());
      await interact(() => buttonText(view.container, "打包模板")?.click());
      expect(share).toHaveBeenCalledExactlyOnceWith(bot.id);
    } finally {
      await view.unmount();
    }
  });
  it("does not allow sharing when the channel has no Bot", async () => {
    const view = await renderComponent(
      <ShareConversationDialog
        runs={runs}
        channel={{ ...channel, botIds: [] }}
        bots={[bot]}
        artifacts={[]}
        onShareBot={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    try {
      await interact(() => buttonText(view.container, "Bot 模板")?.click());
      expect(buttonText(view.container, "打包模板")).toBeUndefined();
      expect(view.container.textContent).toContain("先在这个频道加入一个 Bot");
    } finally {
      await view.unmount();
    }
  });
  it("previews a selected report through its authenticated content endpoint", async () => {
    const fetcher = vi.fn(
      async () => new Response("# 报告", { headers: { "content-type": "text/markdown" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const view = await renderComponent(
      <ShareConversationDialog
        runs={runs}
        channel={channel}
        bots={[bot]}
        artifacts={[artifact]}
        onShareBot={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    try {
      const preview = Array.from(view.container.querySelectorAll("button")).find(
        (b) => b.textContent === "预览",
      )!;
      await interact(() => preview.click());
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/artifacts/file-a/content",
        expect.objectContaining({ credentials: "include" }),
      );
      expect(view.container.querySelector("textarea")?.value).toBe("# 报告");
    } finally {
      await view.unmount();
    }
  });
  it("can retry the same report preview after a transient failure", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response("# Recovered", { headers: { "content-type": "text/markdown" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    const view = await renderComponent(
      <ShareConversationDialog
        runs={runs}
        channel={channel}
        bots={[bot]}
        artifacts={[artifact]}
        onShareBot={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    try {
      const button = Array.from(view.container.querySelectorAll("button")).find(
        (b) => b.textContent === "预览",
      )!;
      await interact(() => button.click());
      expect(view.container.textContent).toContain("无法读取文件");
      await interact(() => button.click());
      expect(view.container.querySelector("textarea")?.value).toBe("# Recovered");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await view.unmount();
    }
  });
});
