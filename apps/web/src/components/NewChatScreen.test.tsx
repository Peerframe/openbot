// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import { expect, it, vi } from "vitest";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { NewChatScreen } from "./NewChatScreen";

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  role: `${name} 职责`,
  status: "idle",
  computerProfile: "none",
  createdAt: "2026-09-05T00:00:00Z",
});
const bots = [bot("a", "研究助理"), bot("b", "客服小橙"), bot("c", "设计评审")];

function options(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".new-chat-option"));
}
function key(target: Element | null, init: KeyboardEventInit) {
  return interact(() =>
    target?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })),
  );
}
async function typeMessage(container: HTMLElement, value: string) {
  const textarea = container.querySelector("textarea");
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("picks Bots with the list, search and ⌘ shortcuts, and names the channel", async () => {
  const start = vi.fn(async () => undefined);
  const create = vi.fn();
  const view = await renderComponent(
    <NewChatScreen bots={bots} onCreateBot={create} onStart={start} />,
  );
  try {
    const search = view.container.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(options(view.container).map((option) => option.textContent)).toEqual([
      expect.stringContaining("创建新 Bot"),
      expect.stringContaining("创建频道"),
      expect.stringContaining("研究助理"),
      expect.stringContaining("客服小橙"),
      expect.stringContaining("设计评审"),
    ]);
    await key(search, { key: "1", metaKey: true });
    expect(create).toHaveBeenCalledOnce();
    await key(search, { key: "4", metaKey: true });
    expect(view.container.querySelector(".new-chat-chip")?.textContent).toContain("客服小橙");
    // While searching, Enter chooses the first matching Bot, not 「创建新 Bot」.
    if (!search) throw Error("search missing");
    await setInputValue(search, "研究");
    expect(view.container.querySelector(".new-chat-option mark")?.textContent).toBe("研究");
    await key(search, { key: "Enter" });
    expect(view.container.querySelectorAll(".new-chat-chip")).toHaveLength(2);
    expect(create).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain("选了 2 个 Bot，发出第一条消息后建成频道");
    await interact(() =>
      Array.from(view.container.querySelectorAll("button"))
        .find((button) => button.textContent === "命名频道")
        ?.click(),
    );
    const name = view.container.querySelector<HTMLInputElement>(".new-chat-name input");
    if (!name) throw Error("name input missing");
    await setInputValue(name, "市场周报");
    await typeMessage(view.container, "开始吧");
    await interact(() =>
      view.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(start).toHaveBeenCalledWith({
      botIds: ["b", "a"],
      asChannel: true,
      channelName: "市场周报",
      text: "开始吧",
    });
  } finally {
    await view.unmount();
  }
});

it("removes the last chip with Backspace, sends one Bot without a channel name and shows errors", async () => {
  const start = vi.fn(async () => {
    throw new Error("name_already_exists");
  });
  const view = await renderComponent(
    <NewChatScreen bots={bots} onCreateBot={vi.fn()} onStart={start} />,
  );
  try {
    const search = view.container.querySelector<HTMLInputElement>('input[role="combobox"]');
    // Before anything is chosen the two actions lead the list; afterwards only Bots remain.
    await interact(() => options(view.container)[2]?.click());
    await interact(() => options(view.container)[0]?.click());
    expect(view.container.querySelectorAll(".new-chat-chip")).toHaveLength(2);
    await key(search, { key: "Backspace" });
    expect(view.container.querySelectorAll(".new-chat-chip")).toHaveLength(1);
    expect(view.container.textContent).toContain("发出第一条消息后会打开和 研究助理 的单聊");
    const send = view.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(send?.disabled).toBe(true);
    await typeMessage(view.container, "你好");
    expect(send?.disabled).toBe(false);
    await interact(() => send?.click());
    expect(start).toHaveBeenCalledWith({
      botIds: ["a"],
      asChannel: false,
      channelName: undefined,
      text: "你好",
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "已有同名的频道，请换一个名字。",
    );
  } finally {
    await view.unmount();
  }
});

it("stops at the Server's six-recipient limit", async () => {
  const many = Array.from({ length: 7 }, (_, index) => bot(`b${index}`, `Bot ${index}`));
  const view = await renderComponent(
    <NewChatScreen bots={many} onCreateBot={vi.fn()} onStart={vi.fn()} />,
  );
  try {
    for (let index = 0; index < 7; index += 1)
      await interact(() => options(view.container)[index === 0 ? 2 : 0]?.click());
    expect(view.container.querySelectorAll(".new-chat-chip")).toHaveLength(6);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("最多选择 6 个");
  } finally {
    await view.unmount();
  }
});

it("makes one Bot a 频道 after 创建频道", async () => {
  const start = vi.fn(async () => undefined);
  const view = await renderComponent(
    <NewChatScreen bots={bots} onCreateBot={vi.fn()} onStart={start} />,
  );
  try {
    const search = view.container.querySelector<HTMLInputElement>('input[role="combobox"]');
    await key(search, { key: "2", metaKey: true });
    expect(options(view.container).map((option) => option.textContent)).toEqual([
      expect.stringContaining("研究助理"),
      expect.stringContaining("客服小橙"),
      expect.stringContaining("设计评审"),
    ]);
    await key(search, { key: "1", metaKey: true });
    expect(view.container.textContent).toContain("选了 1 个 Bot，发出第一条消息后建成频道");
    await typeMessage(view.container, "开始吧");
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
    );
    expect(start).toHaveBeenCalledWith({
      botIds: ["a"],
      asChannel: true,
      channelName: undefined,
      text: "开始吧",
    });
  } finally {
    await view.unmount();
  }
});

it("shows the shortcut on the highlighted row only and closes on an outside press", async () => {
  const view = await renderComponent(
    <NewChatScreen bots={bots} onCreateBot={vi.fn()} onStart={vi.fn()} />,
  );
  try {
    const search = view.container.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(view.container.querySelectorAll(".new-chat-keys")).toHaveLength(1);
    expect(options(view.container)[0]?.querySelector(".new-chat-keys")?.textContent).toBe("⌘1");
    await key(search, { key: "ArrowDown" });
    expect(options(view.container)[1]?.querySelector(".new-chat-keys")?.textContent).toBe("⌘2");
    // Every row keeps its shortcut for assistive technology.
    expect(options(view.container)[4]?.getAttribute("aria-keyshortcuts")).toBe("Meta+5 Control+5");

    // A press inside the list keeps it open; one elsewhere closes it; clicking the field reopens it.
    await interact(() =>
      view.container
        .querySelector(".new-chat-options")
        ?.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(view.container.querySelector(".new-chat-options")).not.toBeNull();
    await interact(() =>
      view.container
        .querySelector(".new-chat-space")
        ?.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(view.container.querySelector(".new-chat-options")).toBeNull();
    expect(search?.getAttribute("aria-expanded")).toBe("false");
    await interact(() => search?.click());
    expect(view.container.querySelector(".new-chat-options")).not.toBeNull();
  } finally {
    await view.unmount();
  }
});

it("lists the crowned 主 Bot first among the recipients", async () => {
  const view = await renderComponent(
    <NewChatScreen bots={bots} primaryBotId="c" onCreateBot={vi.fn()} onStart={vi.fn()} />,
  );
  try {
    const names = options(view.container)
      .slice(2)
      .map((option) => option.querySelector(".new-chat-bot-name")?.textContent);
    expect(names).toEqual(["设计评审", "研究助理", "客服小橙"]);
    expect(options(view.container)[2]?.querySelector(".robot-avatar.is-crowned")).not.toBeNull();
    expect(view.container.querySelectorAll(".robot-avatar.is-crowned")).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});
