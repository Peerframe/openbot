// @vitest-environment jsdom
import type { Bot, Channel } from "@openbot/domain";
import { expect, it, vi } from "vitest";
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
it("filters authorized channels and Bots, restores selection and keeps actions functional", async () => {
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
    const search = view.container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) throw Error("Search input missing");
    await setInputValue(search, "REVIEW");
    expect(view.container.querySelectorAll(".channel-list-row")).toHaveLength(1);
    expect(view.container.textContent).toContain("Reviewer");
    expect(view.container.textContent).not.toContain("Release checks");
    await setInputValue(search, "Review");
    expect(view.container.querySelectorAll(".bot-row")).toHaveLength(1);
    await interact(() =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(search.value).toBe("");
    expect(view.container.querySelectorAll(".channel-list-row")).toHaveLength(2);
    await setInputValue(search, "not present");
    expect(view.container.textContent).toContain("没有匹配的频道");
    expect(view.container.textContent).toContain("没有匹配的 Bot");
    await setInputValue(search, "");
    const selected = view.container.querySelector('[aria-current="page"]');
    if (!(selected instanceof HTMLButtonElement)) throw Error("Selected channel missing");
    await interact(() => selected.click());
    expect(select).toHaveBeenCalledWith("design");
    const buttons = [...view.container.querySelectorAll("button")];
    expect(view.container.querySelector(".brand")?.textContent?.trim()).toBe("OpenBot");
    expect(view.container.querySelector(".brand svg")).toBeNull();
    expect(view.container.textContent).not.toContain("新建对话");
    expect(view.container.querySelectorAll(".sidebar-heading button")).toHaveLength(0);
    await interact(() =>
      view.container.querySelector<HTMLElement>(".create-menu summary")?.click(),
    );
    await interact(() =>
      buttons.find((button) => button.textContent?.trim() === "创建频道")?.click(),
    );
    expect(view.container.querySelector("details.create-menu")?.hasAttribute("open")).toBe(false);
    await interact(() => view.container.querySelector<HTMLElement>(".owner-menu summary")?.click());
    await interact(() => buttons.find((button) => button.textContent?.trim() === "设置")?.click());
    const botRow = view.container.querySelector<HTMLButtonElement>(".bot-row");
    await interact(() => botRow?.click());
    expect(direct).toHaveBeenCalledWith("reviewer");
    expect(profile).not.toHaveBeenCalled();
    await interact(() =>
      botRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    expect(profile).toHaveBeenCalledWith("reviewer");
    await interact(() =>
      botRow?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      ),
    );
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
    expect(view.container.querySelectorAll(".channel-list-avatar .robot-avatar")).toHaveLength(1);
    const buttons = [...view.container.querySelectorAll("button")];
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
