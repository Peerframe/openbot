// @vitest-environment jsdom
import type { Bot, Channel } from "@openbot/domain";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { AutomationsScreen } from "./AutomationsScreen";
import { SettingsActionSlot } from "./SettingsHeaderAction";
import { SettingsHosts } from "./SettingsHosts";
import { SettingsModelServices } from "./SettingsModelServices";

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
