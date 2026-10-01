import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopPlatformController,
  DEFAULT_PLATFORM_PREFERENCES as defaults,
  FilePlatformPreferenceStore,
  type PlatformPreferencePorts,
  parsePlatformPreferences,
} from "./platform-preferences.js";

function fixture() {
  const active = new Set<string>();
  const ports: PlatformPreferencePorts = {
    capabilities: { launchAtLogin: true, tray: true, badge: true, updates: true },
    currentLaunchAtLogin: () => false,
    setLaunchAtLogin: vi.fn(),
    setTray: vi.fn(),
    setBadge: vi.fn(() => true),
    changed: vi.fn(),
    registerShortcut: vi.fn((value) => {
      if (active.has(value)) return false;
      active.add(value);
      return true;
    }),
    unregisterShortcut: vi.fn((value) => {
      active.delete(value);
    }),
  };
  const store = { load: vi.fn(async () => undefined), save: vi.fn(async () => {}) };
  return { ports, store, active, controller: new DesktopPlatformController(store, ports) };
}
describe("Desktop platform preferences", () => {
  it("rejects unknown fields and unsafe accelerators before any native effects", async () => {
    const f = fixture();
    for (const value of [
      null,
      { ...defaults, url: "https://untrusted" },
      { ...defaults, launchAtLogin: 1 },
      { ...defaults, globalShortcut: "A" },
      { ...defaults, globalShortcut: "CommandOrControl+CommandOrControl+A" },
      { ...defaults, globalShortcut: "Control+;rm" },
    ]) {
      expect(() => parsePlatformPreferences(value)).toThrow();
      expect((await f.controller.update(value)).status).toBe("invalid");
    }
    expect(f.ports.setTray).not.toHaveBeenCalled();
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it("retains old shortcut on conflict and rolls back all native effects on persistence failure", async () => {
    const f = fixture();
    const previous = { ...defaults, globalShortcut: "Control+O" };
    expect((await f.controller.update(previous)).status).toBe("ready");
    f.active.add("Control+P");
    expect((await f.controller.update({ ...previous, globalShortcut: "Control+P" })).code).toBe(
      "shortcut_unavailable",
    );
    f.store.save.mockRejectedValueOnce(new Error("disk unavailable"));
    expect(
      (
        await f.controller.update({
          ...previous,
          globalShortcut: "Control+Q",
          launchAtLogin: true,
          runInBackground: true,
          showDockBadge: false,
        })
      ).code,
    ).toBe("storage_unavailable");
    expect(f.controller.state().preferences).toEqual(previous);
    expect([...f.active]).toEqual(["Control+O", "Control+P"]);
    expect(f.ports.setLaunchAtLogin).toHaveBeenLastCalledWith(false);
    expect(f.ports.setTray).toHaveBeenLastCalledWith(false);
    f.controller.close();
    expect([...f.active]).toEqual(["Control+P"]);
  });
  it("caps badges and rejects unsupported native effects", async () => {
    const f = fixture();
    expect(f.controller.badge(1000)).toBe(true);
    expect(f.ports.setBadge).toHaveBeenLastCalledWith(99);
    for (const value of [-1, 1.5, 100000, "1"]) expect(f.controller.badge(value)).toBe(false);
    await f.controller.update({ ...defaults, showDockBadge: false });
    expect(f.ports.setBadge).toHaveBeenLastCalledWith(0);
    f.ports.capabilities.updates = false;
    expect((await f.controller.update({ ...defaults, automaticUpdates: true })).code).toBe(
      "unsupported",
    );
  });
  it("persists in a real private file and refuses corruption or symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-platform-"));
    try {
      const path = join(root, "preferences.json");
      const store = new FilePlatformPreferenceStore(path);
      expect(await store.load()).toBeUndefined();
      await store.save({ ...defaults, globalShortcut: "Control+O" });
      expect((await store.load())?.globalShortcut).toBe("Control+O");
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).not.toContain("password");
      await writeFile(path, "{}", { mode: 0o600 });
      const f = fixture();
      const c = new DesktopPlatformController(store, f.ports);
      expect((await c.initialize()).status).toBe("invalid");
      expect((await c.update(defaults)).status).toBe("invalid");
      expect(await readFile(path, "utf8")).toBe("{}");
      const link = join(root, "link.json");
      await symlink(path, link);
      await expect(new FilePlatformPreferenceStore(link).save(defaults)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
