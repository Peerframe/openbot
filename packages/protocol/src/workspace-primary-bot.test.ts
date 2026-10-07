import { expect, it } from "vitest";
import {
  workspacePrimaryBotInputSchema,
  workspacePrimaryBotSchema,
} from "./workspace-primary-bot.js";
it("bounds primary preference CAS and refuses authority-shaped extra fields", () => {
  expect(workspacePrimaryBotInputSchema.parse({ botId: null, expectedRevision: 1 })).toEqual({
    botId: null,
    expectedRevision: 1,
  });
  expect(
    workspacePrimaryBotSchema.parse({ primaryBotId: null, revision: 2 }).primaryBotId,
  ).toBeNull();
  for (const value of [
    { botId: "x", expectedRevision: 0 },
    { botId: "x", expectedRevision: true },
    { botId: "", expectedRevision: 1 },
    { botId: "x", expectedRevision: 1, permissions: ["all"] },
  ])
    expect(workspacePrimaryBotInputSchema.safeParse(value).success).toBe(false);
});
