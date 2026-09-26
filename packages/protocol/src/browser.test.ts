import { describe, expect, it } from "vitest";
import { browserActionSchema, browserCommandSchema, browserFrameSchema } from "./browser.js";
import { protocolVersion } from "./node-metadata.js";

describe("browser protocol", () => {
  it("accepts bounded Unicode input without allowing arbitrary keys, scripts or fields", () => {
    expect(browserActionSchema.parse({ kind: "type", text: "你好. 🌏" })).toEqual({
      kind: "type",
      text: "你好. 🌏",
    });
    for (const input of [
      { kind: "eval", code: "location.href" },
      { kind: "type", text: "a".repeat(4097) },
      { kind: "key", key: "Control+L" },
      { kind: "click", x: Infinity, y: 1 },
      { kind: "observe", nodeId: "other" },
    ]) {
      expect(browserActionSchema.safeParse(input).success).toBe(false);
    }
  });
  it("requires explicit identity and deadline and bounds frames", () => {
    expect(
      browserCommandSchema.safeParse({
        type: "browser.command",
        protocolVersion,
        action: { kind: "observe" },
      }).success,
    ).toBe(false);
    expect(
      browserFrameSchema.safeParse({
        base64: "not an image",
        width: 1280,
        height: 800,
        capturedAt: new Date().toISOString(),
        url: "about:blank",
      }).success,
    ).toBe(false);
  });
});
