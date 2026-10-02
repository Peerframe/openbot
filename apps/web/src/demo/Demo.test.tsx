// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import { DemoAdapter } from "./adapter";
import { Demo } from "./Demo";
import { installDemoTransport } from "./install";

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent === name,
  );
  if (!match) throw new Error(`Missing ${name}`);
  return match;
}

describe("actual channel components in the static demo", () => {
  it("renders native incremental output, task links, reaction state and restart using the real API module", async () => {
    const adapter = new DemoAdapter(location.origin);
    const originalFetch = window.fetch;
    const originalEvents = window.EventSource;
    const originalLocal = Object.getOwnPropertyDescriptor(window, "localStorage");
    const originalSession = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    const clipboard = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboard },
    });
    installDemoTransport(adapter);
    const view = await renderComponent(<Demo adapter={adapter} />);
    try {
      expect(view.container.textContent).toContain("示例数据，不连接模型");
      expect(view.container.querySelector(".sidebar")).not.toBeNull();
      await interact(() => {
        for (let index = 0; index < 8; index++) adapter.advance();
      });
      expect(view.container.querySelector(".streaming-message")?.textContent).toContain("Nova");
      expect(view.container.querySelector(".delegation-notice")?.textContent).toContain("邀请协作");
      await interact(adapter.finish);
      const message = view.container.querySelector("#channel-message-demo-final");
      expect(message?.querySelector(".artifact-card")).not.toBeNull();
      const reaction = message?.querySelector<HTMLButtonElement>('[aria-label="添加回应"]');
      await interact(() => reaction?.click());
      await interact(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="赞同"]')?.click(),
      );
      expect(message?.querySelector('[aria-label="取消我的赞同回应"]')).not.toBeNull();
      await interact(() =>
        message?.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')?.click(),
      );
      await interact(() => button("复制文字").click());
      expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("已合并 Nova"));
      await interact(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      await interact(() => button("查看 Nova 的协作任务").click());
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("梳理功能清单");
      await interact(() => button("关闭任务详情").click());
      await act(async () => {
        button("↻ 重播").click();
        await Promise.resolve();
      });
      expect(view.container.querySelector("#channel-message-demo-final")).toBeNull();
    } finally {
      await view.unmount();
      adapter.dispose();
      window.fetch = originalFetch;
      window.EventSource = originalEvents;
      if (originalLocal) Object.defineProperty(window, "localStorage", originalLocal);
      if (originalSession) Object.defineProperty(window, "sessionStorage", originalSession);
    }
  });
});
