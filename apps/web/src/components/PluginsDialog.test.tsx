// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { PluginsDialog } from "./PluginsDialog";

const t = "2026-09-30T01:00:00.000Z";
const bot: Bot = {
  id: "a",
  name: "研究助理",
  role: "研究",
  status: "idle",
  computerProfile: "none",
  createdAt: t,
};
const plugin = (id: string, name: string, botIds: string[]) => ({
  id,
  name,
  endpoint: `https://mcp.example.test/${id}`,
  transport: "streamable-http",
  tools: [{ name: "search", description: "搜索邮件", inputSchema: {}, mode: "read" }],
  revision: `${id}-r1`,
  enabled: true,
  createdAt: t,
  grants: botIds.map((botId) => ({ botId, tools: [] })),
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        plugins: [plugin("gmail", "Gmail", ["a"]), plugin("drive", "Google Drive", [])],
        pendingCalls: [],
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("lists my plugins with granted Bots, searches, assigns Bots and opens management", async () => {
  const onManage = vi.fn();
  const onClose = vi.fn();
  const view = await renderComponent(
    <PluginsDialog bots={[bot]} onManage={onManage} onClose={onClose} />,
  );
  try {
    await interact(() => undefined);
    const dialog = view.container.querySelector<HTMLDialogElement>("dialog.plugins-dialog");
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute("aria-labelledby")).toBe("plugins-dialog-title");
    expect(view.container.querySelectorAll(".plugins-mine-row")).toHaveLength(2);
    expect(view.container.querySelector(".plugins-mine-row small")?.getAttribute("title")).toBe(
      "已授权：研究助理",
    );
    const search = view.container.querySelector<HTMLInputElement>('[aria-label="搜索插件"]');
    if (!search) throw Error("search missing");
    await setInputValue(search, "drive");
    expect(view.container.querySelectorAll(".plugins-mine-row")).toHaveLength(1);
    await setInputValue(search, "");
    const choose = view.container.querySelector<HTMLButtonElement>(".plugins-mine-row .ob-pill");
    await interact(() => choose?.click());
    expect(choose?.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector(".plugins-row-detail")?.textContent).toContain(
      "分配给 Bot",
    );
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>(".plugins-installed")?.click(),
    );
    expect(onManage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("lists reviewed catalogue entries under 精选 with a pinned source link", async () => {
  const commit = "a".repeat(40);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/v1/plugins/catalog"
        ? Response.json({
            format: "openbot.reviewed-plugin-catalog/v1",
            revision: 1,
            entries: [
              {
                id: "developer-template",
                name: "Developer template",
                description: "A reviewed MCP server template.",
                distribution: "self-hosted-template",
                version: "1.0.0",
                license: "MIT",
                sourceUrl: `https://github.com/example/plugin/tree/${commit}`,
                sourceCommit: commit,
                files: [{ path: "server.ts", sha256: "b".repeat(64) }],
                review: {
                  status: "reviewed",
                  reviewedAt: "2026-10-01T00:00:00.000Z",
                  reviewedBy: "maintainer",
                  record: "docs/research/plugin-template.md",
                  scope: "Template only.",
                },
              },
            ],
          })
        : Response.json({ plugins: [], pendingCalls: [] }),
    ),
  );
  const view = await renderComponent(<PluginsDialog bots={[bot]} onClose={vi.fn()} />);
  try {
    await interact(() => undefined);
    await interact(() => undefined);
    expect(view.container.querySelector("#plugins-featured")?.textContent).toBe("精选");
    const link = view.container.querySelector<HTMLAnchorElement>(".plugins-featured-row a");
    expect(link?.href).toBe(`https://github.com/example/plugin/tree/${commit}`);
    expect(link?.rel).toBe("noreferrer");
    expect(
      view.container.querySelector(".plugins-featured-row small")?.getAttribute("title"),
    ).toContain("v1.0.0 · MIT · 部署模板");
  } finally {
    await view.unmount();
  }
});
