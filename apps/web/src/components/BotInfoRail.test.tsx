// @vitest-environment jsdom
import type { Bot, EmployeeProfile, WorkspaceSnapshot } from "@openbot/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sidebarOrganization } from "../sidebar-organization";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { BotInfoRail } from "./BotInfoRail";

const api = vi.hoisted(() => ({
  updateEmployeeProfileDetails: vi.fn(),
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
