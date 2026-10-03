// @vitest-environment jsdom
import type { Bot, Channel } from "@openbot/domain";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { AutomationsScreen } from "./AutomationsScreen";
import { PluginManager } from "./PluginManagerPanel";
import { SettingsActionSlot } from "./SettingsHeaderAction";
import { SettingsHosts } from "./SettingsHosts";
import { SettingsModelServices } from "./SettingsModelServices";
import { SettingsSkills } from "./SettingsSkills";
import { formatStorageSize, SettingsStorage } from "./SettingsStorage";
import { SettingsTransfer } from "./SettingsTransfer";

afterEach(() => vi.unstubAllGlobals());

const t = "2026-09-30T01:00:00.000Z";
const preset = (id: string, name: string) => ({
  id,
  name,
  protocol: "openai-chat",
  endpoints: [{ name: "Global", baseUrl: `https://${id}.example.test/v1` }],
  suggestedModels: [],
  discovery: false,
  description: name,
  docsUrl: "https://example.test",
});
const connection = {
  id: "c1",
  name: "Anthropic",
  presetId: "anthropic",
  baseUrl: "https://anthropic.example.test/v1",
  protocol: "openai-chat",
  enabled: true,
  hasApiKey: true,
  revision: 1,
  source: "saved",
  defaultModel: "claude-sonnet",
  createdAt: t,
  updatedAt: t,
};

/** Routes fetch by method and path; unknown requests fail loudly. */
function server(routes: Record<string, (init?: RequestInit) => unknown>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) return Response.json({ error: "Unexpected request" }, { status: 500 });
    return Response.json(route(init));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function Slot({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <div className="slot" ref={setSlot} />
      <SettingsActionSlot.Provider value={slot}>{children}</SettingsActionSlot.Provider>
    </>
  );
}

function buttonNamed(container: HTMLElement, name: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent === name || item.getAttribute("aria-label") === name,
  );
}

it("lists connected model services with usage, toggles them and opens a provider", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
  const fetch = server({
    "GET /api/v1/model-services": () => ({
      presets: [
        preset("anthropic", "Anthropic"),
        preset("openai", "OpenAI"),
        preset("custom", "C"),
      ],
      connections: [connection],
      customBaseUrls: [],
    }),
    "GET /api/v1/workspace": () => ({
      bots: [{ id: "b", model: { connectionId: "c1", modelId: "claude-sonnet" } }],
      channels: [],
      nodes: [],
    }),
    "PATCH /api/v1/model-connections/c1": () => ({
      connection: { ...connection, enabled: false, revision: 2 },
    }),
  });
  const view = await renderComponent(<SettingsModelServices />);
  try {
    await interact(() => undefined);
    await interact(() => undefined);
    expect(view.container.textContent).toContain("claude-sonnet · 1 个 Bot 在用");
    await interact(() => buttonNamed(view.container, "启用 Anthropic")?.click());
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
      expectedRevision: 1,
      enabled: false,
    });
    expect(buttonNamed(view.container, "启用 Anthropic")?.getAttribute("aria-checked")).toBe(
      "false",
    );
    const search = view.container.querySelector<HTMLInputElement>('[aria-label="搜索服务商"]');
    if (!search) throw Error("search missing");
    await setInputValue(search, "open");
    expect(view.container.querySelectorAll(".settings-catalogue .settings-item")).toHaveLength(1);
    await interact(() => buttonNamed(view.container, "添加 OpenAI")?.click());
    const dialog = view.container.querySelector(".model-connection-dialog");
    expect(dialog?.querySelector(".model-provider strong")?.textContent).toBe("OpenAI");
    await interact(() => buttonNamed(view.container, "取消")?.click());
    expect(view.container.querySelector(".model-connection-dialog")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("pairs a host from the header action and shows the one-time token", async () => {
  const fetch = server({
    "GET /api/v1/node-identities": () => ({
      identities: [{ nodeId: "n-1", status: "active", connected: false, enrolledAt: t }],
    }),
    "GET /api/v1/workspace": () => ({ bots: [], channels: [], nodes: [] }),
    "POST /api/v1/nodes/enrollment-tokens": () => ({
      nodeId: "office-linux-01",
      token: "fixture-token",
      expiresAt: "2026-10-01T01:10:00.000Z",
    }),
  });
  const view = await renderComponent(
    <Slot>
      <SettingsHosts />
    </Slot>,
  );
  try {
    await interact(() => undefined);
    expect(view.container.querySelector("#settings-hosts-title")?.textContent).toBe(
      "已登记 · 1 台",
    );
    const pair = view.container.querySelector<HTMLButtonElement>(".slot button");
    expect(pair?.textContent).toBe("配对新主机");
    await interact(() => pair?.click());
    const input = view.container.querySelector<HTMLInputElement>(".settings-pairing-form input");
    if (!input) throw Error("pairing input missing");
    await setInputValue(input, "office-linux-01");
    await interact(() =>
      view.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await interact(() => undefined);
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ nodeId: "office-linux-01" });
    expect(view.container.querySelector(".settings-token pre")?.textContent).toContain(
      "OPENBOT_NODE_ENROLLMENT_TOKEN=fixture-token",
    );
  } finally {
    await view.unmount();
  }
});

it("renders routines as the settings list with a switch and confirmed delete", async () => {
  const automation = {
    id: "a1",
    name: "整理本周竞品动态",
    channelId: "c",
    botId: "b",
    prompt: "整理",
    intervalMinutes: 10080,
    enabled: true,
    nextRunAt: "2026-10-03T01:00:00.000Z",
    lastRunAt: null,
    lastRunId: null,
    lastOutcome: null,
    createdAt: t,
  };
  const fetch = server({
    "GET /api/v1/automations": () => ({ automations: [automation] }),
    "PATCH /api/v1/automations/a1": () => ({ automation: { ...automation, enabled: false } }),
    "DELETE /api/v1/automations/a1": () => ({}),
  });
  const bot: Bot = {
    id: "b",
    name: "研究助理",
    role: "研究",
    status: "idle",
    computerProfile: "none",
    createdAt: t,
  };
  const channel: Channel = { id: "c", name: "市场周报", botIds: ["b"], createdAt: t };
  const view = await renderComponent(
    <Slot>
      <AutomationsScreen bots={[bot]} channels={[channel]} />
    </Slot>,
  );
  try {
    await interact(() => undefined);
    expect(view.container.querySelector(".slot button")?.textContent).toBe("新建例行任务");
    expect(view.container.querySelector(".settings-routine small")?.textContent).toBe(
      "研究助理 · 发到 # 市场周报 · 每 7 天",
    );
    await interact(() => buttonNamed(view.container, "启用 整理本周竞品动态")?.click());
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
    await interact(() => buttonNamed(view.container, "删除 整理本周竞品动态")?.click());
    await interact(() => buttonNamed(view.container, "确认删除")?.click());
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    expect(view.container.querySelector(".settings-routine")).toBeNull();
  } finally {
    await view.unmount();
  }
});

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  role: "研究",
  status: "idle",
  computerProfile: "none",
  createdAt: t,
});
const skill = (id: string, name: string, state: string) => ({
  id,
  slug: id,
  name,
  description: "",
  version: "1.0.0",
  source: "learned",
  state,
  confidence: 80,
  requiredCapabilities: state === "candidate" ? ["浏览器"] : [],
  dependencyIds: [],
  evidence: [],
  acquiredAt: t,
  updatedAt: t,
});
const profileOf = (id: string, skills: unknown[]) => ({
  profile: {
    employee: bot(id, id),
    details: { description: "", revision: 1, updatedAt: t },
    evolution: [],
    skills,
    memories: [],
    memoryEvents: [],
    records: { runs: [], approvals: [], artifacts: [], decisions: [] },
    statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
    configuration: { executionProfile: "none", portabilityFormat: "openbot.employee/v1" },
  },
});

it("groups every Bot's skills into 待你审核 and 已安装 with counted filters", async () => {
  server({
    "GET /api/v1/bots/a/profile": () =>
      profileOf("a", [
        skill("s1", "读取更新日志", "verified"),
        skill("s2", "社交媒体监控", "candidate"),
      ]),
    "GET /api/v1/bots/b/profile": () => profileOf("b", [skill("s3", "批量重命名", "suspended")]),
  });
  const view = await renderComponent(
    <Slot>
      <SettingsSkills bots={[bot("a", "研究助理"), bot("b", "发布助手")]} />
    </Slot>,
  );
  try {
    await interact(() => undefined);
    await interact(() => undefined);
    const chips = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(".settings-filters button"),
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["全部 3", "已验证 1", "待审核 1", "已停用 1"]);
    expect(view.container.querySelector(".slot button")?.textContent).toBe("安装技能");
    const groups = Array.from(
      view.container.querySelectorAll(".settings-group > h3"),
      (h) => h.textContent,
    );
    expect(groups).toEqual(["待你审核", "已安装"]);
    expect(view.container.textContent).toContain("研究助理 · 在工作中学会 · 需要：浏览器");
    await interact(() =>
      view.container.querySelectorAll<HTMLButtonElement>(".settings-filters button")[3]?.click(),
    );
    expect(view.container.querySelectorAll(".settings-skill")).toHaveLength(1);
    expect(view.container.querySelector(".settings-skill .ob-tag")?.textContent).toBe("已暂停");
    await interact(() =>
      view.container.querySelectorAll<HTMLButtonElement>(".settings-filters button")[0]?.click(),
    );
    await interact(() => buttonNamed(view.container, "审核 社交媒体监控")?.click());
    await interact(() => undefined);
    expect(view.container.querySelector(".settings-subpage-title")?.textContent).toBe(
      "审核 研究助理 的技能",
    );
  } finally {
    await view.unmount();
  }
});

it("lists plugins with granted Bots, toggles them and expands 管理", async () => {
  const plugin = {
    id: "gmail",
    name: "Gmail",
    endpoint: "https://mcp.example.test/gmail",
    transport: "streamable-http",
    tools: [{ name: "search", description: "搜索", inputSchema: {}, mode: "read" }],
    revision: "r1",
    enabled: true,
    createdAt: t,
    grants: [{ botId: "a", tools: [] }],
  };
  const fetch = server({
    "GET /api/v1/plugins": () => ({ plugins: [plugin], pendingCalls: [] }),
    "PATCH /api/v1/plugins/gmail": () => ({}),
  });
  const view = await renderComponent(
    <Slot>
      <PluginManager bots={[bot("a", "研究助理")]} variant="settings" />
    </Slot>,
  );
  try {
    await interact(() => undefined);
    expect(view.container.querySelector(".slot button")?.textContent).toBe("添加插件");
    expect(view.container.querySelector(".settings-plugin small")?.textContent).toBe(
      "1 个工具 · 研究助理",
    );
    await interact(() => buttonNamed(view.container, "启用 Gmail")?.click());
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ revision: "r1", enabled: false });
    expect(view.container.querySelector(".settings-plugin-detail")).toBeNull();
    await interact(() => buttonNamed(view.container, "管理 Gmail")?.click());
    expect(view.container.querySelector(".settings-plugin-detail")?.textContent).toContain(
      "https://mcp.example.test/gmail",
    );
  } finally {
    await view.unmount();
  }
});

it("offers import and a per-Bot export with skill counts", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
  server({
    "GET /api/v1/bots/a/profile": () => profileOf("a", [skill("s1", "读取更新日志", "verified")]),
  });
  const view = await renderComponent(<SettingsTransfer bots={[bot("a", "研究助理")]} />);
  try {
    await interact(() => undefined);
    await interact(() => undefined);
    expect(view.container.querySelector(".settings-item small")?.textContent).toBe("1 项技能");
    await interact(() => buttonNamed(view.container, "导出 研究助理")?.click());
    expect(view.container.querySelector("dialog")).not.toBeNull();
  } finally {
    await view.unmount();
  }
});

it("edits approval levels and exact exceptions with the expected revision", async () => {
  const { SettingsApprovals } = await import("./SettingsApprovals");
  const botId = "11111111-1111-4111-8111-111111111111";
  const channelId = "22222222-2222-4222-8222-222222222222";
  const protectedExceptionCategories = [
    "delete",
    "install",
    "permission_change",
    "command",
    "browser",
    "plugin",
    "unknown",
  ];
  let state = {
    revision: 1,
    productRead: "inherit",
    publicWeb: "inherit",
    exceptions: [] as unknown[],
    protectedExceptionCategories,
  };
  const fetch = server({
    "GET /api/v1/settings/approvals": () => state,
    "PUT /api/v1/settings/approvals": (init) => {
      const body = JSON.parse(String(init?.body));
      state = { ...body, revision: state.revision + 1, protectedExceptionCategories };
      delete (state as { expectedRevision?: number }).expectedRevision;
      return state;
    },
  });
  const view = await renderComponent(
    <Slot>
      <SettingsApprovals
        bots={[{ ...bot(botId, "研究助理") }]}
        channels={[{ id: channelId, name: "市场周报", botIds: [botId], createdAt: t }]}
      />
    </Slot>,
  );
  try {
    await interact(() => undefined);
    expect(view.container.textContent).toContain("删除数据");
    const read = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="读取频道和附件"]',
    );
    await interact(() => {
      if (!read) throw Error("select missing");
      read.value = "required";
      read.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await interact(() => undefined);
    const firstPut = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(firstPut?.[1]?.body))).toEqual({
      expectedRevision: 1,
      productRead: "required",
      publicWeb: "inherit",
      exceptions: [],
    });
    await interact(() => view.container.querySelector<HTMLButtonElement>(".slot button")?.click());
    await interact(() => buttonNamed(view.container, "添加")?.click());
    await interact(() => undefined);
    const lastPut = fetch.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1);
    expect(JSON.parse(String(lastPut?.[1]?.body))).toMatchObject({
      expectedRevision: 2,
      exceptions: [
        { botId, category: "product_read", target: { kind: "channel", value: channelId } },
      ],
    });
    expect(view.container.querySelector(".settings-exception small")?.textContent).toBe(
      "读取频道 · # 市场周报",
    );
    await interact(() => buttonNamed(view.container, "移除 研究助理 的例外")?.click());
    await interact(() => undefined);
    expect(view.container.querySelector(".settings-exception")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("checks, restarts and (after confirmation) clears one Bot's employee browser", async () => {
  const { SettingsBrowser } = await import("./SettingsBrowser");
  const botId = "33333333-3333-4333-8333-333333333333";
  const fetch = server({
    [`POST /api/v1/bots/${botId}/browser/maintenance`]: (init) => {
      const body = JSON.parse(String(init?.body));
      return { botId, nodeId: "docker-1", running: body.operation !== "clear", paused: false };
    },
  });
  const view = await renderComponent(
    <SettingsBrowser
      bots={[{ ...bot(botId, "研究助理"), computerProfile: "docker-linux" }, bot("plain", "客服")]}
    />,
  );
  try {
    // Only Docker Bots have an employee browser; nothing runs until asked.
    expect(view.container.querySelectorAll(".settings-browser-bot")).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    await interact(() => buttonNamed(view.container, "检查状态")?.click());
    expect(view.container.querySelector(".settings-browser-row small")?.textContent).toBe(
      "运行中 · 主机 docker-1",
    );
    await interact(() => buttonNamed(view.container, "清除浏览数据…")?.click());
    expect(view.container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await interact(() => buttonNamed(view.container, "清除")?.click());
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { operation: "status" },
      { operation: "clear", confirmation: "clear-browser-data" },
    ]);
    expect(view.container.querySelector('[role="alertdialog"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("shows measured storage, the 回收站 and the opt-in 30-day purge", async () => {
  const GB = 1_000_000_000;
  const fetch = server({
    "GET /api/v1/storage": () => ({
      totalBytes: 12 * GB,
      measuredAt: t,
      categories: {
        channelFiles: { sizeBytes: 9 * GB, fileCount: 10 },
        trash: { sizeBytes: 1 * GB, fileCount: 4 },
        ownerTaskFiles: { sizeBytes: 0, fileCount: 0 },
        taskOutputs: null,
        retainedRunOutputs: { sizeBytes: 2 * GB, fileCount: 3 },
        other: { sizeBytes: 0, fileCount: 0 },
        database: { sizeBytes: 0 },
        workingComputerBrowserData: null,
      },
      trash: { fileCount: 4, sizeBytes: 1 * GB, referencedFileCount: 1 },
      topChannels: [
        { id: "c-1", name: "市场周报", deleted: false, sizeBytes: 6 * GB, fileCount: 8 },
        { id: "c-2", name: "旧频道", deleted: true, sizeBytes: 1 * GB, fileCount: 2 },
      ],
      topChannelsLimit: 20,
    }),
    "GET /api/v1/settings/storage": () => ({
      revision: 4,
      trashAutoPurgeDays: null,
      updatedAt: null,
      lastAutoPurgeAt: null,
    }),
    "PUT /api/v1/settings/storage": () => ({
      revision: 5,
      trashAutoPurgeDays: 30,
      updatedAt: t,
      lastAutoPurgeAt: null,
    }),
  });
  const view = await renderComponent(<SettingsStorage />);
  try {
    await interact(() => undefined);
    const text = view.container.textContent ?? "";
    expect(text).toContain("12.0 GB");
    // Retained run outputs stand in for task outputs; browser data is never estimated.
    expect(text).toContain("2.0 GB任务产出");
    expect(text).not.toContain("浏览器数据");
    expect(text).toContain("4 个文件 · 1.0 GB");
    expect(text).toContain("其中 1 个还被消息或任务引用，会保留；其余 3 个");
    expect(text).toContain("旧频道（已删除）");
    expect(
      [...view.container.querySelectorAll("button")].filter(
        (item) => item.textContent === "查看文件 ›",
      ),
    ).toHaveLength(1);
    const toggle = view.container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await interact(() => toggle?.click());
    const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      expectedRevision: 4,
      trashAutoPurgeDays: 30,
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  } finally {
    await view.unmount();
  }
});

it("formats storage in decimal units", () => {
  expect(formatStorageSize(999)).toBe("999 B");
  expect(formatStorageSize(1_200_000)).toBe("1.2 MB");
  expect(formatStorageSize(18_400_000_000)).toBe("18.4 GB");
  expect(formatStorageSize(250_000_000_000)).toBe("250 GB");
});
