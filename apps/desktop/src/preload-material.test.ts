import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { OpenBotDesktopBridge } from "./runtime-contract.js";

function preload() {
  const ipcRenderer = Object.assign(new EventEmitter(), {
    invoke: vi.fn(async () => ({ status: "enabled" })),
  });
  let bridge: OpenBotDesktopBridge | undefined;
  const source = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");
  runInNewContext(stripTypeScriptTypes(source, { mode: "strip" }), {
    exports: {},
    process: { versions: { electron: "44.2.0" }, platform: "darwin" },
    require: (name: string) => {
      if (name !== "electron") throw new Error("Unexpected sandbox import");
      return {
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld: (key: string, value: OpenBotDesktopBridge) => {
            expect(key).toBe("openbotDesktop");
            bridge = value;
          },
        },
      };
    },
  });
  if (!bridge?.setSidebarTranslucency || !bridge.onSidebarMaterialChanged) {
    throw new Error("Sidebar bridge unavailable");
  }
  return { bridge, ipcRenderer };
}

describe("sandboxed sidebar material preload", () => {
  it("uses only the fixed presentation channel with a strict boolean", async () => {
    const { bridge, ipcRenderer } = preload();
    await bridge.setSidebarTranslucency?.(true);
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(
      "openbot:set-sidebar-translucency",
      true,
    );
    for (const value of ["true", 1, undefined, {}, null]) {
      expect(await bridge.setSidebarTranslucency?.(value as boolean)).toEqual({
        status: "unavailable",
      });
    }
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  });

  it("strips the Electron event and rejects malformed state broadcasts", () => {
    const { bridge, ipcRenderer } = preload();
    const changed = vi.fn();
    const unsubscribe = bridge.onSidebarMaterialChanged?.(changed);
    const nativeEvent = { sender: ipcRenderer };
    ipcRenderer.emit("openbot:sidebar-material-changed", nativeEvent, { status: "reduced" });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ status: "reduced" });
    for (const value of [
      null,
      {},
      "enabled",
      { status: "other" },
      { status: "enabled", extra: 1 },
    ]) {
      ipcRenderer.emit("openbot:sidebar-material-changed", nativeEvent, value);
    }
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe?.();
    expect(ipcRenderer.listenerCount("openbot:sidebar-material-changed")).toBe(0);
    ipcRenderer.emit("openbot:sidebar-material-changed", nativeEvent, { status: "enabled" });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("sandboxed notification preload", () => {
  it("forwards only the two bounded strings on the fixed channel", async () => {
    const { bridge, ipcRenderer } = preload();
    await bridge.showNotification?.({
      title: "需要你批准",
      body: "研究助理",
      extra: "dropped",
    } as never);
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith("openbot:show-notification", {
      title: "需要你批准",
      body: "研究助理",
    });
    for (const value of [null, {}, { title: 1, body: "" }, { title: "a", body: "b".repeat(81) }])
      expect(await bridge.showNotification?.(value as never)).toEqual({ status: "failed" });
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  });
});
