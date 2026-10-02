// @vitest-environment jsdom
import type { Message } from "@openbot/domain";
import { describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { MessageActionBar } from "./MessageActionBar";

const message: Message = {
  id: "message",
  channelId: "channel",
  authorType: "bot",
  authorId: "bot",
  content: "Copy this exact text",
  createdAt: "2026-09-10T08:00:00Z",
};
function element<T extends Element>(selector: string): T {
  const value = document.querySelector(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value as T;
}
describe("side-of-bubble action bar", () => {
  it("exposes only three labeled icons and keeps copy inside a body portal", async () => {
    const reply = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = await renderComponent(
      <MessageActionBar
        message={message}
        onReply={reply}
        reactions={[]}
        onReactionChange={vi.fn()}
      />,
    );
    expect(view.container.querySelectorAll("button")).toHaveLength(3);
    expect(view.container.textContent).not.toContain("复制");
    await interact(() => element<HTMLButtonElement>('[aria-label="回复"]').click());
    expect(reply).toHaveBeenCalledOnce();
    const more = element<HTMLButtonElement>('[aria-label="更多操作"]');
    await interact(() => more.click());
    const menu = element<HTMLDivElement>('[role="menu"]');
    expect(menu.parentElement).toBe(document.body);
    expect(view.container.contains(menu)).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector("button"));
    await interact(() => element<HTMLButtonElement>('[role="menuitem"]').click());
    expect(writeText).toHaveBeenCalledWith(message.content);
    expect(menu.textContent).toContain("已复制");
    await interact(() =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    await view.unmount();
  });
  it("supports keyboard emoji selection and publishes the real Owner intent", async () => {
    const change = vi.fn(async () => {});
    const view = await renderComponent(
      <MessageActionBar
        message={message}
        onReply={vi.fn()}
        reactions={[{ messageId: message.id, emoji: "👍", actor: "owner" }]}
        onReactionChange={change}
      />,
    );
    const trigger = element<HTMLButtonElement>('[aria-label="添加回应"]');
    await interact(() => trigger.click());
    const menu = element<HTMLDivElement>('[role="menu"]');
    expect(element('[aria-label="赞同"]').getAttribute("aria-checked")).toBe("true");
    await interact(() =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("喜欢");
    await interact(() => element<HTMLButtonElement>('[aria-label="喜欢"]').click());
    expect(change).toHaveBeenCalledWith("❤️", true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await view.unmount();
  });
  it("keeps failed writes visible and closes outside without stealing focus", async () => {
    const view = await renderComponent(
      <MessageActionBar
        message={{ ...message, authorType: "human" }}
        onReply={vi.fn()}
        reactions={[]}
        onReactionChange={vi.fn(async () => {
          throw new Error("Write failed");
        })}
      />,
    );
    expect(view.container.querySelector(".for-human")).not.toBeNull();
    await interact(() => element<HTMLButtonElement>('[aria-label="添加回应"]').click());
    await interact(() => element<HTMLButtonElement>('[aria-label="赞同"]').click());
    expect(element('[role="alert"]').textContent).toBe("Write failed");
    await interact(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await view.unmount();
  });
  it("clamps a popup to the viewport and places it above a low trigger", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("message-action-popover"))
        return {
          width: 220,
          height: 70,
          left: 0,
          right: 220,
          top: 0,
          bottom: 70,
          x: 0,
          y: 0,
          toJSON() {
            return {};
          },
        };
      if (this.getAttribute("aria-label") === "添加回应")
        return {
          width: 26,
          height: 28,
          left: window.innerWidth - 28,
          right: window.innerWidth - 2,
          top: window.innerHeight - 30,
          bottom: window.innerHeight - 2,
          x: 0,
          y: 0,
          toJSON() {
            return {};
          },
        };
      return original.call(this);
    });
    const view = await renderComponent(
      <MessageActionBar
        message={message}
        onReply={vi.fn()}
        reactions={[]}
        onReactionChange={vi.fn()}
      />,
    );
    await interact(() => element<HTMLButtonElement>('[aria-label="添加回应"]').click());
    const popup = element<HTMLDivElement>('[role="menu"]');
    expect(Number.parseFloat(popup.style.left) + 220).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(Number.parseFloat(popup.style.top) + 70).toBeLessThan(window.innerHeight - 30);
    await view.unmount();
    vi.restoreAllMocks();
  });
  it("names the task behind a reply in 更多 and shows no timestamp", async () => {
    const view = await renderComponent(
      <MessageActionBar
        message={message}
        onReply={vi.fn()}
        onInspectRun={vi.fn()}
        run={{ id: "run", title: "整理本周周报", status: "completed" } as never}
        reactions={[]}
        onReactionChange={vi.fn()}
      />,
    );
    await interact(() => element<HTMLButtonElement>('[aria-label="更多操作"]').click());
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent,
    );
    expect(items).toEqual(["复制文字", "任务详情这条回复来自「整理本周周报」"]);
    expect(document.querySelector('[role="menu"] time')).toBeNull();
    await view.unmount();
  });
});
