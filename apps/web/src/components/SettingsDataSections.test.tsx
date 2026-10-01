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
    expect(view.container.querySelector(".settings-subpage")).not.toBeNull();
    expect(view.container.querySelector<HTMLSelectElement>("select")?.value).toBe("openai");
    await interact(() => buttonNamed(view.container, "‹ 模型服务")?.click());
    expect(view.container.querySelector(".settings-subpage")).toBeNull();
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
      <AutomationsScreen bots={[bot]} channels={[channel]} variant="settings" />
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
