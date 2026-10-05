import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { colorSchemeBackground, DesktopColorSchemeController } from "./color-scheme.js";
import {
  DesktopPlatformController,
  DEFAULT_PLATFORM_PREFERENCES as defaults,
  FilePlatformPreferenceStore,
  type PlatformPreferenceStore,
} from "./platform-preferences.js";
import type { DesktopColorScheme } from "./runtime-contract.js";

class Theme extends EventEmitter {
  source: DesktopColorScheme = "light";
  dark = true;
  get themeSource() {
    return this.source;
  }
  set themeSource(value: DesktopColorScheme) {
    this.source = value;
    this.emit("updated");
  }
  get shouldUseDarkColors() {
    return this.source === "system" ? this.dark : this.source === "dark";
  }
}
function fixture(
  store: PlatformPreferenceStore = { load: async () => undefined, save: async () => {} },
) {
  const theme = new Theme(),
    changed = vi.fn();
  let color: DesktopColorSchemeController;
  const platform = new DesktopPlatformController(store, {
    capabilities: { launchAtLogin: false, tray: true, badge: true, updates: false },
    currentLaunchAtLogin: () => false,
    setLaunchAtLogin: vi.fn(),
    setTray: vi.fn(),
    registerShortcut: () => true,
    unregisterShortcut: vi.fn(),
    setBadge: () => true,
    changed: () => color.apply(),
  });
  color = new DesktopColorSchemeController(theme, platform, changed);
  return { theme, changed, color, platform };
}

describe("Desktop color scheme", () => {
  it("defaults to system before a window is constructed and publishes system changes", async () => {
    const f = fixture();
    await f.platform.initialize();
    f.color.apply();
    expect(f.color.state()).toEqual({ scheme: "system", resolved: "dark" });
    expect(colorSchemeBackground(f.color.state())).toBe("#141414");
    f.theme.dark = false;
    f.theme.emit("updated");
    expect(f.changed).toHaveBeenLastCalledWith({ scheme: "system", resolved: "light" });
    expect(colorSchemeBackground(f.color.state())).toBe("#ffffff");
    f.theme.emit("updated");
    expect(f.changed).toHaveBeenCalledTimes(2);
    f.color.close();
    expect(f.theme.listenerCount("updated")).toBe(0);
  });
  it("persists a choice and loads it before the next window's first paint", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-theme-"));
    try {
      const store = new FilePlatformPreferenceStore(join(root, "preferences.json"));
      const f = fixture(store);
      await f.platform.initialize();
      f.color.apply();
      await expect(f.color.set("dark")).resolves.toEqual({ scheme: "dark", resolved: "dark" });
      expect((await store.load())?.colorScheme).toBe("dark");
      const next = fixture(store);
      await next.platform.initialize();
      next.color.apply();
      expect(next.theme.themeSource).toBe("dark");
      expect(colorSchemeBackground(next.color.state())).toBe("#141414");
      next.color.close();
      f.color.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reads the legacy five-field file as system, and old settings updates preserve a saved choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-legacy-theme-"));
    try {
      const path = join(root, "preferences.json"),
        { colorScheme: _color, ...old } = defaults;
      await writeFile(
        path,
        JSON.stringify({ format: "openbot.desktop-platform/v1", preferences: old }),
        { mode: 0o600 },
      );
      const store = new FilePlatformPreferenceStore(path),
        f = fixture(store);
      await f.platform.initialize();
      f.color.apply();
      expect(f.color.state().scheme).toBe("system");
      await f.color.set("dark");
      await f.platform.update({ ...old, showDockBadge: false });
      expect((await store.load())?.colorScheme).toBe("dark");
      expect(f.color.state()).toEqual({ scheme: "dark", resolved: "dark" });
      f.color.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses invalid values or failed persistence without changing the native theme", async () => {
    const save = vi.fn(async () => {}),
      f = fixture({ load: async () => undefined, save });
    await f.platform.initialize();
    f.color.apply();
    for (const value of [undefined, null, 0, {}, [], "auto", "DARK", "dark\n", { scheme: "dark" }])
      await expect(f.color.set(value)).rejects.toThrow("Invalid");
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.color.set("dark")).rejects.toThrow("saved");
    expect(f.theme.themeSource).toBe("system");
    expect(f.color.state()).toEqual({ scheme: "system", resolved: "dark" });
    f.color.close();
  });
  it("pushes preference changes even when resolution stays the same, and ignores system changes for a fixed choice", async () => {
    const f = fixture();
    await f.platform.initialize();
    f.color.apply();
    await f.color.set("dark");
    expect(f.changed.mock.calls.map(([state]) => state)).toEqual([
      { scheme: "system", resolved: "dark" },
      { scheme: "dark", resolved: "dark" },
    ]);
    f.theme.dark = false;
    f.theme.emit("updated");
    expect(f.changed).toHaveBeenCalledTimes(2);
    await f.color.set("system");
    expect(f.color.state()).toEqual({ scheme: "system", resolved: "light" });
    f.color.close();
  });
});
