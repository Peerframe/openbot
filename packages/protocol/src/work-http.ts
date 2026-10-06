import { z } from "zod";
import { nativeTaskScopeInputSchema, nativeTaskScopeRequestSchema } from "./native-task.js";

// JSON Schema/Python lengths count code points, not JavaScript UTF-16 code units.
const boundedText = (max: number) =>
  z
    .string()
    .refine((value) => [...value].length >= 1 && [...value].length <= max)
    .meta({ minLength: 1, maxLength: max });
function validWorkText(value: string, maxBytes: number): boolean {
  // Python str.strip() has a different whitespace set from ECMAScript trim().
  const blank =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Python treats C0 separators as whitespace.
    /^[\t-\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
  return (
    !blank.test(value) &&
    !value.includes("\0") &&
    !/[\ud800-\udfff]/u.test(value) &&
    new TextEncoder().encode(value).length <= maxBytes
  );
}
const boundedWorkText = (max: number) =>
  boundedText(max).refine((value) => validWorkText(value, max));
// Python public projections accept JSON integers beyond JS's safe range; the current Web
// projection is narrower. Do not add a safe-integer restriction to the Server DTO during P1.
const integer = () => z.number().refine(Number.isInteger).meta({ type: "integer" });
const nonnegative = () =>
  integer()
    .refine((value) => value >= 0)
    .meta({ minimum: 0 });
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const workJsonValueSchema = z.json().meta({ "x-openbot-json-value": true });
export type WorkJsonValue = z.infer<typeof workJsonValueSchema>;

const createFields = {
  botId: boundedText(128),
  objective: boundedText(16384),
  tokenLimit: z.number().int().min(0).max(1_000_000_000),
  requestKey: boundedText(128),
};
export const createWorkRequestSchema = z
  .object({
    ...createFields,
    scope: nativeTaskScopeRequestSchema.nullable().default(null),
  })
  .strict();
export const createWorkInputSchema = z
  .object({ ...createFields, scope: nativeTaskScopeInputSchema.nullable().optional() })
  .strict()
  .transform(({ scope, ...required }) => (scope === undefined ? required : { ...required, scope }));
export type CreateWorkInput = z.input<typeof createWorkInputSchema>;
export const cancelWorkInputSchema = z.object({}).strict();
export type CancelWorkInput = z.infer<typeof cancelWorkInputSchema>;
export const decideWorkActionInputSchema = z
  .object({ intentDigest: digest, approved: z.boolean() })
  .strict();
export const reconcileWorkInputSchema = z
  .object({
    intentDigest: digest,
    requestKey: boundedText(128),
    expectedSequence: z.number().int().min(0).max(64),
    reason: boundedText(512),
  })
  .strict();
export const correctWorkInputSchema = z
  .object({
    runId: boundedWorkText(128),
    instruction: boundedWorkText(4096),
    requestKey: boundedWorkText(128),
    expectedSequence: z.number().int().min(0).max(8),
  })
  .strict();
export const workCorrectionSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    runId: z.string(),
    sequence: z.number().int().min(1).max(8),
    requestedBy: z.literal("owner"),
    instruction: boundedText(4096).refine((value) => validWorkText(value, 16384)),
    generation: nonnegative()
      .refine((value) => value >= 1)
      .meta({ minimum: 1 }),
    createdAt: z.string(),
  })
  .strict();
export const workReconciliationSchema = z
  .object({
    id: z.string(),
    actionId: z.string(),
    sequence: integer(),
    requestedBy: z.literal("owner"),
    reason: z.string(),
    createdAt: z.string(),
    delivered: z.boolean(),
    outcome: z.enum(["resolved", "unresolved"]).nullable(),
  })
  .strict();
export const workErrorSchema = z
  .object({ detail: z.union([z.string(), z.array(z.record(z.string(), workJsonValueSchema))]) })
  .strict();
// create_app's global exception adapter emits this envelope. The standalone route registrar's
// documented WorkError/detail is retained for compatibility fixtures, not the product error wire.
export const workHttpErrorSchema = z.object({ error: z.string() }).strict();
export const workUsageSchema = z
  .object({ tokenLimit: nonnegative(), reservedTokens: nonnegative(), spentTokens: nonnegative() })
  .strict();
export const workRunSchema = z
  .object({
    id: z.string(),
    ordinal: integer(),
    status: z.enum(["queued", "running", "completed", "cancelled", "failed"]),
  })
  .strict();
export const workActionSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    intent: z.record(z.string(), workJsonValueSchema),
    intentDigest: z.string(),
    decision: z.enum(["not_required", "pending", "approved", "denied"]),
    status: z.enum(["proposed", "admitted", "unknown", "applied", "not_applied", "superseded"]),
    expiresAt: z.string(),
    reservedTokens: nonnegative(),
    actualTokens: nonnegative().nullable(),
    evidence: z.record(z.string(), z.string()).nullable(),
    reconciliation: workReconciliationSchema.nullable().default(null),
  })
  .strict();
export const workArtifactSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    name: z.string(),
    mediaType: z.string(),
    sha256: z.string(),
    sizeBytes: nonnegative(),
    downloadUrl: z.string(),
  })
  .strict();
export const workEventSchema = z
  .object({
    revision: integer(),
    kind: z.string(),
    payload: z.record(z.string(), workJsonValueSchema),
  })
  .strict();
export const workSnapshotWireSchema = z
  .object({
    id: z.string(),
    botId: z.string(),
    objective: z.string(),
    status: z.enum(["queued", "open", "completed", "cancelled", "failed"]),
    revision: nonnegative(),
    resultSummary: z.string().nullable(),
    authorityActive: z.boolean(),
    cancelRequested: z.boolean(),
    attention: z.enum(["approval", "reconciliation", "budget"]).nullable(),
    usage: workUsageSchema,
    runs: z.array(workRunSchema),
    actions: z.array(workActionSchema),
    artifacts: z.array(workArtifactSchema),
    events: z.array(workEventSchema),
    eventsTruncated: z.boolean(),
  })
  .strict();
export type WorkSnapshot = z.infer<typeof workSnapshotWireSchema>;

// Preserve existing Web additive-response compatibility and stricter projection checks without
// redefining the Server wire shape. Shared contracts contain no application imports or authority.
export const workSnapshotSchema = workSnapshotWireSchema
  .extend({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    usage: workUsageSchema
      .extend({
        tokenLimit: z.number().int().nonnegative(),
        reservedTokens: z.number().int().nonnegative(),
        spentTokens: z.number().int().nonnegative(),
      })
      .strip(),
    runs: z.array(workRunSchema.extend({ ordinal: z.number().int() }).strip()),
    actions: z.array(
      workActionSchema
        .extend({
          intentDigest: digest,
          reservedTokens: z.number().int().nonnegative(),
          actualTokens: z.number().int().nonnegative().nullable(),
          reconciliation: workReconciliationSchema
            .extend({ sequence: z.number().int().nonnegative() })
            .strip()
            .nullable()
            .default(null),
        })
        .strip(),
    ),
    artifacts: z.array(
      workArtifactSchema.extend({ sizeBytes: z.number().int().nonnegative() }).strip(),
    ),
    events: z.array(workEventSchema.extend({ revision: z.number().int() }).strip()),
  })
  .strip() satisfies z.ZodType<WorkSnapshot>;
