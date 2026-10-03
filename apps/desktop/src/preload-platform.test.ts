import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PLATFORM_PREFERENCES } from "./platform-preferences.js";
import type { OpenBotDesktopBridge } from "./runtime-contract.js";

describe("isolated Desktop platform preload", () => {
  it("requires actual user activation for settings, downloads and installs and forwards fixed DTOs", async () => {
    const ipcRenderer = Object.assign(new EventEmitter(), {
      invoke: vi.fn(async () => ({ status: "idle" })),
    });
    const navigator = { userActivation: { isActive: false } };
    let bridge: OpenBotDesktopBridge | undefined;
    runInNewContext(
      stripTypeScriptTypes(readFileSync(new URL("./preload.cts", import.meta.url), "utf8"), {
        mode: "strip",
      }),
      {
        exports: {},
        process: { versions: { electron: "44.3.0" }, platform: "darwin" },
        navigator,
        require: (name: string) => {
          if (name !== "electron") throw new Error("unexpected import");
          return {
            ipcRenderer,
            contextBridge: {
              exposeInMainWorld: (_key: string, value: OpenBotDesktopBridge) => {
                bridge = value;
              },
            },
          };
        },
      },
    );
    await expect(bridge?.setPlatformPreferences?.(DEFAULT_PLATFORM_PREFERENCES)).rejects.toThrow(
      "user gesture",
    );
    await expect(bridge?.setColorScheme?.("dark")).rejects.toThrow("user gesture");
    await expect(bridge?.setColorScheme?.("auto" as never)).rejects.toThrow("Invalid");
    await expect(bridge?.downloadUpdate?.()).rejects.toThrow("user gesture");
    await expect(bridge?.installUpdate?.()).rejects.toThrow("user gesture");
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    navigator.userActivation.isActive = true;
    await bridge?.setPlatformPreferences?.({
      ...DEFAULT_PLATFORM_PREFERENCES,
      url: "https://untrusted",
    } as never);
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "openbot:set-platform-preferences",
      DEFAULT_PLATFORM_PREFERENCES,
    );
    await bridge?.getColorScheme?.();
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("openbot:get-color-scheme");
    await bridge?.setColorScheme?.("dark");
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("openbot:set-color-scheme", "dark");
    const changed = vi.fn();
    const unsubscribe = bridge?.onColorSchemeChanged?.(changed);
    ipcRenderer.emit(
      "openbot:color-scheme-changed",
      { sender: "private native event" },
      { scheme: "system", resolved: "dark" },
    );
    expect(changed).toHaveBeenCalledExactlyOnceWith({ scheme: "system", resolved: "dark" });
    for (const value of [
      null,
      {},
      { scheme: "auto", resolved: "dark" },
      { scheme: "system", resolved: "system" },
      { scheme: "dark", resolved: "dark", secret: "dropped" },
    ])
      ipcRenderer.emit("openbot:color-scheme-changed", {}, value);
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe?.();
    expect(ipcRenderer.listenerCount("openbot:color-scheme-changed")).toBe(0);
    await bridge?.downloadUpdate?.();
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("openbot:download-update");
    await bridge?.installUpdate?.();
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("openbot:install-update");
  });
});
