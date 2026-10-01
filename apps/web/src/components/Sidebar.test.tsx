// @vitest-environment jsdom
import type { Bot, Channel } from "@openbot/domain";
import { expect, it, vi } from "vitest";
import { sidebarOrganization } from "../sidebar-organization";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { Sidebar } from "./Sidebar";

const channels: Channel[] = [
  {
    id: "design",
    name: "Design",
    description: "Interface review",
    botIds: [],
    createdAt: "2026-09-05T00:00:00Z",
  },
  {
    id: "code",
    name: "开发",
    description: "Release checks",
    botIds: [],
    createdAt: "2026-09-05T00:00:00Z",
  },
];
const bots: Bot[] = [
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Review",
    status: "idle",
    computerProfile: "none",
    createdAt: "2026-09-05T00:00:00Z",
  },
];
function rows(container: HTMLElement, kind: "channel" | "bot") {
  return container.querySelectorAll<HTMLButtonElement>(`.sb-row[data-kind="${kind}"]`);
}

it("searches conversations and groups, opens the first result and keeps actions functional", async () => {
  const select = vi.fn();
  const create = vi.fn();
  const settings = vi.fn();
  const direct = vi.fn();
  const profile = vi.fn();
  const view = await renderComponent(
    <Sidebar
      bots={bots}
      channels={channels}
      runs={[]}
      ownerName="Owner"
      selectedChannelId="design"
      onSelectChannel={select}
      onSelectBot={direct}
      onOpenBotProfile={profile}
      onCreateBot={vi.fn()}
      onCreateChannel={create}
      onManageNodes={vi.fn()}
      onLogout={vi.fn()}
      onSettings={settings}
    />,
  );
  try {
    // No wordmark or "频道和 Bots" heading when there are no groups (Sidebar artboard).
    expect(view.container.querySelector(".brand")).toBeNull();
    expect(view.container.querySelector(".sb-section-title")).toBeNull();
    const search = view.container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) throw Error("Search input missing");
    expect(search.placeholder).toBe("搜索对话、Bot 和分组");
    await setInputValue(search, "REVIEW");
    // "Interface review" matches the channel description and "Review" the Bot role.
    expect(rows(view.container, "channel")).toHaveLength(1);
    expect(rows(view.container, "bot")).toHaveLength(1);
    expect(view.container.textContent).toContain("对话2");
    expect(view.container.querySelector(".sb-row mark")?.textContent).toBe("Review");
    expect(view.container.textContent).toContain("按回车打开第一个结果");
    await setInputValue(search, "not present");
    expect(view.container.textContent).toContain("没有匹配的对话、Bot 或分组");
    await interact(() =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(search.value).toBe("");
    expect(rows(view.container, "channel")).toHaveLength(2);
    await setInputValue(search, "开发");
    await interact(() =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(select).toHaveBeenCalledWith("code");
    expect(search.value).toBe("");
    const selected = view.container.querySelector('[aria-current="page"]');
    if (!(selected instanceof HTMLButtonElement)) throw Error("Selected channel missing");
    await interact(() => selected.click());
    expect(select).toHaveBeenCalledWith("design");
    const buttons = [...view.container.querySelectorAll("button")];
    await interact(() => view.container.querySelector<HTMLElement>(".sb-create summary")?.click());
    await interact(() =>
      buttons.find((button) => button.textContent?.trim() === "创建频道")?.click(),
    );
    expect(view.container.querySelector("details.sb-create")?.hasAttribute("open")).toBe(false);
    await interact(() => view.container.querySelector<HTMLElement>(".sb-account summary")?.click());
    await interact(() =>
      [...view.container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "设置")
        ?.click(),
    );
    const botRow = rows(view.container, "bot")[0];
    await interact(() => botRow?.click());
    expect(direct).toHaveBeenCalledWith("reviewer");
    expect(profile).not.toHaveBeenCalled();
    const editProfileFromMenu = async () => {
      const item = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((button) => button.textContent?.trim() === "编辑资料");
      expect(item).toBeDefined();
      await interact(() => item?.click());
    };
    await interact(() =>
      botRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    // Right-click opens the row menu; the profile is one explicit choice inside it.
    expect(profile).not.toHaveBeenCalled();
    await editProfileFromMenu();
    expect(profile).toHaveBeenCalledWith("reviewer");
    expect(view.container.querySelector('[role="menu"][aria-label$="的操作"]')).toBeNull();
    await interact(() =>
      botRow?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      ),
    );
    await editProfileFromMenu();
    expect(profile).toHaveBeenCalledTimes(2);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("shows only known channel member avatars and retains workspace destinations", async () => {
  const work = vi.fn();
  const skills = vi.fn();
  const view = await renderComponent(
    <Sidebar
      bots={bots}
      channels={[{ ...channels[0]!, botIds: ["reviewer", "missing"] }]}
      runs={[]}
      ownerName="Owner"
      onSelectChannel={vi.fn()}
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onCreateChannel={vi.fn()}
      onManageNodes={vi.fn()}
      onLogout={vi.fn()}
      onWork={work}
      onSkills={skills}
    />,
  );
  try {
    expect(view.container.querySelectorAll(".sb-avatar-pair .robot-avatar")).toHaveLength(1);
    const buttons = [...view.container.querySelectorAll("button")];
    // 任务监督 lives in the account menu; 插件 is the footer pill.
    await interact(() =>
      buttons.find((button) => button.textContent?.includes("任务监督"))?.click(),
    );
    await interact(() => buttons.find((button) => button.textContent?.includes("插件"))?.click());
    expect(work).toHaveBeenCalledOnce();
    expect(skills).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
  }
});

it("folds groups, brings hidden rows back when unread and mutes a channel", async () => {
  sidebarOrganization.moveToNewGroup("channel:design", "市场团队");
  sidebarOrganization.setHidden("channel:code", true);
  const props = {
    bots,
    channels,
    runs: [],
    ownerName: "Owner",
    onSelectChannel: vi.fn(),
    onSelectBot: vi.fn(),
    onCreateBot: vi.fn(),
    onCreateChannel: vi.fn(),
    onManageNodes: vi.fn(),
    onLogout: vi.fn(),
  };
  const view = await renderComponent(<Sidebar {...props} />);
  try {
    const heading = view.container.querySelector<HTMLButtonElement>(".sb-group-name");
    expect(heading?.textContent).toContain("市场团队");
    expect(view.container.textContent).toContain("未分组");
    expect(view.container.textContent).not.toContain("开发");
    await interact(() => heading?.click());
    expect(heading?.getAttribute("aria-expanded")).toBe("false");
    expect(rows(view.container, "channel")).toHaveLength(0);
    await interact(() => heading?.click());
    expect(rows(view.container, "channel")).toHaveLength(1);
  } finally {
    await view.unmount();
  }
  const revealed = await renderComponent(
    <Sidebar {...props} unreadCounts={{ "channel:code": 2 }} />,
  );
  try {
    const code = Array.from(rows(revealed.container, "channel")).find((row) =>
      row.textContent?.includes("开发"),
    );
    expect(code?.querySelector(".sb-unread")?.getAttribute("aria-label")).toBe("2 条未读");
    await interact(() =>
      code?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    const mute = Array.from(
      revealed.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "关闭通知");
    await interact(() => mute?.click());
    expect(sidebarOrganization.snapshot().muted).toContain("channel:code");
  } finally {
    await revealed.unmount();
  }
});

it("shows the latest message preview and time, with a running task taking precedence", async () => {
  const now = new Date();
  const today = new Date(now);
  today.setHours(10, 24, 0, 0);
  const view = await renderComponent(
    <Sidebar
      bots={bots}
      channels={channels}
      runs={[]}
      ownerName="Owner"
      onSelectChannel={vi.fn()}
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onCreateChannel={vi.fn()}
      activity={{
        [`channel:${channels[0]?.id}`]: {
          lastActivityAt: today.toISOString(),
          latestMessage: {
            id: "m",
            authorType: "human",
            preview: "下周一再过一遍需求",
            createdAt: today.toISOString(),
          },
        },
      }}
    />,
  );
  try {
    const row = view.container.querySelector(`.sb-row[data-kind="channel"]`);
    expect(row?.querySelector(".sb-sub")?.textContent).toBe("你：下周一再过一遍需求");
    expect(row?.querySelector(".sb-time")?.textContent).toBe("10:24");
  } finally {
    await view.unmount();
  }
});

it("formats row times like the artboard", async () => {
  const { sidebarTime } = await import("./Sidebar");
  const now = new Date(2026, 8, 30, 12, 0);
  expect(sidebarTime(new Date(2026, 8, 30, 9, 5).toISOString(), now)).toBe("09:05");
  expect(sidebarTime(new Date(2026, 8, 29, 23, 0).toISOString(), now)).toBe("昨天");
  expect(sidebarTime(new Date(2026, 8, 27, 8, 0).toISOString(), now)).toBe("9/27");
});
