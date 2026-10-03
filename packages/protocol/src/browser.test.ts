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

it("keeps lifecycle actions off the public input command and requires separate clear confirmation", async () => {
  const { browserMaintenanceInputSchema, browserRuntimeStateSchema } = await import("./browser.js");
  expect(browserActionSchema.safeParse({ kind: "maintenance", operation: "clear" }).success).toBe(
    false,
  );
  expect(browserMaintenanceInputSchema.safeParse({ operation: "clear" }).success).toBe(false);
  expect(
    browserMaintenanceInputSchema.safeParse({
      operation: "clear",
      confirmation: "clear-browser-data",
    }).success,
  ).toBe(true);
  expect(
    browserMaintenanceInputSchema.safeParse({
      operation: "restart",
      confirmation: "clear-browser-data",
    }).success,
  ).toBe(false);
  expect(
    browserMaintenanceInputSchema.safeParse({
      operation: "clear",
      confirmation: "clear-browser-data",
      path: "/private",
    }).success,
  ).toBe(false);
  expect(browserRuntimeStateSchema.safeParse({ running: "true" }).success).toBe(false);
  expect(browserRuntimeStateSchema.parse({ running: true })).toEqual({
    running: true,
    profileBytes: null,
  });
  for (const profileBytes of [null, 0, 123, Number.MAX_SAFE_INTEGER]) {
    expect(browserRuntimeStateSchema.parse({ running: true, profileBytes })).toEqual({
      running: true,
      profileBytes,
    });
  }
  for (const profileBytes of [true, "123", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    expect(browserRuntimeStateSchema.safeParse({ running: true, profileBytes }).success).toBe(
      false,
    );
  }
  expect(
    browserRuntimeStateSchema.safeParse({ running: true, profileBytes: 1, path: "/private" })
      .success,
  ).toBe(false);
});
