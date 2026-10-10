/** Validates Employee inputs before persistence, including scalar text and sensitivity policy. */
import { parseSkillDocument } from "@openbot/employee-publisher/agent-skills";
import { scanSensitiveText } from "@openbot/employee-publisher/sensitive-content";
import {
  createEmployeeSkillRequestSchema,
  importEmployeeSkillInputSchema,
  createEmployeeMemoryInputSchema,
  updateEmployeeMemoryInputSchema,
  reviewKnowledgeProposalInputSchema,
  updateEmployeeSkillStateInputSchema,
} from "@openbot/protocol";
import { z } from "zod";
import { refuse } from "./owner-transaction.js";

export const memoryFields = [
  "kind",
  "title",
  "content",
  "sensitivity",
  "portability",
  "modelUseEnabled",
] as const;
export function parseEmployee<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return refuse(422, "Invalid request input.");
  return parsed.data;
}
// Retain Python's code-point DTO bounds; memory storage applies its additional UTF-16 bound.
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .refine((s) => [...s].length >= 1 && [...s].length <= maximum);
export const skillCreateInput = createEmployeeSkillRequestSchema;
export const skillImportInput = importEmployeeSkillInputSchema;
export const skillStateInput = updateEmployeeSkillStateInputSchema;
// Preserve service-owned policy error codes and merged-state validation, rather than
// collapsing them into the protocol's generic schema refinement error.
export const memoryCreateInput = z.strictObject(createEmployeeMemoryInputSchema.shape);
export const memoryUpdateInput = z
  .strictObject(updateEmployeeMemoryInputSchema.shape)
  .refine((value) => memoryFields.some((field) => field in value));
export const proposalReviewInput = reviewKnowledgeProposalInputSchema;
export function skillDocument(value: string) {
  try {
    return parseSkillDocument(value);
  } catch {
    return refuse(422, "invalid_skill_document");
  }
}
export function memoryPolicy(value: Record<string, unknown>) {
  if (
    value.modelUseEnabled === true &&
    (value.kind === "secret-reference" ||
      ["confidential", "restricted"].includes(value.sensitivity as string))
  )
    refuse(422, "memory_model_use_forbidden");
  if (
    value.kind === "secret-reference" &&
    ((value.sensitivity ?? "restricted") !== "restricted" ||
      (value.portability ?? "never") !== "never")
  )
    refuse(422, "memory_secret_reference_policy");
  for (const [field, maximum] of [
    ["title", 160],
    ["content", 8000],
  ] as const) {
    if (!(field in value)) continue;
    const s = value[field] as string;
    if (/[\ud800-\udfff]/u.test(s)) refuse(422, "invalid_unicode_input");
    if (!s || s.length > maximum || s.includes("\0")) refuse(422, "invalid_employee_memory");
    if (scanSensitiveText(s, field, { portable: false }).length)
      refuse(422, "memory_sensitive_content");
  }
}
export function proposalInput(value: unknown) {
  const result = parseEmployee(
    z.strictObject({
      kind: z.enum(["semantic", "episodic", "procedural"]),
      title: text(160),
      content: text(2000),
    }),
    value,
  );
  if (/[\ud800-\udfff]/u.test(result.title + result.content))
    refuse(422, "invalid_unicode_input");
  if (
    result.title.includes("\0") ||
    result.content.includes("\0") ||
    Buffer.byteLength(result.content) > 8000
  )
    refuse(422, "Invalid request input.");
  if (
    scanSensitiveText(result.title, "title", { portable: false }).length ||
    scanSensitiveText(result.content, "content", { portable: false }).length
  )
    refuse(422, "knowledge_sensitive_content");
  return result;
}
