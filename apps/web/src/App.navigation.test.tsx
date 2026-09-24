// @vitest-environment jsdom

import type { Bot, Channel, Run, WorkspaceSnapshot } from "@openbot/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as api from "./api";
import type { OpenBotDesktopBridge } from "./desktop-runtime";
import { interact, renderComponent, setInputValue } from "./test/render-component";
import { defaultPreferences, updatePreferences } from "./workspace-preferences";
import * as workApi from "./work-api";

vi.mock("./work-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./work-api")>()),
  listWorkBots: vi.fn(async () => [{ id: "bot-one", name: "Navigator" }]),
}));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    getAuthSession: vi.fn(),
    getWorkspace: vi.fn(),
    getEmployeeProfile: vi.fn(),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    createChannel: vi.fn(),
    subscribeToWorkspaceEvents: vi.fn(() => vi.fn()),
    subscribeToChannelEvents: vi.fn(() => vi.fn()),
  };
});
vi.mock("./destination-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./destination-api")>()),
  listAutomations: vi.fn(async () => []),
}));

const bot: Bot = {
  id: "bot-one",
  name: "Navigator",
  role: "Assistant",
  status: "idle",
  computerProfile: "none",
  createdAt: "2026-09-05T00:00:00Z",
};
const channelA: Channel = {
  id: "channel-a",
  name: "产品讨论",
  description: "产品频道",
  botIds: [bot.id],
  createdAt: "2026-09-05T00:00:00Z",
};
const channelB: Channel = {
  ...channelA,
  id: "channel-b",
  name: "设计讨论",
  description: "设计频道",
};
let snapshot: WorkspaceSnapshot;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

beforeEach(() => {
  vi.clearAllMocks();
  snapshot = {
    channels: [channelA, channelB],
    bots: [bot],
    nodes: [],
    runs: [],
    approvals: [],
    artifacts: [],
    progress: [],
    counts: { channels: 2, bots: 1, connectedNodes: 0, activeRuns: 0 },
  };
  vi.mocked(api.getAuthSession).mockResolvedValue({
    authenticated: true,
    expiresAt: "2999-01-01T00:00:00Z",
    owner: { id: "owner-one", name: "Owner" },
  });
  vi.mocked(api.getWorkspace).mockImplementation(async () => snapshot);
  vi.mocked(api.listMessages).mockResolvedValue([]);
  vi.mocked(api.listRuns).mockResolvedValue([]);
  vi.mocked(api.getEmployeeProfile).mockRejectedValue(
    new Error("No skill profile in routing fixture"),
  );
  vi.mocked(api.createChannel).mockImplementation(async (input) => {
    const channel = { ...channelA, ...input, id: "created-channel" };
    snapshot = {
      ...snapshot,
      channels: [...snapshot.channels, channel],
      counts: { ...snapshot.counts, channels: snapshot.channels.length + 1 },
    };
    return channel;
  });
  const bridge: OpenBotDesktopBridge = {
    getConnectionState: vi.fn(async () => ({
      status: "configured",
      serverUrl: "https://openbot.example",
    })),
    configureServer: vi.fn(),
    getSetupPlanState: vi.fn(async () => ({
      status: "configured",
      plan: { mode: "client", plannedWorkerCount: 0, localWorker: false },
    })),
    saveSetupPlan: vi.fn(),
    getLocalWorkerState: vi.fn(async () => ({ status: "not-selected" })),
    setupLocalWorker: vi.fn(),
    enableLocalWorker: vi.fn(),
    openLocalWorkerSettings: vi.fn(),
  };
  window.openbotDesktop = bridge;
  updatePreferences(defaultPreferences);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? this.scrollTop;
    },
  });
});

afterEach(() => {
  delete window.openbotDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  restoreProperty(HTMLDialogElement.prototype, "close", originalClose);
  restoreProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
});

describe("Desktop workspace navigation continuity", () => {
  it("hides and inerts the existing workspace during settings, retaining draft and scroll", async () => {
    const rendered = await renderComponent(<App />);
    try {
      await settleEffects();
      const workspace = rendered.container.querySelector<HTMLElement>(".workspace-preserved");
      const shell = rendered.container.querySelector(".app-shell");
      const input = composer(rendered.container);
      await enterDraft(input, "继续整理产品方案");
      const messages = rendered.container.querySelector<HTMLElement>(".message-list");
      if (!workspace || !messages) throw new Error("Workspace did not open");
      messages.scrollTop = 84;
      await interact(() =>
        rendered.container.querySelector<HTMLElement>(".owner-menu summary")?.click(),
      );
      await interact(() => buttonByText(rendered.container, "设置").click());
      expect(workspace.hidden).toBe(true);
      expect(workspace.hasAttribute("inert")).toBe(true);
      expect(rendered.container.querySelector(".app-shell")).toBe(shell);
      expect(rendered.container.querySelector(".desktop-settings-layout")).not.toBeNull();
      expect(api.subscribeToWorkspaceEvents).toHaveBeenCalledTimes(1);
      expect(api.subscribeToChannelEvents).toHaveBeenCalledTimes(1);

      await interact(() => buttonByLabel(rendered.container, "关闭设置").click());
      await settleEffects();
      expect(workspace.hidden).toBe(false);
      expect(workspace.hasAttribute("inert")).toBe(false);
      expect(rendered.container.querySelector(".app-shell")).toBe(shell);
      expect(composer(rendered.container)).toBe(input);
      expect(input.value).toBe("继续整理产品方案");
      expect(messages.scrollTop).toBe(84);
      expect(api.getWorkspace).toHaveBeenCalledTimes(1);
      expect(api.subscribeToChannelEvents).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  it("restores the correct channel draft with back and forward after returning from settings", async () => {
    const rendered = await renderComponent(<App />);
    try {
      await settleEffects();
      expect(title(rendered.container)).toBe(channelA.name);
      expect(buttonByLabel(rendered.container, "后退").disabled).toBe(true);
      await enterDraft(composer(rendered.container), "产品频道草稿");
      await interact(() => channelButton(rendered.container, channelB.name).click());
      await settleEffects();
      expect(title(rendered.container)).toBe(channelB.name);
      expect(composer(rendered.container).value).toBe("");
      await enterDraft(composer(rendered.container), "设计频道草稿");

      await interact(() =>
        rendered.container.querySelector<HTMLElement>(".owner-menu summary")?.click(),
      );
      await interact(() => buttonByText(rendered.container, "设置").click());
      await interact(() => buttonByLabel(rendered.container, "关闭设置").click());
      expect(title(rendered.container)).toBe(channelB.name);
      expect(composer(rendered.container).value).toBe("设计频道草稿");

      await interact(() => buttonByLabel(rendered.container, "后退").click());
      await settleEffects();
      expect(title(rendered.container)).toBe(channelA.name);
      expect(composer(rendered.container).value).toBe("产品频道草稿");
      expect(channelButton(rendered.container, channelA.name).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(buttonByLabel(rendered.container, "前进").disabled).toBe(false);

      await interact(() => buttonByLabel(rendered.container, "前进").click());
      await settleEffects();
      expect(title(rendered.container)).toBe(channelB.name);
      expect(composer(rendered.container).value).toBe("设计频道草稿");
      expect(channelButton(rendered.container, channelB.name).getAttribute("aria-current")).toBe(
        "page",
      );
      expect(buttonByLabel(rendered.container, "前进").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  it("returns from the full-page plugin library and creates a channel through the single creation menu", async () => {
    const rendered = await renderComponent(<App />);
    try {
      await settleEffects();
      await enterDraft(composer(rendered.container), "保留这个草稿");
      await interact(() => buttonByText(rendered.container, "插件").click());
      await settleEffects();
      expect(rendered.container.querySelector(".full-page-destination")).not.toBeNull();
      await interact(() =>
        rendered.container
          .querySelector<HTMLButtonElement>(".plugin-refresh .settings-back")
          ?.click(),
      );
      await settleEffects();
      expect(composer(rendered.container).value).toBe("保留这个草稿");
      await interact(() =>
        rendered.container.querySelector<HTMLElement>(".create-menu summary")?.click(),
      );
      await interact(() => buttonByText(rendered.container, "创建频道").click());
      const dialog = rendered.container.querySelector("dialog");
      const name = dialog?.querySelector("input");
      if (!(name instanceof HTMLInputElement)) throw new Error("Create channel dialog missing");
      await setInputValue(name, "新的频道");
      const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      await interact(() => checkbox?.click());
      await interact(() =>
        dialog
          ?.querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settleEffects();
      expect(api.createChannel).toHaveBeenCalledWith({
        name: "新的频道",
        description: "",
        botIds: [bot.id],
      });
      expect(title(rendered.container)).toBe("新的频道");
      expect(rendered.container.querySelector("dialog")).toBeNull();
      expect(composer(rendered.container).id).toBe("message-created-channel");
      expect(document.activeElement).toBe(composer(rendered.container));
      await interact(() => buttonByLabel(rendered.container, "后退").click());
      await settleEffects();
      expect(composer(rendered.container).value).toBe("保留这个草稿");
    } finally {
      await rendered.unmount();
    }
  });

  it("wires AuthenticatedWorkspace RunInspector with childRuns botsById and onInspectRun", async () => {
    const chief: Bot = {
      id: "chief",
      name: "总管",
      role: "Coordinate",
      status: "running",
      computerProfile: "none",
      createdAt: "2026-09-11T00:00:00Z",
    };
    const researcher: Bot = {
      id: "researcher",
      name: "研究员",
      role: "Research",
      status: "running",
      computerProfile: "none",
      createdAt: "2026-09-11T00:00:00Z",
    };
    const parent: Run = {
      id: "parent",
      channelId: channelA.id,
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
    snapshot = {
      ...snapshot,
      bots: [chief, researcher],
      channels: [{ ...channelA, botIds: [chief.id, researcher.id] }, channelB],
      runs: [parent, child],
      counts: { channels: 2, bots: 2, connectedNodes: 0, activeRuns: 2 },
    };
    vi.mocked(api.listRuns).mockResolvedValue([parent, child]);

    const rendered = await renderComponent(<App />);
    try {
      await settleEffects();
      await interact(() => buttonByLabel(rendered.container, "查看任务：Prepare a report").click());
      await settleEffects();

      const inspector = rendered.container.querySelector(".run-inspector");
      expect(inspector).not.toBeNull();
      expect(inspector?.textContent).toContain("分工");
      expect(inspector?.textContent).toContain("研究员");
      expect(inspector?.textContent).toContain("Research");
      expect(inspector?.querySelector("#run-title")?.textContent).toBe("Prepare a report");

      const roles = inspector!.querySelector('[aria-label="分工"]');
      expect(roles).not.toBeNull();
      const childStatus = [...roles!.querySelectorAll("button")].find((node) =>
        node.textContent?.includes("执行中"),
      );
      expect(childStatus).toBeTruthy();
      await interact(() => childStatus!.click());
      await settleEffects();

      expect(rendered.container.querySelector(".run-inspector #run-title")?.textContent).toBe(
        "Check sources",
      );
    } finally {
      await rendered.unmount();
    }
  });
});

function composer(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector('[aria-label="消息内容"]');
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("Composer missing");
  return input;
}

async function enterDraft(input: HTMLTextAreaElement, value: string) {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Textarea setter missing");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function title(container: HTMLElement) {
  return container.querySelector(
    ".workspace-toolbar .channel-heading strong, .workspace-toolbar h1",
  )?.textContent;
}

function channelButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".channel-list-row"),
  ).find((item) => item.querySelector("strong")?.textContent === name);
  if (!button) throw new Error(`Channel button missing: ${name}`);
  return button;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button missing: ${text}`);
  return button;
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Button missing: ${label}`);
  return button;
}

async function settleEffects() {
  await interact(() => {});
  await new Promise((resolve) => window.setTimeout(resolve, 5));
  await interact(() => {});
}

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

it.each(["web", "desktop"])(
  "opens the direct work entry on %s without the unavailable workspace aggregate",
  async (shell) => {
    if (shell === "web") delete window.openbotDesktop;
    window.history.replaceState(null, "", "#/tasks");
    const rendered = await renderComponent(<App />);
    try {
      await settleEffects();
      expect(api.getWorkspace).not.toHaveBeenCalled();
      expect(workApi.listWorkBots).toHaveBeenCalled();
      expect(rendered.container.textContent).toContain("任务监督");
      expect(rendered.container.querySelector("select")?.textContent).toContain("Navigator");
    } finally {
      await rendered.unmount();
      window.history.replaceState(null, "", "/");
    }
  },
);

it("preserves the work draft when navigating away through the shared sidebar", async () => {
  const rendered = await renderComponent(<App />);
  try {
    await settleEffects();
    await interact(() => buttonByText(rendered.container, "任务监督").click());
    await enterDraft(
      rendered.container.querySelector(".work-form textarea")!,
      "Pending work objective",
    );
    await interact(() => channelButton(rendered.container, "产品讨论").click());
    await interact(() => buttonByText(rendered.container, "任务监督").click());
    expect(
      rendered.container.querySelector<HTMLTextAreaElement>(".work-form textarea")?.value,
    ).toBe("Pending work objective");
  } finally {
    await rendered.unmount();
  }
});
