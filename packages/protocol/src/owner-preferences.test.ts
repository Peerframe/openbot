import { describe, expect, it } from "vitest";
import { ownerPreferencesInputSchema, ownerPreferencesSchema } from "./owner-preferences.js";

describe("Server Owner preferences", () => {
  it("requires the revision, timezone and explicit nullable default", () => {
    const body = { expectedRevision: 1, timezone: "Asia/Singapore", defaultModel: null };
    expect(ownerPreferencesInputSchema.parse(body)).toEqual(body);
    for (const value of [
      { ...body, timezone: "/etc/passwd" },
      { ...body, timezone: "Asia/../UTC" },
      { ...body, defaultModel: { connectionId: "c", modelId: "m", apiKey: "secret" } },
      { ...body, expectedRevision: 0 },
      { ...body, expectedRevision: 2147483648 },
      { ...body, extra: true },
      { expectedRevision: 1, timezone: "UTC" },
    ])
      expect(ownerPreferencesInputSchema.safeParse(value).success).toBe(false);
    expect(
      ownerPreferencesSchema.parse({
        revision: 1,
        timezone: "UTC",
        defaultModel: null,
        updatedAt: "2026-10-01T00:00:00Z",
      }).revision,
    ).toBe(1);
  });
});
