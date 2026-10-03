// @vitest-environment jsdom
import type { Bot } from "@openbot/domain";
import { expect, it, vi } from "vitest";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { NewBotSetupCard } from "./NewBotSetupCard";

const bot: Bot = {
  id: "bot-new",
  name: "新建 Bot",
  role: "通用助手",
  status: "idle",
  computerProfile: "model",
  createdAt: "2026-10-02T00:00:00Z",
};

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw Error(`${text} missing`);
  return button;
}

it("turns a choice into the role and first message, and reports a failed save", async () => {
  const choose = vi
    .fn<(choice: { role: string; description: string; message: string }) => Promise<void>>()
    .mockRejectedValueOnce(new Error("conflict"))
    .mockResolvedValue(undefined);
  const view = await renderComponent(
    <NewBotSetupCard bot={bot} onChoose={choose} onSkip={vi.fn()} />,
  );
  try {
    await interact(() => buttonByText(view.container, "数据与复盘").click());
    expect(choose).toHaveBeenLastCalledWith({
      role: "数据与复盘",
      description: "汇总各渠道表现，找出哪些内容有效",
      message: "我希望你负责「数据与复盘」：汇总各渠道表现，找出哪些内容有效。",
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "没能保存分工，请重试。",
    );
    const own = view.container.querySelector<HTMLInputElement>('input[aria-label="自己的回答"]');
    if (!own) throw Error("input missing");
    await setInputValue(own, "  整理会议纪要  ");
    await interact(() =>
      view.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(choose).toHaveBeenLastCalledWith({
      role: "整理会议纪要",
      description: "整理会议纪要",
      message: "我希望你负责：整理会议纪要",
    });
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("skips without saving anything", async () => {
  const choose = vi.fn(async () => undefined);
  const skip = vi.fn();
  const view = await renderComponent(<NewBotSetupCard bot={bot} onChoose={choose} onSkip={skip} />);
  try {
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>('button[aria-label="跳过"]')?.click(),
    );
    expect(skip).toHaveBeenCalledOnce();
    expect(choose).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});
