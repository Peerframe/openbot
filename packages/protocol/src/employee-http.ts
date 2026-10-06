import { z } from "zod";
import {
  approvalSchema,
  artifactSchema,
  botSchema,
  publicRunProgressSchema,
  runSchema,
} from "./control-http.js";
import {
  computerProfileSchema,
  botAppearanceSchema,
  createEmployeeSkillInputSchema,
  updateEmployeeSkillStateInputSchema,
  updateEmployeeProfileDetailsInputSchema,
  createEmployeeMemoryInputSchema,
  updateEmployeeMemoryInputSchema,
  deleteEmployeeMemoryInputSchema,
  employeeMemoryKindSchema,
  employeeMemorySensitivitySchema,
} from "./employee.js";
import { modelSelectionSchema } from "./model-services.js";
import { nodeCapabilitySchema, versionedCapabilityIdSchema } from "./node-metadata.js";
import { type HttpOperation, productHttpOperation as product } from "./http-openapi.js";

// The retained product skill writer has not admitted browser session/page/maintenance IDs.
export const employeeSkillHttpCapabilitySchema = z.enum([
  ...nodeCapabilitySchema.options,
  ...versionedCapabilityIdSchema.options.filter(
    (id) => !["browser.session", "browser.page", "browser.maintenance"].includes(id),
  ),
]);
export const createEmployeeSkillRequestSchema = createEmployeeSkillInputSchema.safeExtend({
  requiredCapabilities: z
    .array(employeeSkillHttpCapabilitySchema)
    .max(64)
    .default([])
    .transform((values) => [...new Set(values)].sort()),
});
export const importEmployeeSkillInputSchema = z.strictObject({
  markdown: z.string().min(1).max(12288),
  version: z
    .string()
    .max(64)
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/),
  reason: z.string().trim().min(1).max(1000),
});
// These are store guards after protocol trimming. Credential scanning and merged-state policy
// remain service-owned; Markdown additionally uses the existing bounded, opaque YAML parser.
const memoryText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        value.length <= maximum && !value.includes("\0") && !/[\ud800-\udfff]/u.test(value),
    )
    .meta({ "x-openbot-utf16-max-units": maximum });
export const createEmployeeMemoryRequestSchema = createEmployeeMemoryInputSchema.safeExtend({
  title: memoryText(160),
  content: memoryText(8000),
});
export const updateEmployeeMemoryRequestSchema = updateEmployeeMemoryInputSchema.safeExtend({
  title: memoryText(160).optional(),
  content: memoryText(8000).optional(),
});
const proposalFields = {
  kind: z.enum(["semantic", "episodic", "procedural"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(2000),
};
export const reviewKnowledgeProposalInputSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("reject"), ownerReviewed: z.literal(true) }),
  z.strictObject({
    decision: z.literal("accept"),
    ownerReviewed: z.literal(true),
    title: proposalFields.title,
    content: proposalFields.content,
    modelUseEnabled: z.boolean(),
  }),
]);
const evidenceKind = z.enum(["run", "artifact", "approval", "manual", "import"]);
export const employeeEvidenceWireSchema = z.strictObject({
  kind: evidenceKind,
  id: z.string(),
  label: z.string().optional(),
});
export const employeeEvolutionSchema = z.strictObject({
  id: z.string(),
  botId: z.string(),
  type: z.enum([
    "created",
    "role_changed",
    "skill_discovered",
    "skill_verified",
    "skill_suspended",
    "skill_revoked",
    "configuration_changed",
    "imported",
  ]),
  title: z.string(),
  summary: z.string(),
  source: evidenceKind,
  sourceId: z.string().optional(),
  evidence: z.array(employeeEvidenceWireSchema),
  createdAt: z.string(),
});
export const employeeSkillSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  source: z.enum(["built-in", "installed", "learned", "imported", "manual"]),
  state: z.enum(["candidate", "verified", "suspended", "revoked"]),
  confidence: z.number().int(),
  requiredCapabilities: z.array(z.string()),
  dependencyIds: z.array(z.string()),
  evidence: z.array(employeeEvidenceWireSchema),
  acquiredAt: z.string(),
  updatedAt: z.string(),
  skillMarkdown: z.string().optional(),
  contentSha256: z.string().optional(),
  modelUseEnabled: z.boolean().optional(),
});
export const employeeMemorySchema = z.strictObject({
  id: z.string(),
  botId: z.string(),
  kind: employeeMemoryKindSchema,
  title: z.string(),
  content: z.string(),
  sensitivity: employeeMemorySensitivitySchema,
  portability: z.enum(["never", "owner-selectable", "included"]),
  provenance: z.record(z.string(), z.json().meta({ "x-openbot-json-value": true })),
  modelUseEnabled: z.boolean(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const employeeMemoryEventSchema = z.strictObject({
  id: z.string(),
  botId: z.string(),
  memoryId: z.string(),
  action: z.enum(["created", "updated", "deleted"]),
  revision: z.number().int(),
  changedFields: z.array(
    z.enum(["kind", "title", "content", "sensitivity", "portability", "modelUseEnabled"]),
  ),
  actor: z.literal("owner"),
  createdAt: z.string(),
});
export const employeeProfileDetailsSchema = z.strictObject({
  description: z.string(),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export const employeeProfileSchema = z.strictObject({
  employee: botSchema,
  details: employeeProfileDetailsSchema,
  evolution: z.array(employeeEvolutionSchema).max(100),
  skills: z.array(employeeSkillSchema).max(100),
  memories: z.array(employeeMemorySchema).max(100),
  memoryEvents: z.array(employeeMemoryEventSchema).max(200),
  records: z.strictObject({
    runs: z.array(runSchema).max(50),
    approvals: z.array(approvalSchema).max(100),
    // The retained profile accepts numeric artifact metadata; the download manifest is stricter.
    artifacts: z.array(artifactSchema.extend({ sizeBytes: z.number() })).max(100),
    decisions: z.array(publicRunProgressSchema.extend({ summary: z.string() })).max(200),
  }),
  statistics: z.strictObject({
    totalRuns: z.number().int().nonnegative(),
    completedRuns: z.number().int().nonnegative(),
    failedRuns: z.number().int().nonnegative(),
    verifiedSkills: z.number().int().nonnegative(),
  }),
  configuration: z.strictObject({
    executionProfile: computerProfileSchema,
    model: modelSelectionSchema.optional(),
    portabilityFormat: z.literal("openbot.employee/v1"),
  }),
});
export const updateBotAppearanceInputSchema = z.strictObject({
  expectedRevision: updateEmployeeProfileDetailsInputSchema.shape.expectedRevision,
  appearance: botAppearanceSchema.strict(),
});
export const botAppearanceResultSchema = z.strictObject({
  bot: botSchema,
  revision: z.number().int(),
});
export const employeeProfileResponseSchema = z.strictObject({ profile: employeeProfileSchema });
export const employeeProfileMutationSchema = z.strictObject({
  employee: botSchema,
  details: employeeProfileDetailsSchema,
  evolution: employeeEvolutionSchema
    .safeExtend({
      type: z.enum(["role_changed", "configuration_changed"]),
      source: z.literal("manual"),
      evidence: z.array(employeeEvidenceWireSchema).max(0),
    })
    .omit({ sourceId: true }),
});
export const employeeSkillMutationSchema = z.strictObject({
  skill: employeeSkillSchema,
  evolution: employeeEvolutionSchema,
});
export const employeeMemoryMutationSchema = z.strictObject({
  memory: employeeMemorySchema,
  event: employeeMemoryEventSchema,
});
export const employeeMemoryDeletionSchema = z.strictObject({
  memoryId: z.string(),
  event: employeeMemoryEventSchema,
});
const proposalRecord = z.strictObject({
  ...proposalFields,
  id: z.string(),
  botId: z.string(),
  createdAt: z.string(),
});
export const knowledgeProposalSchema = z.union([
  proposalRecord.extend({ sourceRunId: z.string() }),
  proposalRecord.extend({
    source: z.strictObject({ kind: z.literal("task"), taskId: z.string(), runId: z.string() }),
  }),
]);
export const knowledgeProposalsResponseSchema = z.strictObject({
  proposals: z.array(knowledgeProposalSchema).max(50),
});
export const knowledgeProposalReviewResponseSchema = z.strictObject({
  proposalId: z.string(),
  decision: z.enum(["accept", "reject"]),
  memoryId: z.string().nullable(),
});
export const employeeHttpSchemas = {
  UpdateBotAppearanceInput: updateBotAppearanceInputSchema,
  BotAppearanceResult: botAppearanceResultSchema,
  EmployeeSkill: employeeSkillSchema,
  EmployeeMemory: employeeMemorySchema,
  EmployeeMemoryEvent: employeeMemoryEventSchema,
  EmployeeEvolution: employeeEvolutionSchema,
  CreateEmployeeSkillInput: createEmployeeSkillRequestSchema,
  ImportEmployeeSkillInput: importEmployeeSkillInputSchema,
  UpdateEmployeeSkillStateInput: updateEmployeeSkillStateInputSchema,
  UpdateEmployeeProfileDetailsInput: updateEmployeeProfileDetailsInputSchema,
  CreateEmployeeMemoryInput: createEmployeeMemoryRequestSchema,
  UpdateEmployeeMemoryInput: updateEmployeeMemoryRequestSchema,
  DeleteEmployeeMemoryInput: deleteEmployeeMemoryInputSchema,
  ReviewKnowledgeProposalInput: reviewKnowledgeProposalInputSchema,
  EmployeeProfileResponse: employeeProfileResponseSchema,
  ProfileMutationResult: employeeProfileMutationSchema,
  EmployeeSkillMutation: employeeSkillMutationSchema,
  EmployeeMemoryMutation: employeeMemoryMutationSchema,
  EmployeeMemoryDeletion: employeeMemoryDeletionSchema,
  KnowledgeProposalsResponse: knowledgeProposalsResponseSchema,
  KnowledgeProposalReviewResponse: knowledgeProposalReviewResponseSchema,
} as const;
export const employeeHttpOperations: readonly HttpOperation[] = [
  product("/api/v1/bots/{bot_id}/profile", "get", "EmployeeProfileResponse"),
  {
    path: "/api/v1/bots/{bot_id}/appearance",
    method: "patch",
    operationId: "updateBotAppearance",
    status: 200,
    request: "UpdateBotAppearanceInput",
    response: "BotAppearanceResult",
    maxBodyBytes: 2048,
    errors: [400, 401, 403, 404, 408, 409, 413, 415, 422, 503],
  },
  {
    path: "/api/v1/bots/{bot_id}/profile",
    method: "patch",
    operationId: "updateEmployeeProfileDetails",
    status: 200,
    request: "UpdateEmployeeProfileDetailsInput",
    response: "ProfileMutationResult",
    maxBodyBytes: 32768,
    errors: [400, 401, 403, 404, 408, 409, 413, 415, 422, 503],
  },
  product(
    "/api/v1/bots/{bot_id}/skills",
    "post",
    "EmployeeSkillMutation",
    "CreateEmployeeSkillInput",
    { status: 201, maxBodyBytes: 32768 },
  ),
  product(
    "/api/v1/bots/{bot_id}/skills/import",
    "post",
    "EmployeeSkillMutation",
    "ImportEmployeeSkillInput",
    { status: 201, maxBodyBytes: 32768 },
  ),
  product(
    "/api/v1/bots/{bot_id}/skills/{skill_id}/state",
    "post",
    "EmployeeSkillMutation",
    "UpdateEmployeeSkillStateInput",
    { maxBodyBytes: 32768 },
  ),
  product(
    "/api/v1/bots/{bot_id}/memories",
    "post",
    "EmployeeMemoryMutation",
    "CreateEmployeeMemoryInput",
    { status: 201, maxBodyBytes: 32768 },
  ),
  product(
    "/api/v1/bots/{bot_id}/memories/{memory_id}",
    "patch",
    "EmployeeMemoryMutation",
    "UpdateEmployeeMemoryInput",
    { maxBodyBytes: 32768 },
  ),
  product(
    "/api/v1/bots/{bot_id}/memories/{memory_id}",
    "delete",
    "EmployeeMemoryDeletion",
    "DeleteEmployeeMemoryInput",
    { maxBodyBytes: 32768 },
  ),
  product("/api/v1/bots/{bot_id}/knowledge-proposals", "get", "KnowledgeProposalsResponse"),
  product(
    "/api/v1/bots/{bot_id}/knowledge-proposals/{proposal_id}/review",
    "post",
    "KnowledgeProposalReviewResponse",
    "ReviewKnowledgeProposalInput",
    { maxBodyBytes: 16384 },
  ),
];
export type EmployeeProfileWire = z.infer<typeof employeeProfileSchema>;
export type EmployeeSkillWire = z.infer<typeof employeeSkillSchema>;
export type EmployeeMemoryWire = z.infer<typeof employeeMemorySchema>;
export type EmployeeEvolutionWire = z.infer<typeof employeeEvolutionSchema>;
export type EmployeeMemoryEventWire = z.infer<typeof employeeMemoryEventSchema>;
export type KnowledgeProposalWire = z.infer<typeof knowledgeProposalSchema>;
export type KnowledgeProposalReviewInput = z.infer<typeof reviewKnowledgeProposalInputSchema>;
export type EmployeeSkillCreateInputWire = z.infer<typeof createEmployeeSkillInputSchema>;
export type EmployeeSkillStateInputWire = z.infer<typeof updateEmployeeSkillStateInputSchema>;
export type EmployeeProfileDetailsInputWire = z.infer<
  typeof updateEmployeeProfileDetailsInputSchema
>;
export type EmployeeMemoryCreateInputWire = z.infer<typeof createEmployeeMemoryInputSchema>;
export type EmployeeMemoryUpdateInputWire = z.infer<typeof updateEmployeeMemoryInputSchema>;
export type EmployeeMemoryDeleteInputWire = z.infer<typeof deleteEmployeeMemoryInputSchema>;
export type EmployeeSkillMutationWire = z.infer<typeof employeeSkillMutationSchema>;
export type EmployeeProfileMutationWire = z.infer<typeof employeeProfileMutationSchema>;
export type UpdateBotAppearanceInput = z.infer<typeof updateBotAppearanceInputSchema>;
export type BotAppearanceResult = z.infer<typeof botAppearanceResultSchema>;
