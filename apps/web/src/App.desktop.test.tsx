// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { OpenBotDesktopBridge } from "./desktop-runtime";
import { interact, renderComponent, setInputValue } from "./test/render-component";

afterEach(() => {
  delete window.openbotDesktop;
  vi.unstubAllGlobals();
});

describe("App logout ownership", () => {
  it.each(["", "#/tasks"])(
    "keeps the session on failure and exits after success from %s",
    async (hash) => {
      const previousHash = window.location.hash;
      window.location.hash = hash;
      let rejectLogout = true;
      const fetcher = vi.fn(async (url: string) => {
        if (url === "/api/v1/auth/session")
          return Response.json({
            authenticated: true,
            expiresAt: "2999-01-01T00:00:00Z",
            owner: { id: "owner", name: "Owner" },
          });
        if (url === "/api/v1/auth/logout")
          return new Response(null, { status: rejectLogout ? 503 : 204 });
        if (url === "/api/v1/workspace")
          return Response.json({
            channels: [],
            bots: [],
            nodes: [],
            runs: [],
            approvals: [],
            artifacts: [],
            progress: [],
            counts: { channels: 0, bots: 0, connectedNodes: 0, activeRuns: 0 },
          });
        if (url === "/api/v1/bots") return Response.json({ bots: [] });
        if (url.startsWith("/api/v1/work/tasks")) return Response.json({ tasks: [] });
        throw new Error(`Unexpected fixture request: ${url}`);
      });
      vi.stubGlobal("fetch", fetcher);
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      vi.stubGlobal(
        "EventSource",
        class extends EventTarget {
          close() {}
        },
      );
      const rendered = await renderComponent(<App />);
      try {
        await settleEffects();
        const menu = rendered.container.querySelector(".owner-menu summary");
        if (menu instanceof HTMLElement) await interact(() => menu.click());
        const button = Array.from(rendered.container.querySelectorAll("button")).find(
          (item) => item.textContent === "退出登录",
        );
        if (!button) throw new Error("Logout control is missing.");
        await interact(() => button.click());
        await settleEffects();
        expect(rendered.container.textContent).toContain("退出失败，请重试");
        expect(rendered.container.querySelector("#owner-password")).toBeNull();
        rejectLogout = false;
        await interact(() => button.click());
        await settleEffects();
        expect(rendered.container.querySelector("#owner-password")).toBeInstanceOf(
          HTMLInputElement,
        );
        expect(fetcher.mock.calls.filter(([url]) => url === "/api/v1/auth/logout")).toHaveLength(2);
      } finally {
        await rendered.unmount();
        window.location.hash = previousHash;
      }
    },
  );
});

describe("Desktop application connection gate", () => {
  it("does not call the Server until first-run setup has completed", async () => {
    const fetcher = vi.fn(async () => Response.json({ authenticated: false }));
    vi.stubGlobal("fetch", fetcher);
    const bridge: OpenBotDesktopBridge = {
      getConnectionState: vi.fn(async () => ({ status: "unconfigured" })),
      configureServer: vi.fn(async () => ({
        status: "configured",
        serverUrl: "https://openbot.example",
      })),
      getSetupPlanState: vi.fn(async () => ({ status: "unconfigured" })),
      saveSetupPlan: vi.fn(async (plan) => ({ status: "configured", plan })),
      getLocalWorkerState: vi.fn(async () => ({ status: "not-selected" })),
      setupLocalWorker: vi.fn(),
      enableLocalWorker: vi.fn(),
      openLocalWorkerSettings: vi.fn(),
    };
    window.openbotDesktop = bridge;
    const rendered = await renderComponent(<App />);

    try {
      await settleEffects();
      expect(rendered.container.textContent).toContain("欢迎使用 OpenBot");
      expect(fetcher).not.toHaveBeenCalled();
      const mode = rendered.container.querySelector("#desktop-mode-client");
      const setupForm = rendered.container.querySelector("form");
      if (!(mode instanceof HTMLInputElement) || setupForm === null) {
        throw new Error("Desktop setup form not found.");
      }
      await interact(() => mode.click());
      await interact(() =>
        setupForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settleEffects();
      expect(bridge.saveSetupPlan).toHaveBeenCalledWith({
        mode: "client",
        plannedWorkerCount: 0,
        localWorker: false,
      });
      expect(rendered.container.textContent).toContain("连接服务电脑");
      expect(fetcher).not.toHaveBeenCalled();

      const input = rendered.container.querySelector("#desktop-server-url");
      const form = rendered.container.querySelector("form");
      if (!(input instanceof HTMLInputElement) || form === null) {
        throw new Error("Desktop connection form not found.");
      }
      await setInputValue(input, "https://openbot.example");
      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settleEffects();

      expect(bridge.configureServer).toHaveBeenCalledWith("https://openbot.example");
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/auth/session",
        expect.objectContaining({ credentials: "include" }),
      );
      expect(rendered.container.textContent).toContain("进入 OpenBot");
    } finally {
      await rendered.unmount();
    }
  });

  it("installs a service computer before authentication and then asks for a model", async () => {
    let complete: ((state: { status: "ready"; serverUrl: string }) => void) | undefined;
    const install = vi.fn(
      () =>
        new Promise<{ status: "ready"; serverUrl: string }>((resolve) => {
          complete = resolve;
        }),
    );
    const fetcher = vi.fn(async (url: string) =>
      url === "/api/v1/auth/session"
        ? Response.json({
            authenticated: true,
            expiresAt: "2999-01-01T00:00:00.000Z",
            owner: { id: "owner", name: "Owner" },
          })
        : url === "/api/v1/model-services"
          ? Response.json({ presets: [], connections: [], customBaseUrls: [] })
          : url === "/api/v1/settings/general"
            ? Response.json({
                revision: 1,
                timezone: "UTC",
                defaultModel: null,
                updatedAt: "2026-10-05T00:00:00Z",
              })
            : Response.json({ revision: 1, connectionId: null }),
    );
    vi.stubGlobal("fetch", fetcher);
    window.openbotDesktop = {
      getConnectionState: vi.fn(async () => ({ status: "unconfigured" })),
      configureServer: vi.fn(),
      getSetupPlanState: vi.fn(async () => ({ status: "unconfigured" })),
      saveSetupPlan: vi.fn(async (plan) => ({ status: "configured", plan })),
      getLocalWorkerState: vi.fn(async () => ({ status: "not-selected" })),
      setupLocalWorker: vi.fn(),
      enableLocalWorker: vi.fn(),
      openLocalWorkerSettings: vi.fn(),
      installNativeServer: install,
      getRuntimeInfo: () => ({
        kind: "desktop",
        platform: "darwin",
        arch: "arm64",
        shellVersion: "44.2.0",
      }),
      getNativeServerState: vi.fn(async () => ({ status: "installing", step: "database" })),
    };
    const rendered = await renderComponent(<App />);
    try {
      await settleEffects();
      await interact(() =>
        rendered.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settleEffects();
      expect(install).toHaveBeenCalledOnce();
      expect(fetcher).not.toHaveBeenCalled();
      expect(rendered.container.textContent).toContain("正在准备你的 OpenBot");
      await interact(() => complete?.({ status: "ready", serverUrl: "http://127.0.0.1:45678" }));
      await settleEffects();
      expect(rendered.container.textContent).toContain("给 Bot 选一个模型");
      expect(window.openbotDesktop.configureServer).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  it("recovers an expired local session instead of asking for the generated password", async () => {
    let authenticated = false;
    const restoreLocalSession = vi.fn(async () => {
      authenticated = true;
      return { status: "restored" as const };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/v1/auth/session"
          ? Response.json(
              authenticated
                ? {
                    authenticated: true,
                    expiresAt: "2999-01-01T00:00:00Z",
                    owner: { id: "owner", name: "Owner" },
                  }
                : { authenticated: false },
            )
          : url === "/api/v1/model-services"
            ? Response.json({ presets: [], connections: [], customBaseUrls: [] })
            : url === "/api/v1/settings/general"
              ? Response.json({
                  revision: 1,
                  timezone: "UTC",
                  defaultModel: null,
                  updatedAt: "2026-10-05T00:00:00Z",
                })
              : Response.json({ revision: 1, connectionId: null }),
      ),
    );
    window.openbotDesktop = {
      getRuntimeInfo: () => ({
        kind: "desktop",
        platform: "darwin",
        arch: "arm64",
        shellVersion: "44.3.0",
      }),
      getConnectionState: vi.fn(async () => ({
        status: "configured",
        serverUrl: "http://127.0.0.1:45678",
      })),
      configureServer: vi.fn(),
      getSetupPlanState: vi.fn(async () => ({
        status: "configured",
        plan: { mode: "host", localWorker: false, plannedWorkerCount: 0 },
      })),
      saveSetupPlan: vi.fn(),
      getLocalWorkerState: vi.fn(async () => ({ status: "not-selected" })),
      setupLocalWorker: vi.fn(),
      enableLocalWorker: vi.fn(),
      openLocalWorkerSettings: vi.fn(),
      installNativeServer: vi.fn(async () => ({
        status: "ready",
        serverUrl: "http://127.0.0.1:45678",
      })),
      getNativeServerState: vi.fn(async () => ({
        status: "ready",
        serverUrl: "http://127.0.0.1:45678",
      })),
      restoreLocalSession,
    };
    const rendered = await renderComponent(<App />);
    try {
      await settleEffects();
      expect(restoreLocalSession).toHaveBeenCalledOnce();
      expect(rendered.container.querySelector("#owner-password")).toBeNull();
      expect(rendered.container.textContent).toContain("给 Bot 选一个模型");
    } finally {
      await rendered.unmount();
    }
  });

  it("offers the configured Server again after a connection failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    window.openbotDesktop = {
      getConnectionState: vi.fn(async () => ({
        status: "configured",
        serverUrl: "https://openbot.example",
      })),
      configureServer: vi.fn(),
      getSetupPlanState: vi.fn(async () => ({
        status: "configured",
        plan: { mode: "client", plannedWorkerCount: 0, localWorker: false },
      })),
      saveSetupPlan: vi.fn(),
      getLocalWorkerState: vi.fn(async () => ({ status: "not-selected" })),
      setupLocalWorker: vi.fn(),
      enableLocalWorker: vi.fn(),
      openLocalWorkerSettings: vi.fn(),
    };
    const rendered = await renderComponent(<App />);

    try {
      await settleEffects();
      expect(rendered.container.textContent).toContain("启动需要处理");
      const changeButton = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent === "更换服务电脑",
      );
      if (changeButton === undefined) throw new Error("Change Server button not found.");
      await interact(() => changeButton.click());
      expect(rendered.container.textContent).toContain("连接服务电脑");
      const input = rendered.container.querySelector("#desktop-server-url");
      expect(input).toBeInstanceOf(HTMLInputElement);
      expect((input as HTMLInputElement).value).toBe("https://openbot.example");
      expect(rendered.container.textContent).toContain("返回");
    } finally {
      await rendered.unmount();
    }
  });

  it("guides an authenticated local Worker without exposing its enrollment token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          authenticated: true,
          expiresAt: "2999-01-01T00:00:00.000Z",
          owner: { id: "owner", name: "Owner" },
        }),
      ),
    );
    const setupLocalWorker = vi.fn(async () => ({
      status: "succeeded" as const,
      state: { status: "requires-approval" as const },
    }));
    const openLocalWorkerSettings = vi.fn(async () => ({
      status: "succeeded" as const,
      state: { status: "requires-approval" as const },
    }));
    window.openbotDesktop = {
      getConnectionState: vi.fn(async () => ({
        status: "configured",
        serverUrl: "https://openbot.example",
      })),
      configureServer: vi.fn(),
      getSetupPlanState: vi.fn(async () => ({
        status: "configured",
        plan: { mode: "client-worker", plannedWorkerCount: 5, localWorker: true },
      })),
      saveSetupPlan: vi.fn(),
      getLocalWorkerState: vi.fn(async () => ({ status: "not-configured" })),
      setupLocalWorker,
      enableLocalWorker: vi.fn(),
      openLocalWorkerSettings,
    };
    const rendered = await renderComponent(<App />);

    try {
      await settleEffects();
      await settleEffects();
      expect(rendered.container.textContent).toContain("让这台电脑也能干活");
      expect(rendered.container.textContent).not.toContain("obenr_");
      const input = rendered.container.querySelector("#desktop-worker-node-id");
      const form = rendered.container.querySelector("form");
      if (!(input instanceof HTMLInputElement) || form === null) {
        throw new Error("Local Worker setup form not found.");
      }
      await setInputValue(input, "mac-studio-1");
      await interact(() =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settleEffects();
      expect(setupLocalWorker).toHaveBeenCalledWith("mac-studio-1");
      expect(rendered.container.textContent).toContain("等待 macOS 批准");
      const settings = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent === "打开「登录项」设置",
      );
      if (settings === undefined) throw new Error("Login Items button not found.");
      await interact(() => settings.click());
      await settleEffects();
      expect(openLocalWorkerSettings).toHaveBeenCalledOnce();
    } finally {
      await rendered.unmount();
    }
  });
});

async function settleEffects(): Promise<void> {
  await interact(() => undefined);
  await interact(() => undefined);
}
