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

it.each([
  [
    "docker_unavailable",
    "本机服务需要 Docker。请先打开 Docker，OpenBot 会自动继续；已有的 Bot、对话和设置都不会丢。",
    "alert",
    true,
  ],
  ["temporal_unavailable", "正在等待 Docker 里的任务引擎启动…", "status", true],
  ["temporal_unavailable", "正在等待任务引擎启动…", "status", false],
] as const)(
  "presents %s and continues the original startup without duplicate ready callbacks",
  async (reason, message, role, localDocker) => {
    vi.useFakeTimers();
    const pending = deferred<NativeServerState>();
    const onReady = vi.fn();
    const bridge = {
      getNativeServerState: vi.fn(async () => ({
        status: "waiting",
        mode: "resume",
        reason,
        localDocker,
      })),
      installNativeServer: vi.fn(() => pending.promise),
    } as unknown as OpenBotDesktopBridge;
    const view = await renderComponent(
      <DesktopInstallScreen bridge={bridge} onReady={onReady} onBack={vi.fn()} />,
    );
    try {
      expect(view.container.querySelector(`[role="${role}"]`)?.textContent).toContain(message);
      expect(view.container.textContent).not.toContain("钥匙串");
      expect(view.container.textContent).not.toContain("安装包完整");
      if (!localDocker) expect(view.container.textContent).not.toContain("Docker");
      if (reason === "temporal_unavailable")
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
      await interact(() => view.container.querySelector("button")!.click());
      expect(bridge.installNativeServer).toHaveBeenCalledTimes(2);
      await interact(() => vi.advanceTimersByTimeAsync(700));
      expect(view.container.textContent).toContain(message);
      expect(onReady).not.toHaveBeenCalled();
      await interact(() =>
        pending.resolve({ status: "ready", serverUrl: "http://127.0.0.1:3000" }),
      );
      expect(onReady).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:3000");
    } finally {
      await view.unmount();
      vi.useRealTimers();
    }
  },
);
it("allows leaving a pending startup without opening its workspace after unmount", async () => {
  const pending = deferred<NativeServerState>();
  const onReady = vi.fn();
  const onBack = vi.fn();
  const bridge = {
    getNativeServerState: vi.fn(async () => ({
      status: "waiting",
      mode: "resume",
      reason: "docker_unavailable",
      localDocker: true,
    })),
    installNativeServer: vi.fn(() => pending.promise),
  } as unknown as OpenBotDesktopBridge;
  const view = await renderComponent(
    <DesktopInstallScreen bridge={bridge} onReady={onReady} onBack={onBack} />,
  );
  const back = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "更改连接方式",
  );
  expect(back).toBeDefined();
  await interact(() => back!.click());
  expect(onBack).toHaveBeenCalledOnce();
  expect(bridge.installNativeServer).toHaveBeenCalledOnce();
  await view.unmount();
  await interact(() => pending.resolve({ status: "ready", serverUrl: "http://127.0.0.1:3000" }));
  expect(onReady).not.toHaveBeenCalled();
});
it("keeps unknown failures generic without blaming the keychain or Docker", async () => {
  const bridge = {
    getNativeServerState: vi.fn(async () => ({ status: "idle", initialized: true })),
    installNativeServer: vi.fn(async () => ({ status: "failed", code: "installation_failed" })),
  } as unknown as OpenBotDesktopBridge;
  const view = await renderComponent(
    <DesktopInstallScreen bridge={bridge} onReady={vi.fn()} onBack={vi.fn()} />,
  );
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
    "没能启动本机服务。请确认安装包完整后重试；已有的 Bot、对话和设置都不会丢。",
  );
  expect(view.container.textContent).not.toContain("钥匙串");
  expect(view.container.textContent).not.toContain("Docker");
  await view.unmount();
});
