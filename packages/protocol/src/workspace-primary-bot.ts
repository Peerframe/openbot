import { z } from "zod";
const botId = z.string().min(1).max(128).nullable();
const revision = z.number().int().min(1).max(2147483647);
export const workspacePrimaryBotInputSchema = z
  .object({ botId, expectedRevision: revision })
  .strict();
export const workspacePrimaryBotSchema = z.object({ primaryBotId: botId, revision }).strict();
