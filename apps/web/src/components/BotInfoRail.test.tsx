// @vitest-environment jsdom
import type { Bot, EmployeeProfile, WorkspaceSnapshot } from "@openbot/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sidebarOrganization } from "../sidebar-organization";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { BotInfoRail } from "./BotInfoRail";

const api = vi.hoisted(() => ({
  updateEmployeeProfileDetails: vi.fn(),
  updateBotAppearance: vi.fn(),
  getOwnerPreferences: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));
vi.mock("../destination-api", () => ({
  listAutomations: vi.fn(async () => [
    {
      id: "a1",
      name: "周报",
      channelId: "direct-bot-1",
      botId: "bot-1",
      prompt: "写周报",
      intervalMinutes: 10080,
      enabled: true,
      nextRunAt: "2026-10-03T00:00:00.000Z",
      lastRunAt: null,
      lastRunId: null,
      lastOutcome: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ]),
}));

const model = { connectionId: "c1", modelId: "claude-sonnet" };
const bot: Bot = {
  id: "bot-1",
  name: "新建 Bot",
  role: "通用助手",
  status: "idle",
  computerProfile: "model",
  model,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const profile: EmployeeProfile = {
  employee: bot,
  details: { description: "", revision: 3, updatedAt: "2026-10-01T00:00:00.000Z" },
  evolution: [],
  skills: [],
  memories: [],
  memoryEvents: [],
  records: { runs: [], approvals: [], artifacts: [], decisions: [] },
  statistics: { totalRuns: 0, completedRuns: 0, failedRuns: 0, verifiedSkills: 0 },
  configuration: { executionProfile: "model", model, portabilityFormat: "openbot.employee/v1" },
};
const workspace: WorkspaceSnapshot = {
  channels: [],
  bots: [bot],
  nodes: [],
  runs: [],
  approvals: [],
  artifacts: [],
  progress: [],
  counts: { channels: 0, bots: 1, connectedNodes: 0, activeRuns: 0 },
};

function render(overrides: Partial<Parameters<typeof BotInfoRail>[0]> = {}) {
  const props = {
    bot,
    profile,
    workspace,
    onCollapse: vi.fn(),
    onShare: vi.fn(),
    onRename: vi.fn(async () => undefined),
    onProfileChanged: vi.fn(async () => undefined),
    onAppearanceChanged: vi.fn(),
    onDelete: vi.fn(async () => undefined),
    onDecideApproval: vi.fn(async () => undefined),
    onManageModels: vi.fn(),
    ...overrides,
  };
  return { props, view: renderComponent(<BotInfoRail {...props} />) };
}
function buttonByText(container: HTMLElement, text: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  );
  if (!found) throw Error(`${text} missing`);
  return found;
}

beforeEach(() => {
  api.updateEmployeeProfileDetails.mockReset();
  api.updateBotAppearance.mockReset();
  api.getOwnerPreferences.mockResolvedValue({ defaultModel: model });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});
afterEach(() => {
  sidebarOrganization.setMuted("bot:bot-1", false);
});

it("renames in place and turns the placeholder role into 添加标签 saved with the revision", async () => {
  api.updateEmployeeProfileDetails.mockResolvedValue({});
  const { props, view: pending } = render();
  const view = await pending;
  try {
    const name = view.container.querySelector<HTMLInputElement>('input[aria-label="Bot 名称"]');
    if (!name) throw Error("name missing");
    await setInputValue(name, " 写作助理 ");
    await interact(() => name.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(props.onRename).toHaveBeenCalledWith("写作助理");

    await interact(() => buttonByText(view.container, "添加标签").click());
    const tag = view.container.querySelector<HTMLInputElement>('input[aria-label="标签"]');
    if (!tag) throw Error("tag missing");
    await setInputValue(tag, "写作");
    await interact(() => tag.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(api.updateEmployeeProfileDetails).toHaveBeenCalledWith("bot-1", {
      role: "写作",
      description: "",
      expectedRevision: 3,
    });
    expect(props.onProfileChanged).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("shows how the Bot works, its routines and the computer tab", async () => {
  const { view: pending } = render();
  const view = await pending;
  try {
    const text = () => view.container.textContent ?? "";
    expect(text()).toContain("默认 · claude-sonnet");
    expect(text()).toContain("不用电脑");
    expect(text()).toContain("周报");
    expect(text()).toContain("每 7 天");
    await interact(() =>
      Array.from(view.container.querySelectorAll("button"))
        .find((item) => item.textContent?.startsWith("电脑"))
        ?.click(),
    );
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "电脑",
    );
    expect(text()).toContain("不代表有权操作电脑");
  } finally {
    await view.unmount();
  }
});

it("mutes on this device, shares the template and confirms before deleting", async () => {
  const { props, view: pending } = render();
  const view = await pending;
  try {
    const toggle = view.container.querySelector<HTMLButtonElement>('[role="switch"]');
    await interact(() => toggle?.click());
    expect(sidebarOrganization.snapshot().muted).toContain("bot:bot-1");
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="分享 Bot 模板"]')?.click(),
    );
    expect(props.onShare).toHaveBeenCalledOnce();
    await interact(() => buttonByText(view.container, "删除这个 Bot…").click());
    expect(props.onDelete).not.toHaveBeenCalled();
    await interact(() => buttonByText(view.container, "永久删除").click());
    expect(props.onDelete).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("edits the avatar in place at the profile revision and recovers from a stale one", async () => {
  const look = { head: "round", body: "classic", mobility: "feet", accessory: "none" } as const;
  const lookingBot: Bot = { ...bot, appearance: { ...look, accent: "green" } };
  api.updateBotAppearance.mockImplementation(async (_id, input) => ({
    bot: { ...lookingBot, appearance: input.appearance },
    revision: input.expectedRevision + 1,
  }));
  const { props, view: pending } = render({ bot: lookingBot });
  const view = await pending;
  try {
    const open = view.container.querySelector<HTMLButtonElement>('button[aria-label="编辑头像"]');
    await interact(() => open?.click());
    expect(open?.getAttribute("aria-expanded")).toBe("true");
    const radio = (group: string, label: string) =>
      Array.from(
        view.container.querySelectorAll<HTMLButtonElement>(
          `fieldset[aria-label="${group}"] button`,
        ),
      ).find((item) => (item.getAttribute("aria-label") ?? item.textContent) === label);

    await interact(() => radio("头型", "猫耳")?.click());
    expect(api.updateBotAppearance).toHaveBeenLastCalledWith("bot-1", {
      expectedRevision: 3,
      appearance: { ...look, head: "cat", accent: "green" },
    });
    expect(props.onAppearanceChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ appearance: { ...look, head: "cat", accent: "green" } }),
    );

    // The next change uses the revision the Server returned, before the profile is read again.
    await interact(() => radio("下颌色", "紫")?.click());
    expect(api.updateBotAppearance).toHaveBeenLastCalledWith("bot-1", {
      expectedRevision: 4,
      appearance: { ...look, head: "round", accent: "violet" },
    });

    const { ApiError } = await import("../api");
    api.updateBotAppearance.mockRejectedValueOnce(new ApiError("changed", 409));
    await interact(() => radio("下颌色", "青")?.click());
    expect(props.onProfileChanged).toHaveBeenCalled();
    expect(view.container.querySelector(".bi-avatar-popover [role=alert]")?.textContent).toContain(
      "别处改过",
    );

    // A press outside closes the popover.
    await interact(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(view.container.querySelector(".bi-avatar-popover")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("edits 介绍 in place with the profile revision and keeps the role", async () => {
  api.updateEmployeeProfileDetails.mockResolvedValue({});
  const { props, view: pending } = render();
  const view = await pending;
  try {
    await interact(() => buttonByText(view.container, "添加介绍").click());
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="介绍"]');
    if (!field) throw Error("description missing");
    await setInputValue(field, " 写周报和整理资料 ");
    await interact(() => field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(api.updateEmployeeProfileDetails).toHaveBeenCalledWith("bot-1", {
      role: "通用助手",
      description: "写周报和整理资料",
      expectedRevision: 3,
    });
    expect(props.onProfileChanged).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it.each([
  ["model", true],
  ["docker-linux", true],
  ["none", false],
  ["macos-cua", false],
  ["lume-vm", false],
  ["coder", false],
] as const)(
  "lets the Owner change the model only for a %s Bot",
  async (computerProfile, editable) => {
    const item = { ...bot, computerProfile };
    const { view: pending } = render({
      bot: item,
      profile: {
        ...profile,
        employee: item,
        configuration: { ...profile.configuration, executionProfile: computerProfile },
      },
    });
    const view = await pending;
    try {
      const row = Array.from(view.container.querySelectorAll<HTMLButtonElement>(".bi-row")).find(
        (button) => button.textContent?.startsWith("模型"),
      );
      expect(row?.disabled).toBe(!editable);
    } finally {
      await view.unmount();
    }
  },
);

it("links skills and memory to Settings and opens the Docker browser from 电脑", async () => {
  const onOpenSettings = vi.fn();
  const onOpenBrowser = vi.fn();
  const docker = { ...bot, computerProfile: "docker-linux" as const };
  const { view: pending } = render({
    bot: docker,
    profile: { ...profile, employee: docker },
    onOpenSettings,
    onOpenBrowser,
  });
  const view = await pending;
  try {
    const row = (label: string) =>
      Array.from(view.container.querySelectorAll<HTMLButtonElement>(".bi-row")).find((button) =>
        button.textContent?.startsWith(label),
      );
    expect(row("技能")?.textContent).toContain("0 个");
    await interact(() => row("技能")?.click());
    await interact(() => row("记忆")?.click());
    expect(onOpenSettings.mock.calls).toEqual([["skills"], ["memory"]]);
    await interact(() => buttonByText(view.container, "电脑").click());
    await interact(() => row("员工浏览器")?.click());
    expect(onOpenBrowser).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("shows 工作 with live tasks first, sourced 成长 and the Hermes attribution", async () => {
  const run = (id: string, status: string, createdAt: string, title: string) =>
    ({
      id,
      channelId: "direct-bot-1",
      botId: "bot-1",
      instruction: "",
      title,
      status,
      executionProfile: "model",
      createdAt,
    }) as EmployeeProfile["records"]["runs"][number];
  const onOpenRun = vi.fn();
  const { view: pending } = render({
    profile: {
      ...profile,
      statistics: { totalRuns: 7, completedRuns: 5, failedRuns: 1, verifiedSkills: 2 },
      records: {
        ...profile.records,
        runs: [
          run("done", "completed", "2026-09-29T10:00:00.000Z", "整理本周周报"),
          run("bad", "failed", "2026-09-30T08:00:00.000Z", "抓取官网"),
          run("live", "running", "2026-09-28T10:00:00.000Z", "抓取竞品更新日志"),
          ...["a", "b", "c"].map((id) =>
            run(id, "completed", "2026-09-01T10:00:00.000Z", `旧任务 ${id}`),
          ),
        ],
      },
      evolution: [
        {
          id: "e1",
          botId: "bot-1",
          type: "skill_verified",
          title: "新增技能「读取更新日志」",
          summary: "通过确定性测试",
          source: "run",
          evidence: [{ kind: "run", id: "done", label: "整理本周周报" }],
          createdAt: "2026-09-29T12:00:00.000Z",
        },
      ],
    },
    workspace: {
      ...workspace,
      channels: [
        {
          id: "direct-bot-1",
          name: "新建 Bot",
          botIds: ["bot-1"],
          directBotId: "bot-1",
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    },
    onOpenRun,
  });
  const view = await pending;
  try {
    await interact(() => buttonByText(view.container, "工作").click());
    expect(
      Array.from(view.container.querySelectorAll(".bi-stats > div")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["任务7", "完成5", "失败1", "已验证技能2"]);
    const titles = () =>
      Array.from(view.container.querySelectorAll(".bi-work-row strong")).map(
        (item) => item.textContent,
      );
    expect(titles()).toEqual(["抓取竞品更新日志", "抓取官网", "整理本周周报", "旧任务 a"]);
    expect(view.container.querySelector(".bi-work-state.is-bad")?.textContent).toBe("没能完成");
    await interact(() => buttonByText(view.container, "全部 6 个 ›").click());
    expect(titles()).toHaveLength(6);
    await interact(() => view.container.querySelector<HTMLButtonElement>(".bi-work-row")?.click());
    expect(onOpenRun).toHaveBeenCalledWith("live");

    const growth = view.container.querySelector(".bi-event");
    expect(growth?.textContent).toContain("新增技能「读取更新日志」");
    expect(growth?.textContent).toContain("来自任务 · 1 条证据");
    expect(growth?.getAttribute("title")).toBe("来自任务：整理本周周报");
    expect(view.container.querySelector(".bi-events a")).toBeNull();
    expect(view.container.textContent).toContain("Hermes Agent");
  } finally {
    await view.unmount();
  }
});

it("moves tab selection and focus together with Arrow, Home and End keys", async () => {
  const { view: pending } = render();
  const view = await pending;
  try {
    const tabs = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["详情", "工作", "资料库", "电脑"]);
    const press = (key: string) =>
      interact(() =>
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
      );
    const selected = () =>
      view.container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    await interact(() => tabs[0]?.focus());
    await press("ArrowLeft");
    expect(selected()?.textContent).toBe("电脑");
    expect(document.activeElement).toBe(selected());
    expect(selected()?.tabIndex).toBe(0);
    await press("Home");
    expect(selected()?.textContent).toBe("详情");
    await press("ArrowRight");
    expect(selected()?.textContent).toBe("工作");
    expect(document.activeElement).toBe(selected());
    await press("End");
    expect(selected()?.textContent).toBe("电脑");
    await press("ArrowDown");
    expect(selected()?.textContent).toBe("电脑");
    expect(document.activeElement).toBe(selected());
  } finally {
    await view.unmount();
  }
});
