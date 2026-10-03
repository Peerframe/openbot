import { EventEmitter } from "node:events";
import { DesktopColorSchemeController } from "./color-scheme.js";
import { describe, expect, it, vi } from "vitest";
import { DesktopUpdateController } from "./desktop-updates.js";
import type { DesktopIpcSender } from "./ipc-security.js";
import { DESKTOP_ENTRY_URL } from "./local-content.js";
import { registerPlatformIpc } from "./platform-ipc.js";
import { DEFAULT_PLATFORM_PREFERENCES, DesktopPlatformController } from "./platform-preferences.js";

describe("native platform IPC authority", () => {
  it("rejects forged senders, subframes, unfocused mutations and surplus parameters", async () => {
    const handlers = new Map<string, (event: DesktopIpcSender, ...values: unknown[]) => unknown>();
    const frame: { top?: unknown; url: string } = { url: DESKTOP_ENTRY_URL };
    frame.top = frame;
    const contents = { mainFrame: frame };
    const event = { sender: contents, senderFrame: frame };
    let focused = true;
    const save = vi.fn(async () => {});
    const platform = new DesktopPlatformController(
      { load: async () => undefined, save },
      {
        capabilities: { launchAtLogin: true, tray: true, badge: true, updates: false },
        currentLaunchAtLogin: () => false,
        setLaunchAtLogin: vi.fn(),
        setTray: vi.fn(),
        setBadge: () => true,
        registerShortcut: () => true,
        unregisterShortcut: vi.fn(),
        changed: vi.fn(),
      },
    );
    const theme = Object.assign(new EventEmitter(), {
      themeSource: "system" as const,
      shouldUseDarkColors: false,
    });
    const color = new DesktopColorSchemeController(theme, platform, vi.fn());
    registerPlatformIpc(
      {
        handle: (name, fn) => {
          handlers.set(name, fn);
        },
        removeHandler: vi.fn(),
      },
      platform,
      new DesktopUpdateController(
        undefined,
        "not_packaged",
        async () => false,
        async () => {},
      ),
      () => contents,
      () => focused,
      color,
    );
    const themeRead = handlers.get("openbot:get-color-scheme");
    const themeSet = handlers.get("openbot:set-color-scheme");
    const read = handlers.get("openbot:get-platform-state");
    const change = handlers.get("openbot:set-platform-preferences");
    expect(() => read?.({ sender: {}, senderFrame: frame })).toThrow();
    expect(() =>
      read?.({ ...event, senderFrame: { top: frame, url: DESKTOP_ENTRY_URL } }),
    ).toThrow();
    expect(() => read?.(event, "https://attacker.example")).toThrow();
    expect(themeRead?.(event)).toEqual({ scheme: "system", resolved: "light" });
    expect(() => themeRead?.({ sender: {}, senderFrame: frame })).toThrow();
    expect(() =>
      themeSet?.({ ...event, senderFrame: { top: frame, url: DESKTOP_ENTRY_URL } }, "dark"),
    ).toThrow();
    expect(() => themeSet?.(event, "dark", "surplus")).toThrow();
    await expect(themeSet?.(event, "auto")).rejects.toThrow("Invalid");
    focused = false;
    expect(() => change?.(event, DEFAULT_PLATFORM_PREFERENCES)).toThrow();
    expect(() => themeSet?.(event, "dark")).toThrow("focused");
    expect(save).not.toHaveBeenCalled();
    focused = true;
    await change?.(event, DEFAULT_PLATFORM_PREFERENCES);
    expect(save).toHaveBeenCalledTimes(1);
    color.close();
  });
});
