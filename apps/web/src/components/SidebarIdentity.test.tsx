// @vitest-environment jsdom
import type { Bot, Channel } from "@openbot/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { Sidebar } from "./Sidebar";

const channels: Channel[] = [
  { id: "design", name: "Design", description: "", botIds: [], createdAt: "2026-09-05T00:00:00Z" },
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

beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});
afterEach(() => vi.restoreAllMocks());

async function renderSidebar(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return renderComponent(
    <Sidebar
      bots={bots}
      channels={channels}
      runs={[]}
      ownerName="Owner"
      onSelectChannel={vi.fn()}
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onCreateChannel={vi.fn()}
      onManageNodes={vi.fn()}
      onLogout={vi.fn()}
      onRenameItem={vi.fn()}
      onDeleteItem={vi.fn()}
      {...props}
    />,
  );
}

function menuItem(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.trim() === label,
  );
}

async function openMenu(container: HTMLElement, selector: string) {
  const row = container.querySelector<HTMLElement>(selector);
  await interact(() =>
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
}

it("renames through the Server and shows its conflict message in place", async () => {
  const rename = vi
    .fn()
    .mockRejectedValueOnce(new ApiError("name_already_exists", 409))
    .mockResolvedValueOnce(undefined);
  const view = await renderSidebar({ onRenameItem: rename });
  try {
    await openMenu(view.container, '.sb-row[data-kind="channel"]');
    await interact(() => menuItem(view.container, "重命名频道")?.click());
    const input = view.container.querySelector<HTMLInputElement>(".sidebar-context-form input");
    if (!input) throw Error("Rename input missing");
    expect(input.value).toBe("Design");
    expect(input.maxLength).toBe(80);
    await setInputValue(input, " Research ");
    const form = view.container.querySelector("form.sidebar-context-form");
    await interact(() =>
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(rename).toHaveBeenCalledWith("channel:design", "Research");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("同名");
    await interact(() =>
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(rename).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector(".sidebar-context-menu")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("confirms a permanent Bot delete that names the target and reports active work", async () => {
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new ApiError("active_work_blocks_delete", 409))
    .mockResolvedValueOnce(undefined);
  const view = await renderSidebar({ onDeleteItem: remove });
  try {
    await openMenu(view.container, '.sb-row[data-kind="bot"]');
    await interact(() => menuItem(view.container, "删除 Bot…")?.click());
    // Choosing the menu item never deletes; only the dialog's explicit action does.
    expect(remove).not.toHaveBeenCalled();
    const dialog = view.container.querySelector("dialog.delete-identity-dialog");
    expect(dialog?.textContent).toContain("永久删除这个 Bot？");
    expect(dialog?.querySelector(".ob-dialog-identity")?.textContent).toContain("Reviewer");
    expect(dialog?.textContent).toContain("无法撤销");
    const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "永久删除",
    );
    await interact(() => confirm?.click());
    expect(remove).toHaveBeenCalledWith({ kind: "bot", id: "reviewer", name: "Reviewer" });
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain("进行中的任务");
    await interact(() => confirm?.click());
    expect(view.container.querySelector("dialog.delete-identity-dialog")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("shows Server unread as the design's dot and marks read from the Bot menu", async () => {
  const markRead = vi.fn();
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
      onManageNodes={vi.fn()}
      onLogout={vi.fn()}
      unreadCounts={{ "bot:reviewer": 3 }}
      onMarkRead={markRead}
    />,
  );
  try {
    const row = view.container.querySelector('.sb-row[data-kind="bot"]');
    expect(row?.classList.contains("is-unread")).toBe(true);
    expect(row?.querySelector(".sb-unread")?.getAttribute("aria-label")).toBe("3 条未读");
    await openMenu(view.container, '.sb-row[data-kind="bot"]');
    await interact(() => menuItem(view.container, "标为已读")?.click());
    expect(markRead).toHaveBeenCalledWith("bot:reviewer");
  } finally {
    await view.unmount();
  }
});

it("omits identity actions when the host supplies no Server writes", async () => {
  const view = await renderSidebar({ onRenameItem: undefined, onDeleteItem: undefined });
  try {
    await openMenu(view.container, '.sb-row[data-kind="channel"]');
    expect(menuItem(view.container, "重命名频道")).toBeUndefined();
    expect(menuItem(view.container, "删除频道…")).toBeUndefined();
  } finally {
    await view.unmount();
  }
});
