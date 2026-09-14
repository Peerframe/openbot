import { describe, expect, it } from "vitest";
import {
  grantPluginSchema,
  pluginResourceResultSchema,
  readPluginContentSchema,
} from "./plugins.js";

describe("shared plugin wire contracts", () => {
  it("keeps grants explicit and rejects authority-bearing extra fields", () => {
    const revision = "10000000-0000-4000-8000-000000000001";
    expect(
      grantPluginSchema.parse({ revision, tools: [{ name: "export", mode: "confirm" }] }),
    ).toMatchObject({ resources: [], prompts: [] });
    expect(
      grantPluginSchema.safeParse({ revision, tools: [{ name: "export", mode: "auto" }] }).success,
    ).toBe(false);
    expect(
      readPluginContentSchema.safeParse({
        pluginId: revision,
        revision,
        kind: "resource",
        name: "notes://current",
        botId: revision,
      }).success,
    ).toBe(false);
  });
  it("keeps external resource results text-only and bounded", () => {
    expect(
      pluginResourceResultSchema.safeParse({
        contents: [{ uri: "notes://current", blob: "encoded" }],
      }).success,
    ).toBe(false);
    expect(
      pluginResourceResultSchema.safeParse({
        contents: [{ uri: "notes://current", text: "x".repeat(128 * 1024 + 1) }],
      }).success,
    ).toBe(false);
    expect(
      pluginResourceResultSchema.parse({ contents: [{ uri: "notes://current", text: "note" }] })
        .contents,
    ).toHaveLength(1);
  });
});
