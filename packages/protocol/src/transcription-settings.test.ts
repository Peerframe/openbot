import { expect, it } from "vitest";
import {
  transcriptionSettingsInputSchema,
  transcriptionSettingsSchema,
} from "./transcription-settings.js";

it("requires a revision and explicit nullable selection, refusing keys and unknown fields", () => {
  expect(transcriptionSettingsSchema.parse({ revision: 1, connectionId: null })).toEqual({
    revision: 1,
    connectionId: null,
  });
  for (const value of [
    { expectedRevision: 1 },
    { expectedRevision: 0, connectionId: null },
    { expectedRevision: 1, connectionId: "../file" },
    { expectedRevision: 1, connectionId: null, apiKey: "private" },
  ]) {
    expect(transcriptionSettingsInputSchema.safeParse(value).success).toBe(false);
  }
});
