import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { OpenBotDesktopBridge } from "./runtime-contract.js";

function runtimeBridge(shellVersion: unknown = "44.3.0") {
  let bridge: OpenBotDesktopBridge | undefined;
  const source = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");
  runInNewContext(stripTypeScriptTypes(source, { mode: "strip" }), {
    exports: {},
    process: { versions: { electron: shellVersion }, platform: "darwin", arch: "arm64" },
    require: (name: string) => {
      if (name !== "electron") throw new Error("Unexpected sandbox import");
      return {
        ipcRenderer: {},
        contextBridge: {
          exposeInMainWorld: (key: string, value: OpenBotDesktopBridge) => {
            expect(key).toBe("openbotDesktop");
            bridge = value;
          },
        },
      };
    },
  });
  if (!bridge) throw new Error("Desktop bridge was not exposed");
  return bridge;
}

describe("Desktop runtime contract", () => {
  it("the real isolated preload exposes frozen native runtime metadata", () => {
    const bridge = runtimeBridge();
    const info = bridge.getRuntimeInfo();
    expect(info).toEqual({
      kind: "desktop",
      platform: "darwin",
      arch: "arm64",
      shellVersion: "44.3.0",
    });
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.values(info).every((value) => typeof value === "string")).toBe(true);
    expect(bridge.getRuntimeInfo()).toBe(info);
  });

  it.each(["latest", "", "44.3", "44.3.0/private"])(
    "rejects malformed Electron metadata before exposure: %s",
    (version) => {
      expect(() => runtimeBridge(version)).toThrow("Electron version is invalid.");
    },
  );
  it("accepts a prerelease Electron identifier without changing it", () => {
    expect(runtimeBridge("44.3.0-beta.1").getRuntimeInfo().shellVersion).toBe("44.3.0-beta.1");
  });
});
