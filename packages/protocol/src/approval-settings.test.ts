import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvalSettingsInputSchema, approvalSettingsSchema } from "./approval-settings.js";

const config = { productRead: "required", publicWeb: "inherit", exceptions: [] };
describe("Owner additional approval policy", () => {
  it("strictly binds revisions, exact Bot/target and protected categories", () => {
    const input = { expectedRevision: 1, ...config };
    expect(approvalSettingsInputSchema.parse(input)).toEqual(input);
    const e = {
      botId: randomUUID(),
      category: "product_read",
      target: { kind: "channel", value: randomUUID() },
    };
    expect(approvalSettingsInputSchema.safeParse({ ...input, exceptions: [e] }).success).toBe(true);
    for (const category of [
      "delete",
      "install",
      "permission_change",
      "command",
      "plugin",
      "unknown",
    ])
      expect(
        approvalSettingsInputSchema.safeParse({ ...input, exceptions: [{ ...e, category }] })
          .success,
      ).toBe(false);
    for (const value of ["*", "prefix-*", "/tmp/file"])
      expect(
        approvalSettingsInputSchema.safeParse({
          ...input,
          exceptions: [{ ...e, target: { kind: "channel", value } }],
        }).success,
      ).toBe(false);
    expect(approvalSettingsInputSchema.safeParse({ ...input, exceptions: [e, e] }).success).toBe(
      false,
    );
    expect(approvalSettingsInputSchema.safeParse({ ...input, allowDelete: true }).success).toBe(
      false,
    );
    expect(
      approvalSettingsSchema.parse({
        revision: 1,
        ...config,
        protectedExceptionCategories: [
          "delete",
          "install",
          "permission_change",
          "command",
          "browser",
          "plugin",
          "unknown",
        ],
      }).revision,
    ).toBe(1);
  });
});
