// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { NativeServerState, OpenBotDesktopBridge } from "../desktop-runtime";
import { deferred, interact, renderComponent } from "../test/render-component";
import { DesktopInstallScreen } from "./DesktopInstallScreen";

it("restores initialized workspaces without showing installation steps", async () => {
  const pending = deferred<NativeServerState>();
  const onReady = vi.fn();
  const bridge = {
    getNativeServerState: vi.fn(async () => ({ status: "idle", initialized: true })),
    installNativeServer: vi.fn(() => pending.promise),
  } as unknown as OpenBotDesktopBridge;
  const view = await renderComponent(
    <DesktopInstallScreen bridge={bridge} onReady={onReady} onBack={vi.fn()} />,
  );
  expect(view.container.textContent).toContain("正在打开你的工作区");
  expect(view.container.querySelector('[aria-label="准备进度"]')).toBeNull();
  expect(view.container.textContent).not.toContain("首次使用");
  await interact(() => pending.resolve({ status: "ready", serverUrl: "http://127.0.0.1:3000" }));
  expect(onReady).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:3000");
  await view.unmount();
});
it("explains credential denial without asking for a model key or reinstalling", async () => {
  const bridge = {
    getNativeServerState: vi.fn(async () => ({ status: "idle", initialized: true })),
    installNativeServer: vi.fn(async () => ({ status: "failed", code: "credential_unavailable" })),
  } as unknown as OpenBotDesktopBridge;
  const view = await renderComponent(
    <DesktopInstallScreen bridge={bridge} onReady={vi.fn()} onBack={vi.fn()} />,
  );
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    "无需重新输入模型密钥",
  );
  expect(view.container.querySelector("input")).toBeNull();
  expect(view.container.querySelector('[aria-label="准备进度"]')).toBeNull();
  expect(view.container.textContent).toContain("重试");
  await view.unmount();
});
it("opens a ready server without starting another initialization", async () => {
  const install = vi.fn();
  const onReady = vi.fn();
  const bridge = {
    getNativeServerState: vi.fn(async () => ({
      status: "ready",
      serverUrl: "http://127.0.0.1:3000",
    })),
    installNativeServer: install,
  } as unknown as OpenBotDesktopBridge;
  const view = await renderComponent(
    <DesktopInstallScreen bridge={bridge} onReady={onReady} onBack={vi.fn()} />,
  );
  expect(install).not.toHaveBeenCalled();
  expect(onReady).toHaveBeenCalledOnce();
  await view.unmount();
});
