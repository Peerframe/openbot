// @vitest-environment jsdom
import type { Bot, Channel } from "@openbot/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Automation } from "../destination-api";
import { deferred, interact, renderComponent, setInputValue } from "../test/render-component";
import { AutomationsScreen } from "./AutomationsScreen";

const bots: Bot[] = [
  {
    id: "bot-1",
    name: "Researcher",
    role: "Research",
    status: "idle",
    computerProfile: "none",
    createdAt: "2026-09-05T00:00:00Z",
  },
  {
    id: "bot-2",
    name: "Unassigned",
    role: "Review",
    status: "idle",
    computerProfile: "none",
    createdAt: "2026-09-05T00:00:00Z",
  },
];
const channels: Channel[] = [
  {
    id: "channel-1",
    name: "Research",
    description: "",
    botIds: ["bot-1"],
    createdAt: "2026-09-05T00:00:00Z",
  },
];
const automation: Automation = {
  id: "automation-1",
  name: "站点检查",
  channelId: "channel-1",
  botId: "bot-1",
  prompt: "检查网站是否能打开",
  enabled: true,
  intervalMinutes: 1440,
  nextRunAt: "2026-09-06T09:00:00Z",
  lastRunAt: null,
  lastRunId: null,
  lastOutcome: null,
  createdAt: "2026-09-05T09:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === name,
  );
  if (!result) throw new Error(`Missing button ${name}`);
  return result;
}
async function setTextArea(textarea: HTMLTextAreaElement, value: string) {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AutomationsScreen", () => {
  it("explains a stopped attachment task without exposing server paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          automations: [{ ...automation, enabled: false, lastOutcome: "attachment_unavailable" }],
        }),
      ),
    );
    const rendered = await renderComponent(<AutomationsScreen bots={bots} channels={channels} />);
    try {
      expect(rendered.container.textContent).toContain("附件已删除、损坏或不可用，自动任务已暂停");
      expect(rendered.container.textContent).toContain("恢复原附件后重新启用");
    } finally {
      await rendered.unmount();
    }
  });
  it("creates a Server schedule with local time converted to UTC and an assigned Bot", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? Response.json({ automation }) : Response.json({ automations: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await renderComponent(<AutomationsScreen bots={bots} channels={channels} />);
    try {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await interact(() => button(rendered.container, "新建任务").click());
      const form = rendered.container.querySelector("form") as HTMLFormElement;
      expect(Array.from(form.querySelectorAll("select"))[1]?.textContent).not.toContain(
        "Unassigned",
      );
      await setInputValue(
        form.querySelector('input:not([type="datetime-local"])') as HTMLInputElement,
        "站点检查",
      );
      await setTextArea(
        form.querySelector("textarea") as HTMLTextAreaElement,
        "检查网站是否能打开",
      );
      const localDate = (form.querySelector('input[type="datetime-local"]') as HTMLInputElement)
        .value;
      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      const [, init] = fetchMock.mock.calls.find(([, options]) => options?.method === "POST") ?? [];
      expect(JSON.parse(init?.body as string)).toEqual({
        name: "站点检查",
        channelId: "channel-1",
        botId: "bot-1",
        prompt: "检查网站是否能打开",
        intervalMinutes: 1440,
        firstRunAt: new Date(localDate).toISOString(),
      });
      expect(rendered.container.querySelector("form")).toBeNull();
      expect(rendered.container.querySelector("article")?.textContent).toContain("站点检查");
    } finally {
      await rendered.unmount();
    }
  });

  it("keeps failed mutations visible and requires a separate delete confirmation", async () => {
    let failPatch = true;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return failPatch
          ? Response.json({}, { status: 503 })
          : Response.json({ automation: { ...automation, enabled: false } });
      if (init?.method === "DELETE") return Response.json({ deleted: true });
      return Response.json({ automations: [automation] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await renderComponent(<AutomationsScreen bots={bots} channels={channels} />);
    try {
      await interact(() => button(rendered.container, "暂停").click());
      expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("无法更新");
      expect(button(rendered.container, "暂停").disabled).toBe(false);
      failPatch = false;
      await interact(() => button(rendered.container, "暂停").click());
      expect(button(rendered.container, "恢复").disabled).toBe(false);
      await interact(() => button(rendered.container, "删除").click());
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
      await interact(() => button(rendered.container, "确认删除").click());
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/v1/automations/automation-1",
        expect.objectContaining({ credentials: "include", method: "DELETE" }),
      );
      expect(rendered.container.querySelector("article")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  it("disables creation on an older Server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 404 })),
    );
    const rendered = await renderComponent(<AutomationsScreen bots={bots} channels={channels} />);
    try {
      expect(rendered.container.textContent).toContain("服务电脑暂不支持自动任务");
      expect(button(rendered.container, "新建任务").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  it("does not acknowledge a failed create and preserves the user's input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({}, { status: 409 })
          : Response.json({ automations: [] }),
      ),
    );
    const rendered = await renderComponent(<AutomationsScreen bots={bots} channels={channels} />);
    try {
      await interact(() => button(rendered.container, "新建任务").click());
      const form = rendered.container.querySelector("form") as HTMLFormElement;
      await setInputValue(
        form.querySelector('input:not([type="datetime-local"])') as HTMLInputElement,
        "Keep this name",
      );
      await setTextArea(
        form.querySelector("textarea") as HTMLTextAreaElement,
        "Keep this instruction",
      );
      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(form.querySelector('[role="alert"]')?.textContent).toContain("未能确认");
      expect(form.querySelector("textarea")?.value).toBe("Keep this instruction");
      expect(rendered.container.querySelector("article")).toBeNull();
      expect(button(rendered.container, "创建自动任务").disabled).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });
  it("disables repeat mutations until Server acknowledgement", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH" ? pending.promise : Response.json({ automations: [automation] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rendered = await renderComponent(<AutomationsScreen bots={bots} channels={channels} />);
    try {
      await interact(() => button(rendered.container, "暂停").click());
      expect(button(rendered.container, "保存中…").disabled).toBe(true);
      expect(button(rendered.container, "删除").disabled).toBe(true);
      expect(button(rendered.container, "刷新").disabled).toBe(true);
      await interact(() =>
        pending.resolve(Response.json({ automation: { ...automation, enabled: false } })),
      );
      expect(button(rendered.container, "恢复").disabled).toBe(false);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
  });

  it("explains empty targets instead of offering a broken create form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ automations: [] })),
    );
    const rendered = await renderComponent(<AutomationsScreen bots={[]} channels={[]} />);
    try {
      expect(button(rendered.container, "新建任务").disabled).toBe(true);
      expect(rendered.container.textContent).toContain("先创建 Bot");
      expect(rendered.container.querySelector("form")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});
