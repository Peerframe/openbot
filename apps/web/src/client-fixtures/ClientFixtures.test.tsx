// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDemoTransport } from "../demo/install";
import { interact, renderComponent } from "../test/render-component";
import { ClientFixtureAdapter, type ClientScenario } from "./adapter";
import { ClientFixtures } from "./ClientFixtures";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
async function mount(scenario: ClientScenario) {
  const originalFetch = window.fetch;
  const originalEvents = window.EventSource;
  const originalLocal = Object.getOwnPropertyDescriptor(window, "localStorage");
  const originalSession = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  cleanup.push(() => {
    window.fetch = originalFetch;
    window.EventSource = originalEvents;
    if (originalLocal) Object.defineProperty(window, "localStorage", originalLocal);
    if (originalSession) Object.defineProperty(window, "sessionStorage", originalSession);
  });
  const adapter = new ClientFixtureAdapter(location.origin, scenario);
  cleanup.push(adapter.dispose);
  installDemoTransport(adapter);
  const view = await renderComponent(<ClientFixtures adapter={adapter} />);
  cleanup.push(view.unmount);
  return { adapter, view };
}
function button(text: string) {
  const element = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text || item.getAttribute("aria-label") === text,
  );
  if (!element) throw new Error(`Missing button ${text}`);
  return element;
}

describe("actual shared client fault flows", () => {
  it("uses the official approval card and removes it after an actual API decision", async () => {
    const { adapter, view } = await mount("approval");
    expect(view.container.querySelector(".approval-card")).not.toBeNull();
    await interact(() => button("提交这张表单").click());
    expect(view.container.querySelector(".approval-card")).toBeNull();
    expect(view.container.textContent).toContain("合成检查已完成");
    expect(adapter.getSnapshot().approvals[0]?.status).toBe("approved");
  });
  it("renders a tool fault in the official task inspector", async () => {
    const { view } = await mount("tool-fault");
    await interact(() => button("触发工具故障").click());
    await interact(() => button("任务详情").click());
    expect(view.container.querySelector(".run-inspector")?.textContent).toContain("工具未能完成");
    expect(view.container.querySelector(".run-progress-panel")?.textContent).toContain(
      "合成工具返回超时",
    );
  });
  it("cancels through the official controls and suppresses late output", async () => {
    const { adapter, view } = await mount("cancellation");
    expect(view.container.querySelector(".streaming-message")?.textContent).toContain(
      "已核对第一项",
    );
    await interact(() => button("停止任务").click());
    await interact(() => button("注入迟到输出").click());
    expect(adapter.getSnapshot().runs[0]?.status).toBe("cancelled");
    expect(view.container.textContent).not.toContain("不应显示的迟到输出");
    expect(view.container.textContent).toContain("Owner 已停止此任务");
  });
  it("merges partial, duplicate and older output then displays a final message", async () => {
    const { view } = await mount("partial-output");
    await interact(() => button("下一段（含重复和旧事件）").click());
    expect(view.container.querySelector(".streaming-message")?.textContent).toContain(
      "正在整理后续结果",
    );
    await interact(() => button("完成回复").click());
    expect(view.container.querySelector(".streaming-message")).toBeNull();
    expect(view.container.querySelector("#channel-message-fixture-final")?.textContent).toContain(
      "合成检查已完成",
    );
  });
  it("renders the official artifact card with a synthetic file link", async () => {
    const { view } = await mount("artifacts");
    expect(
      view.container.querySelector("#channel-message-fixture-final .artifact-card"),
    ).not.toBeNull();
    expect(
      view.container.querySelector('a[href="/api/v1/artifacts/demo-launch-report/content"]'),
    ).not.toBeNull();
  });
  it("uses the production reconnect timer and refetches missed messages automatically", async () => {
    vi.useFakeTimers();
    const { view } = await mount("reconnect");
    await interact(() => button("断开事件流").click());
    expect(view.container.querySelector(".realtime-state")?.textContent).toContain("正在重连");
    await interact(() => button("离线期间完成").click());
    expect(view.container.querySelector("#channel-message-fixture-final")).toBeNull();
    await interact(() => button("恢复连接").click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(view.container.querySelector("#channel-message-fixture-final")?.textContent).toContain(
      "合成检查已完成",
    );
    expect(view.container.querySelector(".realtime-state")?.textContent).toContain("实时连接");
  });
});
