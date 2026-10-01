import { describe, expect, it } from "vitest";
import { ownerPasswordChangeInputSchema, ownerSessionDeviceSchema } from "./owner-security.js";

describe("Owner security contract", () => {
  it("keeps password whitespace and Unicode code point bounds", () => {
    const value = { currentPassword: " existing password ", newPassword: "😀".repeat(1024) };
    expect(ownerPasswordChangeInputSchema.parse(value)).toEqual(value);
    expect(
      ownerPasswordChangeInputSchema.safeParse({ ...value, newPassword: "x".repeat(14) }).success,
    ).toBe(false);
    expect(
      ownerPasswordChangeInputSchema.safeParse({ ...value, newPassword: "😀".repeat(1025) })
        .success,
    ).toBe(false);
    expect(ownerPasswordChangeInputSchema.safeParse({ ...value, bypass: true }).success).toBe(
      false,
    );
  });
  it("excludes bearer secrets and authenticates no device based on its hint", () => {
    const device = {
      id: "session",
      userAgent: "hint",
      current: true,
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-01T12:00:00.000Z",
    };
    expect(ownerSessionDeviceSchema.parse(device)).toEqual(device);
    expect(ownerSessionDeviceSchema.safeParse({ ...device, tokenDigest: "secret" }).success).toBe(
      false,
    );
    expect(
      ownerSessionDeviceSchema.safeParse({ ...device, userAgent: "x".repeat(257) }).success,
    ).toBe(false);
  });
});
