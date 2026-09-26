import { describe, expect, it } from "vitest";
import { computerProfileSchema, createBotInputSchema } from "./index.js";
import {
  createModelConnectionInputSchema,
  modelSelectionSchema,
  testModelConnectionInputSchema,
  updateEmployeeModelInputSchema,
  updateModelConnectionInputSchema,
} from "./model-services.js";

const connection = {
  name: " Fixture ",
  presetId: "kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  apiKey: " key ",
};
const selection = { connectionId: "legacy-kimi", modelId: "vendor/model/submodel@version+route" };

describe("retained model connection DTOs", () => {
  it("preserves short credentials, model IDs up to256 and explicit null selection", () => {
    expect(createModelConnectionInputSchema.parse(connection)).toEqual({
      ...connection,
      name: "Fixture",
      apiKey: "key",
    });
    expect(modelSelectionSchema.parse(selection)).toEqual(selection);
    expect(testModelConnectionInputSchema.parse({ modelId: "m".repeat(256) }).modelId).toHaveLength(
      256,
    );
    expect(updateEmployeeModelInputSchema.parse({ expectedRevision: 1, model: null })).toEqual({
      expectedRevision: 1,
      model: null,
    });
  });
  it.each([
    { expectedRevision: 1 },
    { expectedRevision: 1, apiKey: null },
    { expectedRevision: 1, enabled: null },
    { expectedRevision: 1, protocol: "openai-chat" },
    { expectedRevision: true, enabled: false },
  ])("refuses invalid update payloads %o", (value) => {
    expect(updateModelConnectionInputSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    "http://127.0.0.1:3000",
    "https://user:pass@example.test",
    "https://example.test/?key=x",
    "https://example.test/#fragment",
  ])("refuses unauthorized URL shapes %s", (baseUrl) => {
    expect(createModelConnectionInputSchema.safeParse({ ...connection, baseUrl }).success).toBe(
      false,
    );
  });
  it("accepts model Bots without changing the existing none default or allowing selection on other profiles", () => {
    expect(computerProfileSchema.parse("model")).toBe("model");
    expect(createBotInputSchema.parse({ name: "Bot", role: "Fixture" }).computerProfile).toBe(
      "none",
    );
    expect(
      createBotInputSchema.parse({
        name: "Bot",
        role: "Fixture",
        computerProfile: "model",
        model: selection,
      }).model,
    ).toEqual(selection);
    expect(
      createBotInputSchema.safeParse({
        name: "Bot",
        role: "Fixture",
        computerProfile: "none",
        model: selection,
      }).success,
    ).toBe(false);
    expect(
      createBotInputSchema.safeParse({
        name: "Bot",
        role: "Fixture",
        computerProfile: "model",
        model: null,
      }).success,
    ).toBe(false);
  });
  it.each(["model", "docker-linux"])("accepts explicit selection on %s", (computerProfile) => {
    expect(
      createBotInputSchema.parse({
        name: "Bot",
        role: "Fixture",
        computerProfile,
        model: selection,
      }).model,
    ).toEqual(selection);
    expect(
      createBotInputSchema.safeParse({ name: "Bot", role: "Fixture", computerProfile, model: null })
        .success,
    ).toBe(false);
  });
  it.each(["none", "macos-cua", "lume-vm", "coder"])(
    "refuses selection on %s",
    (computerProfile) => {
      expect(
        createBotInputSchema.safeParse({
          name: "Bot",
          role: "Fixture",
          computerProfile,
          model: selection,
        }).success,
      ).toBe(false);
    },
  );
});
