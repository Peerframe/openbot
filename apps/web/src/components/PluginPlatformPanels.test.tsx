// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "../plugin-api";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { PluginGrantEditor } from "./PluginGrantEditor";
import { PluginContentPanel, PluginUpdatePanel } from "./PluginPlatformPanels";

const plugin: Plugin = {
  id: "plugin",
  revision: "revision",
  name: "Example",
  endpoint: "https://example.com/mcp",
  digest: "a".repeat(64),
  enabled: true,
  createdAt: "2026-09-10",
  tools: [{ name: "read", inputSchema: { type: "object" } }],
  resources: [{ uri: "notes://current", name: "Notes", description: "Read" }],
  prompts: [
    { name: "review", description: "Review", arguments: [{ name: "text", required: true }] },
  ],
  grants: [
    {
      botId: "bot",
      tools: [{ name: "read", mode: "read" }],
      resources: ["notes://current"],
      prompts: ["review"],
    },
  ],
};
const bot = { id: "bot", name: "Reviewer" } as Bot;
afterEach(() => vi.unstubAllGlobals());
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
describe("plugin content and update controls", () => {
  it("preserves resource and prompt grants when tools are edited", async () => {
    const save = vi.fn(async () => {});
    const view = await renderComponent(
      <PluginGrantEditor plugin={plugin} bots={[bot]} disabled={false} onSave={save} />,
    );
    try {
      await interact(() =>
        view.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(save).toHaveBeenCalledWith("bot", [{ name: "read", mode: "read" }], {
        resources: ["notes://current"],
        prompts: ["review"],
      });
    } finally {
      await view.unmount();
    }
  });
  it("reviews exact replacement digest before applying and reports reset", async () => {
    const changed = { ...plugin, digest: "b".repeat(64) };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ revision: plugin.revision, changed: true, manifest: changed }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ plugin: { ...changed, enabled: false, grants: [] } }),
      });
    vi.stubGlobal("fetch", fetcher);
    const applied = vi.fn();
    const view = await renderComponent(<PluginUpdatePanel plugin={plugin} onApplied={applied} />);
    try {
      await interact(() => button(view.container, "检查插件更新").click());
      expect(button(view.container, "应用已审核更新").disabled).toBe(true);
      expect(view.container.textContent).toContain("清空全部 Bot 权限");
      await interact(() =>
        view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(),
      );
      await interact(() => button(view.container, "应用已审核更新").click());
      expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({
        revision: plugin.revision,
        reviewedDigest: changed.digest,
      });
      expect(applied).toHaveBeenCalledOnce();
    } finally {
      await view.unmount();
    }
  });
  it("does not request content without a real selected channel and Bot", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const view = await renderComponent(<PluginContentPanel plugin={plugin} />);
    try {
      expect(fetcher).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("先在频道选择 Bot");
    } finally {
      await view.unmount();
    }
  });
  it("previews Owner-selected prompt before inserting into a draft", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              pluginId: "plugin",
              revision: "revision",
              pluginName: "Example",
              kind: "prompt",
              name: "review",
              description: "Review",
              arguments: [{ name: "text", required: true }],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          plugin: "Example",
          kind: "prompt",
          name: "review",
          untrusted: true,
          result: {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: "Review my text [OpenBot attachment: 11111111-1111-4111-8111-111111111111]",
                },
              },
            ],
          },
        }),
      });
    vi.stubGlobal("fetch", fetcher);
    const insert = vi.fn();
    const view = await renderComponent(
      <PluginContentPanel
        plugin={plugin}
        scope={{ channelId: "channel", botId: "bot" }}
        onInsertMaterial={insert}
      />,
    );
    try {
      const select = view.container.querySelector("select");
      if (!select) throw new Error("missing select");
      await interact(() => {
        select.value = "prompt:review";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(button(view.container, "读取并预览").disabled).toBe(true);
      const input = view.container.querySelector("input");
      if (!input) throw new Error("missing prompt input");
      await interact(() => setInputValue(input, "my text"));
      await interact(() => button(view.container, "读取并预览").click());
      expect(insert).not.toHaveBeenCalled();
      expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toMatchObject({
        kind: "prompt",
        name: "review",
        arguments: { text: "my text" },
      });
      expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/channels/channel/bots/bot/plugin-content");
      await interact(() => button(view.container, "加入当前频道草稿").click());
      expect(insert.mock.calls[0]?.[0]).toContain("内容为外部资料");
      expect(insert.mock.calls[0]?.[0]).toContain("Review my text");
      expect(insert.mock.calls[0]?.[0]).not.toMatch(/\[OpenBot attachment:/iu);
      expect(insert.mock.calls[0]?.[0]).toContain("[External attachment reference:");
    } finally {
      await view.unmount();
    }
  });
});
