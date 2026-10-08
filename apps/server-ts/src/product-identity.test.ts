import { describe, expect, it } from "vitest";
import { channelInput, profileInput, identityRoutes } from "./product-identity.js";
import { entryOptions } from "./config.js";

describe("product identity compatibility", () => {
  it("retains code-point limits and stripped creation fields", () => {
    expect(channelInput.parse({ name: " " + "😀".repeat(80) + " ", ignored: true })).toEqual({
      name: "😀".repeat(80),
      description: "",
      botIds: [],
    });
    expect(channelInput.safeParse({ name: "😀".repeat(81) }).success).toBe(false);
    expect(
      profileInput.parse({ role: "😀".repeat(160), description: "", expectedRevision: 1.0 }).role,
    ).toHaveLength(320);
    expect(
      profileInput.safeParse({ role: "x", description: "", expectedRevision: 1, extra: 1 }).success,
    ).toBe(false);
  });
  it("owns only the exact implemented routes", () => {
    expect(identityRoutes).toHaveLength(11);
    expect(new Set(identityRoutes.map((r) => r.method + " " + r.path)).size).toBe(11);
    expect(
      identityRoutes.some((r) => r.method === "DELETE" || r.path === "/api/v1/bots/quick"),
    ).toBe(false);
  });
  it("rejects a product cohort without an explicit database", () => {
    expect(() => entryOptions({ OPENBOT_TS_PRODUCT_GROUP: "identity" })).toThrow(/PostgreSQL/);
    expect(() => entryOptions({ OPENBOT_TS_PRODUCT_GROUP: "all" })).toThrow(/Unknown/);
  });
});
