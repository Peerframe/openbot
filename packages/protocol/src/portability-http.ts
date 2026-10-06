import { z } from "zod";
import {
  activateEmployeeImportInputSchema,
  employeeTemplatePayloadSchema,
  employeeTemplateSkillSchema,
  employeeTemplatePackageSchema,
  dsseEnvelopeSchema,
  computerProfileSchema,
} from "./employee.js";
import { botSchema } from "./control-http.js";
import { nodePlatformSchema, nodeArchitectureSchema } from "./node-metadata.js";
import { nodeDeviceClassSchema } from "./node.js";
import { type HttpOperation, productHttpOperation as product } from "./http-openapi.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Python's browser calendar admits year zero; the package datetime profile excludes it below.
export const calendarUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/)
  .refine((value) => {
    const year = Number(value.slice(0, 4)),
      month = Number(value.slice(5, 7)),
      day = Number(value.slice(8, 10));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= (days[month - 1] ?? 0) &&
      Number(value.slice(11, 13)) <= 23 &&
      Number(value.slice(14, 16)) <= 59 &&
      (value[16] === "Z" || Number(value.slice(17, 19)) <= 59)
    );
  });
// The retained package profile admits minute precision and arbitrary fractional seconds, years1–9999.
export const portableTimestampSchema = calendarUtcTimestampSchema.refine(
  (value) => Number(value.slice(0, 4)) >= 1,
);
const constrainedText = (maximum: number, minimum = 0) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => !/[\ud800-\udfff]/u.test(value));
export const portableSkillHttpSchema = employeeTemplateSkillSchema.safeExtend({
  content: z
    .strictObject({
      markdown: constrainedText(12288, 1),
      sha256: digest,
      license: constrainedText(500, 1),
    })
    .optional(),
});
export const portableEmployeeHttpSchema = employeeTemplatePayloadSchema.shape.employee;
export const portablePayloadHttpSchema = employeeTemplatePayloadSchema.safeExtend({
  generatedAt: portableTimestampSchema,
  employee: portableEmployeeHttpSchema,
  skills: z.array(portableSkillHttpSchema).max(256),
});
export const portablePackageHttpSchema = employeeTemplatePackageSchema.extend({
  payload: portablePayloadHttpSchema,
});
export const unsignedPortablePackageHttpSchema = portablePackageHttpSchema.refine(
  (document) => document.payload.signature.status === "unsigned",
);
// exclude_none omits null envelope/signature extensions; encoded bytes and nested JSON stay intact.
const omitNullExtensions = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null)) as T;
export const portableEnvelopeHttpSchema = dsseEnvelopeSchema
  .extend({
    payloadType: constrainedText(512, 1),
    signatures: z
      .array(
        dsseEnvelopeSchema.shape.signatures.element
          .extend({
            keyid: constrainedText(256).optional(),
          })
          .transform(omitNullExtensions),
      )
      .min(1)
      .max(16),
  })
  .transform(omitNullExtensions);
export const portableDocumentHttpSchema = z.union([
  unsignedPortablePackageHttpSchema,
  portableEnvelopeHttpSchema,
]);
export const employeeExportDownloadInputSchema = z.strictObject({
  packageId: z.string().uuid(),
  generatedAt: portableTimestampSchema,
});
const json = z.json().meta({ "x-openbot-json-value": true });
// Inner package parsing, DSSE trust, digest review and activation policy remain service-owned.
export const activateEmployeeImportRequestSchema = z.strictObject({
  ...activateEmployeeImportInputSchema.shape,
  package: z.record(z.string(), json),
});
export const employeeExportFindingSchema = z.strictObject({
  code: z.enum([
    "credential-like-content",
    "private-key-content",
    "local-path-content",
    "excluded-skill-dependency",
    "invalid-skill-content",
    "package-too-large",
  ]),
  location: z.string(),
  message: z.string(),
});
export const employeeExportExclusionSchema = z.strictObject({
  category: z.enum(["identity", "authority", "memory", "work-history"]),
  count: z.number().int().nonnegative(),
  reason: z.string(),
});
export const employeeExportPreviewSchema = z.strictObject({
  format: z.enum(["openbot.employee/v1", "openbot.employee/v2"]),
  kind: z.literal("template"),
  packageId: z.string().uuid(),
  fileName: z.string(),
  generatedAt: portableTimestampSchema,
  employee: portableEmployeeHttpSchema,
  skills: z.array(portableSkillHttpSchema).max(256),
  employeeName: z.string(),
  verifiedSkillCount: z.number().int().nonnegative(),
  requestedCapabilities: z.array(z.string()).max(256),
  includedMemoryCount: z.literal(0),
  exclusions: z.array(employeeExportExclusionSchema),
  findings: z.array(employeeExportFindingSchema),
  blocked: z.boolean(),
  checksum: digest,
  downloadReviewToken: digest,
  signatureStatus: z.enum(["unsigned", "dsse"]),
  publisherKeyId: z.string().optional(),
  identityOnImport: z.literal("new"),
  hostAuthority: z.literal("none"),
});
export const employeeExportPreviewResponseSchema = z.strictObject({
  preview: employeeExportPreviewSchema,
});
export const employeeImportIssueSchema = z.strictObject({
  code: z.enum([
    "checksum-mismatch",
    "capability-set-mismatch",
    "duplicate-skill",
    "missing-skill-dependency",
    "sensitive-content",
    "missing-capability",
    "no-compatible-host",
    "invalid-skill-content",
  ]),
  message: z.string(),
  locations: z.array(z.string()),
});
export const employeeImportPreviewSchema = z.strictObject({
  format: z.enum(["openbot.employee/v1", "openbot.employee/v2"]),
  packageId: z.string().uuid(),
  generatedAt: portableTimestampSchema,
  employee: portableEmployeeHttpSchema,
  recommendedExecutionProfile: computerProfileSchema,
  skills: z.array(portableSkillHttpSchema).max(256),
  requestedCapabilities: z.array(z.string()).max(256),
  integrity: z.strictObject({ algorithm: z.literal("sha256"), valid: z.boolean(), digest }),
  signature: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("unsigned"), trusted: z.literal(false) }),
    z.strictObject({ status: z.literal("dsse"), trusted: z.literal(true), keyid: z.string() }),
  ]),
  compatibility: z.strictObject({
    hostRequired: z.boolean(),
    compatibleHosts: z
      .array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          platform: nodePlatformSchema,
          architecture: nodeArchitectureSchema,
          deviceClass: nodeDeviceClassSchema,
        }),
      )
      .max(4096),
    missingCapabilities: z.array(z.string()),
  }),
  quarantine: z.strictObject({
    active: z.literal(true),
    createsNewIdentity: z.literal(true),
    importedSkillState: z.literal("disabled-pending-review"),
    hostAuthority: z.literal("none"),
    memoryCount: z.literal(0),
    canActivate: z.boolean(),
  }),
  issues: z.array(employeeImportIssueSchema),
  blocked: z.boolean(),
});
export const employeeImportPreviewResponseSchema = z.strictObject({
  preview: employeeImportPreviewSchema,
});
export const employeeImportReceiptSchema = z.strictObject({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  packageDigest: digest,
  employeeId: z.string().uuid(),
  signatureStatus: z.enum(["unsigned", "dsse"]),
  publisherKeyId: z.string().optional(),
  reviewedBy: z.literal("owner"),
  reviewedAt: portableTimestampSchema,
  importedSkillCount: z.number().int().min(0).max(256),
  createdAt: portableTimestampSchema,
});
export const employeeImportActivationResponseSchema = z.strictObject({
  employee: botSchema,
  receipt: employeeImportReceiptSchema,
  replayed: z.boolean(),
});
export const portabilityHttpSchemas = {
  PortableEmployee: portableEmployeeHttpSchema,
  PortableSkill: portableSkillHttpSchema,
  PortablePayload: portablePayloadHttpSchema,
  EmployeePackage: portablePackageHttpSchema,
  EmployeeDsseEnvelope: portableEnvelopeHttpSchema,
  EmployeeDocument: portableDocumentHttpSchema,
  EmployeeExportDownloadInput: employeeExportDownloadInputSchema,
  ActivateEmployeeImportInput: activateEmployeeImportRequestSchema,
  EmployeeExportPreview: employeeExportPreviewSchema,
  EmployeeExportPreviewResponse: employeeExportPreviewResponseSchema,
  EmployeeImportPreview: employeeImportPreviewSchema,
  EmployeeImportPreviewResponse: employeeImportPreviewResponseSchema,
  EmployeeImportReceipt: employeeImportReceiptSchema,
  EmployeeImportActivationResponse: employeeImportActivationResponseSchema,
};
const selection = { name: "includeSkillContent", schema: { type: "string", enum: ["true"] } };
export const portabilityHttpOperations: readonly HttpOperation[] = [
  product(
    "/api/v1/bots/{bot_id}/export/preview",
    "get",
    "EmployeeExportPreviewResponse",
    undefined,
    { query: [selection] },
  ),
  product("/api/v1/bots/{bot_id}/export", "get", "EmployeeDocument", undefined, {
    responseMediaTypes: [
      "application/vnd.openbot.employee+json",
      "application/vnd.openbot.employee.dsse+json",
    ],
    query: [
      { name: "packageId", required: true, schema: { type: "string", format: "uuid" } },
      { name: "generatedAt", required: true, schema: { type: "string" } },
      selection,
    ],
    headers: [
      { name: "if-match", required: true, schema: { type: "string", pattern: '^"[a-f0-9]{64}"$' } },
    ],
    errors: [401, 403, 404, 408, 412, 413, 422, 428, 503],
  }),
  product(
    "/api/v1/employees/import/preview",
    "post",
    "EmployeeImportPreviewResponse",
    "EmployeeDocument",
    {
      maxBodyBytes: 2 * 1024 * 1024,
    },
  ),
  product(
    "/api/v1/employees/import/activate",
    "post",
    "EmployeeImportActivationResponse",
    "ActivateEmployeeImportInput",
    {
      status: 201,
      additionalSuccessStatuses: [200],
      maxBodyBytes: 2 * 1024 * 1024 + 65536,
    },
  ),
];
export type EmployeeExportPreviewHttp = z.infer<typeof employeeExportPreviewSchema>;
export type EmployeeImportPreviewHttp = z.infer<typeof employeeImportPreviewSchema>;
export type EmployeeImportReceiptHttp = z.infer<typeof employeeImportReceiptSchema>;
export type EmployeeImportActivationHttp = z.infer<typeof employeeImportActivationResponseSchema>;
export type PortableEmployeeHttp = z.infer<typeof portableEmployeeHttpSchema>;
export type PortableSkillHttp = z.infer<typeof portableSkillHttpSchema>;
export type EmployeeExportFindingHttp = z.infer<typeof employeeExportFindingSchema>;
export type EmployeeExportExclusionHttp = z.infer<typeof employeeExportExclusionSchema>;
export type EmployeeImportIssueHttp = z.infer<typeof employeeImportIssueSchema>;
