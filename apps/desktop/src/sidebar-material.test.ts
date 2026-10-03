import { describe, expect, it, vi } from "vitest";
import { SidebarMaterialController } from "./sidebar-material.js";

function harness(platform = "darwin") {
  const flags = { reducedTransparency: false, highContrast: false };
  const window = {
    isDestroyed: vi.fn(() => false),
    setVibrancy: vi.fn(),
    setBackgroundColor: vi.fn(),
  };
  const changed = vi.fn();
  const accessibility = vi.fn(() => flags);
  const controller = new SidebarMaterialController({ platform, window, accessibility, changed });
  return { controller, flags, window, changed, accessibility };
}

describe("native sidebar material", () => {
  it("uses sidebar material and opaque fallback without custom window controls", () => {
    const { controller, window } = harness();
    expect(controller.setEnabled(true)).toEqual({ status: "enabled" });
    expect(window.setVibrancy).toHaveBeenLastCalledWith("sidebar");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    expect(controller.setEnabled(false)).toEqual({ status: "disabled" });
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
  });

  it.each([undefined, null, 0, 1, "true", "false", {}, [], { enabled: true }])(
    "rejects non-boolean presentation input without mutating the preference: %j",
    (value) => {
      const { controller, window } = harness();
      expect(controller.setEnabled(value)).toEqual({ status: "unavailable" });
      expect(window.setVibrancy).not.toHaveBeenCalled();
      expect(window.setBackgroundColor).not.toHaveBeenCalled();
      expect(controller.refresh()).toEqual({ status: "disabled" });
    },
  );

  it.each(["reducedTransparency", "highContrast"] as const)(
    "respects %s and restores the retained choice when the override ends",
    (flag) => {
      const { controller, flags, window, changed } = harness();
      controller.setEnabled(true);
      flags[flag] = true;
      expect(controller.refresh()).toEqual({ status: "reduced" });
      expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
      flags[flag] = false;
      expect(controller.refresh()).toEqual({ status: "enabled" });
      expect(changed.mock.calls.map(([state]) => state.status)).toEqual([
        "enabled",
        "reduced",
        "enabled",
      ]);
    },
  );

  it("does not reapply or broadcast an unchanged effective material on focus", () => {
    const { controller, changed, window } = harness();
    controller.setEnabled(true);
    controller.refresh();
    controller.setEnabled(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(window.setVibrancy).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "win32"])("stays opaque on %s without invoking macOS APIs", (platform) => {
    const { controller, window, accessibility } = harness(platform);
    expect(controller.setEnabled(true)).toEqual({ status: "unsupported" });
    expect(accessibility).not.toHaveBeenCalled();
    expect(window.setVibrancy).not.toHaveBeenCalled();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
  });

  it("does not use a destroyed window", () => {
    const { controller, window } = harness();
    window.isDestroyed.mockReturnValue(true);
    expect(controller.setEnabled(true)).toEqual({ status: "unavailable" });
    expect(window.setVibrancy).not.toHaveBeenCalled();
  });

  it("falls back to a solid background when the platform update fails", () => {
    const { controller, window } = harness();
    window.setVibrancy.mockImplementationOnce(() => {
      throw new Error("native window unavailable");
    });
    expect(controller.setEnabled(true)).toEqual({ status: "unavailable" });
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(controller.refresh()).toEqual({ status: "enabled" });
  });
});

describe("sidebar dark fallback", () => {
  it.each(["reducedTransparency", "highContrast"] as const)(
    "uses the current solid palette for %s and retains vibrancy",
    (flag) => {
      const f = harness();
      let background = "#141414";
      const controller = new SidebarMaterialController({
        platform: "darwin",
        window: f.window,
        accessibility: () => f.flags,
        changed: f.changed,
        backgroundColor: () => background,
      });
      expect(controller.setEnabled(true).status).toBe("enabled");
      expect(f.window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
      f.flags[flag] = true;
      expect(controller.refresh().status).toBe("reduced");
      expect(f.window.setBackgroundColor).toHaveBeenLastCalledWith("#141414");
      background = "#ffffff";
      expect(controller.refresh().status).toBe("reduced");
      expect(f.window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
      f.flags[flag] = false;
      controller.refresh();
      expect(f.window.setVibrancy).toHaveBeenLastCalledWith("sidebar");
      expect(f.window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    },
  );
});
