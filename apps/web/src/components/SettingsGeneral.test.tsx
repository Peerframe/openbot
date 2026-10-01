// @vitest-environment jsdom
import type { DesktopPlatformState } from "@openbot/domain";
import { afterEach, expect, it, vi } from "vitest";
import { interact, renderComponent } from "../test/render-component";
import {
  DesktopStartupSettings,
  DockBadgeSetting,
  OwnerPreferenceSettings,
} from "./SettingsGeneral";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { openbotDesktop?: unknown }).openbotDesktop;
});

it("saves the time zone with the expected revision", async () => {
  let revision = 3;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/settings/general") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body) revision += 1;
      return Response.json({
        revision,
        timezone: body?.timezone ?? "Asia/Shanghai",
        defaultModel: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    return Response.json({ presets: [], connections: [], customBaseUrls: [] });
  });
  vi.stubGlobal("fetch", fetch);
  const view = await renderComponent(<OwnerPreferenceSettings />);
  try {
    await interact(() => undefined);
    const zone = view.container.querySelector<HTMLSelectElement>('select[aria-label="时区"]');
    expect(zone?.value).toBe("Asia/Shanghai");
    await interact(() => {
      if (!zone) throw Error("time zone missing");
      zone.value = "Europe/Berlin";
      zone.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await interact(() => undefined);
    const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      expectedRevision: 3,
      timezone: "Europe/Berlin",
      defaultModel: null,
    });
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("已保存。");
  } finally {
    await view.unmount();
  }
});

it("shows only supported Desktop rows and sends the preference change", async () => {
  const state: DesktopPlatformState = {
    status: "ready",
    preferences: {
      launchAtLogin: false,
      runInBackground: false,
      globalShortcut: "",
      showDockBadge: true,
      automaticUpdates: false,
    },
    capabilities: { launchAtLogin: true, tray: false, badge: true, updates: false },
  };
  const setPlatformPreferences = vi.fn(async (value: DesktopPlatformState["preferences"]) => ({
    ...state,
    preferences: value,
  }));
  const unused = vi.fn();
  (window as { openbotDesktop?: unknown }).openbotDesktop = {
    // The bridge guard requires the Desktop setup methods; they are not used here.
    getConnectionState: unused,
    configureServer: unused,
    getSetupPlanState: unused,
    saveSetupPlan: unused,
    getLocalWorkerState: unused,
    setupLocalWorker: unused,
    enableLocalWorker: unused,
    openLocalWorkerSettings: unused,
    getPlatformState: async () => state,
    setPlatformPreferences,
  };
  const view = await renderComponent(
    <>
      <DesktopStartupSettings />
      <DockBadgeSetting />
    </>,
  );
  try {
    await interact(() => undefined);
    const labels = Array.from(view.container.querySelectorAll('[role="switch"]'), (item) =>
      item.getAttribute("aria-label"),
    );
    // No tray support: 后台运行 is not offered; the updater is never offered here.
    expect(labels).toEqual(["开机时启动 OpenBot", "全局快捷键", "程序坞角标"]);
    await interact(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="全局快捷键"]')?.click(),
    );
    expect(setPlatformPreferences).toHaveBeenCalledWith({
      ...state.preferences,
      globalShortcut: "CommandOrControl+Shift+O",
    });
  } finally {
    await view.unmount();
  }
});

it("renders nothing for Desktop rows in the Web entry", async () => {
  const view = await renderComponent(<DesktopStartupSettings />);
  try {
    await interact(() => undefined);
    expect(view.container.innerHTML).toBe("");
  } finally {
    await view.unmount();
  }
});
