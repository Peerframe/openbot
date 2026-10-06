import { z } from "zod";
import {
  automationSchema,
  createAutomationInputSchema,
  updateAutomationInputSchema,
} from "./automations.js";
import { type HttpOperation, productHttpOperation as product } from "./http-openapi.js";

const utf16 = (maximum: number, trim = false) =>
  (trim ? z.string().trim() : z.string())
    .min(1)
    .max(maximum)
    .refine((value) => value.length <= maximum && !/[\ud800-\udfff]/u.test(value))
    .meta({ "x-openbot-utf16-max-units": maximum });
export const createAutomationRequestSchema = createAutomationInputSchema.safeExtend({
  name: utf16(80, true),
  prompt: utf16(8000, true),
  channelId: utf16(128),
  botId: utf16(128),
  firstRunAt: z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
});
// The actual AutomationEnabled product DTO strips extra fields; retain that admission behavior.
export const updateAutomationRequestSchema = updateAutomationInputSchema.strip();
export const automationResponseSchema = z.strictObject({ automation: automationSchema });
export const automationsResponseSchema = z.strictObject({
  automations: z.array(automationSchema).max(50),
});
export const automationDeletionSchema = z.strictObject({ deleted: z.literal(true) });
export const automationHttpSchemas = {
  CreateAutomationInput: createAutomationRequestSchema,
  UpdateAutomationInput: updateAutomationRequestSchema,
  Automation: automationSchema,
  AutomationResponse: automationResponseSchema,
  AutomationsResponse: automationsResponseSchema,
  AutomationDeletion: automationDeletionSchema,
};
export const automationHttpOperations: readonly HttpOperation[] = [
  product("/api/v1/automations", "get", "AutomationsResponse"),
  product("/api/v1/automations", "post", "AutomationResponse", "CreateAutomationInput", {
    status: 201,
    maxBodyBytes: 32768,
  }),
  product(
    "/api/v1/automations/{automation_id}",
    "patch",
    "AutomationResponse",
    "UpdateAutomationInput",
    { maxBodyBytes: 1024 },
  ),
  product("/api/v1/automations/{automation_id}", "delete", "AutomationDeletion", undefined, {
    maxBodyBytes: 1024,
  }),
];
