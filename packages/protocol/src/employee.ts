import { z } from "zod";
import { modelSelectionSchema } from "./model-services.js";
import { nodeCapabilitySchema, versionedCapabilityIdSchema } from "./node-metadata.js";

export const computerProfileSchema = z.enum([
  "none",
  "model",
  "docker-linux",
  "macos-cua",
  "lume-vm",
  "coder",
]);

export const botAppearanceSchema = z.object({
  head: z.enum(["round", "square", "cat"]),
  body: z.enum(["classic", "tall", "cape", "armor", "storage", "quadruped"]),
  mobility: z.enum(["feet", "single-wheel", "dual-wheel", "hover", "four-legs"]),
  accessory: z.enum(["none", "headphones", "backpack", "trench", "arm", "toolbox"]),
  accent: z.enum(["green", "yellow", "red", "blue"]),
});

export const employeeEvidenceReferenceSchema = z
  .object({
    kind: z.enum(["run", "artifact", "approval", "manual", "import"]),
    id: z.string().trim().min(1).max(160),
    label: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

const employeeSkillSourceSchema = z.enum([
  "built-in",
  "installed",
  "learned",
  "imported",
  "manual",
]);
const employeeSkillCapabilitySchema = z.union([nodeCapabilitySchema, versionedCapabilityIdSchema]);
const employeeSkillReasonSchema = z.string().trim().min(1).max(1000);

export const createEmployeeSkillInputSchema = z
  .object({
    skillMarkdown: z
      .string()
      .min(1)
      .max(12 * 1024)
      .optional(),
    // `slug` is the interoperable Agent Skills name; the display name remains separate.
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use an Agent Skills-compatible lowercase name with hyphens.",
      ),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1024),
    version: z
      .string()
      .trim()
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Use a semantic version."),
    source: employeeSkillSourceSchema,
    requiredCapabilities: z
      .array(employeeSkillCapabilitySchema)
      .max(64)
      .default([])
      .transform((values) => [...new Set(values)].sort()),
    dependencySkillIds: z
      .array(z.string().uuid())
      .max(64)
      .default([])
      .transform((values) => [...new Set(values)].sort()),
    evidence: z.array(employeeEvidenceReferenceSchema).max(32).default([]),
    reason: employeeSkillReasonSchema,
  })
  .strict();

const employeeSkillReviewFields = {
  reason: employeeSkillReasonSchema,
  evidence: z.array(employeeEvidenceReferenceSchema).max(32).default([]),
  ownerReviewed: z.literal(true),
};

export const updateEmployeeSkillStateInputSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("verified"),
      reviewedContentSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      confidence: z.number().int().min(1).max(100),
      ...employeeSkillReviewFields,
    })
    .strict(),
  z
    .object({
      state: z.literal("suspended"),
      ...employeeSkillReviewFields,
    })
    .strict(),
  z
    .object({
      state: z.literal("revoked"),
      ...employeeSkillReviewFields,
    })
    .strict(),
]);

/** Descriptive Employee fields only. Authority-bearing configuration has separate controls. */
export const updateEmployeeProfileDetailsInputSchema = z
  .object({
    role: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000),
    expectedRevision: z.number().int().min(1),
  })
  .strict();

export const employeeMemoryKindSchema = z.enum([
  "working",
  "episodic",
  "semantic",
  "procedural",
  "secret-reference",
]);
export const employeeMemorySensitivitySchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export const employeeMemoryPortabilityInputSchema = z.enum(["never", "owner-selectable"]);

const employeeMemoryFields = {
  kind: employeeMemoryKindSchema,
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8000),
  sensitivity: employeeMemorySensitivitySchema,
  portability: employeeMemoryPortabilityInputSchema,
  modelUseEnabled: z.boolean().optional(),
};

function requireSecretReferencePolicy(
  value: {
    kind?: z.infer<typeof employeeMemoryKindSchema> | undefined;
    sensitivity?: z.infer<typeof employeeMemorySensitivitySchema> | undefined;
    portability?: z.infer<typeof employeeMemoryPortabilityInputSchema> | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    "modelUseEnabled" in value &&
    value.modelUseEnabled === true &&
    (value.kind === "secret-reference" ||
      value.sensitivity === "confidential" ||
      value.sensitivity === "restricted")
  ) {
    context.addIssue({
      code: "custom",
      path: ["modelUseEnabled"],
      message: "Only public or internal non-secret memory can be shared with the model.",
    });
  }
  if (value.kind !== "secret-reference") return;
  if (value.sensitivity !== undefined && value.sensitivity !== "restricted") {
    context.addIssue({
      code: "custom",
      path: ["sensitivity"],
      message: "Secret references must use restricted sensitivity.",
    });
  }
  if (value.portability !== undefined && value.portability !== "never") {
    context.addIssue({
      code: "custom",
      path: ["portability"],
      message: "Secret references must never be portable.",
    });
  }
}

export const createEmployeeMemoryInputSchema = z
  .object(employeeMemoryFields)
  .strict()
  .superRefine(requireSecretReferencePolicy);

export const updateEmployeeMemoryInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    kind: employeeMemoryFields.kind.optional(),
    title: employeeMemoryFields.title.optional(),
    content: employeeMemoryFields.content.optional(),
    sensitivity: employeeMemoryFields.sensitivity.optional(),
    portability: employeeMemoryFields.portability.optional(),
    modelUseEnabled: employeeMemoryFields.modelUseEnabled,
  })
  .strict()
  .refine(
    (value) =>
      value.kind !== undefined ||
      value.title !== undefined ||
      value.content !== undefined ||
      value.sensitivity !== undefined ||
      value.portability !== undefined ||
      value.modelUseEnabled !== undefined,
    { message: "At least one memory field must change." },
  )
  .superRefine(requireSecretReferencePolicy);

export const deleteEmployeeMemoryInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    ownerReviewed: z.literal(true),
  })
  .strict();

export const quickCreateBotInputSchema = z
  .object({ appearance: botAppearanceSchema.strict() })
  .strict();

export const createBotInputSchema = z
  .object({
    name: z.string().trim().min(1, "Bot name is required.").max(64),
    role: z.string().trim().min(1, "Bot role is required.").max(160),
    computerProfile: computerProfileSchema.default("none"),
    appearance: botAppearanceSchema.optional(),
    model: modelSelectionSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.model !== undefined && !["model", "docker-linux"].includes(input.computerProfile)) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "Only model or Docker Linux Employees can select a model connection.",
      });
    }
  });

/**
 * The first portable employee format is intentionally a template, not an identity transfer.
 * It contains no source employee id, host binding, credentials, sessions, or capability grants.
 */
export const employeeTemplateSkillSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1024),
    version: z.string().trim().min(1).max(64),
    requiredCapabilities: z.array(z.string().trim().min(1).max(160)).max(64),
    content: z
      .object({
        markdown: z
          .string()
          .min(1)
          .max(12 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        license: z.string().min(1).max(500),
      })
      .strict()
      .optional(),
    dependencySlugs: z.array(z.string().trim().min(1).max(160)).max(64),
  })
  .strict();

export const employeeTemplateSignatureSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unsigned") }).strict(),
  z
    .object({
      status: z.literal("dsse"),
      algorithm: z.literal("ed25519"),
      keyid: z.string().trim().min(1).max(256),
    })
    .strict(),
]);

export const employeeTemplatePayloadSchema = z
  .object({
    format: z.enum(["openbot.employee/v1", "openbot.employee/v2"]),
    kind: z.literal("template"),
    packageId: z.string().uuid(),
    generatedAt: z.string().datetime(),
    employee: z
      .object({
        name: z.string().trim().min(1).max(64),
        role: z.string().trim().min(1).max(160),
        description: z.string().trim().max(2000).optional(),
        appearance: botAppearanceSchema.strict().optional(),
      })
      .strict(),
    configuration: z
      .object({
        recommendedExecutionProfile: computerProfileSchema,
      })
      .strict(),
    skills: z.array(employeeTemplateSkillSchema).max(256),
    requestedCapabilities: z.array(z.string().trim().min(1).max(160)).max(256),
    portability: z
      .object({
        identity: z.literal("new-on-import"),
        authority: z.literal("none"),
        memories: z.literal("none"),
        importedSkillState: z.literal("disabled-pending-review"),
      })
      .strict(),
    signature: employeeTemplateSignatureSchema,
  })
  .strict()
  .refine(
    (payload) =>
      payload.format !== "openbot.employee/v1" || payload.skills.every((skill) => !skill.content),
    { message: "Instruction content requires openbot.employee/v2." },
  );

export type EmployeeTemplatePayload = z.infer<typeof employeeTemplatePayloadSchema>;

export const employeeTemplatePackageSchema = z
  .object({
    payload: employeeTemplatePayloadSchema,
    integrity: z
      .object({
        algorithm: z.literal("sha256"),
        canonicalization: z.literal("openbot-json-v1"),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export type EmployeeTemplatePackage = z.infer<typeof employeeTemplatePackageSchema>;

/** Identifies the package instance inspected by an Employee export preview. */
export const employeeExportDownloadQuerySchema = z
  .object({
    packageId: z.string().uuid(),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type EmployeeExportDownloadQuery = z.infer<typeof employeeExportDownloadQuerySchema>;

/** Standalone packages must be explicitly unsigned; signed documents travel inside DSSE. */
export const unsignedEmployeeTemplatePackageSchema = employeeTemplatePackageSchema.refine(
  (document) => document.payload.signature.status === "unsigned",
  {
    path: ["payload", "signature", "status"],
    message: "Signed employee packages must be verified from their DSSE envelope.",
  },
);

/**
 * DSSE authenticates the exact package bytes and their application-specific media type. Unknown
 * envelope fields remain forward compatible as required by the DSSE v1 envelope specification;
 * the decoded OpenBot package itself is still parsed with a strict schema.
 */
const dsseBase64Schema = z
  .string()
  .min(1)
  .max(1_500_000)
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/)
  .refine((value) => value.replace(/=+$/, "").length % 4 !== 1, "Invalid base64 length.");

export const dsseEnvelopeSchema = z
  .object({
    payload: dsseBase64Schema,
    payloadType: z.string().min(1).max(512),
    signatures: z
      .array(
        z
          .object({
            keyid: z.string().max(256).optional(),
            sig: z.string().min(1).max(8192).pipe(dsseBase64Schema),
          })
          .passthrough(),
      )
      .min(1)
      .max(16),
  })
  .passthrough();

export type DsseEnvelope = z.infer<typeof dsseEnvelopeSchema>;

export const employeeTemplateV2DssePayloadType =
  "application/vnd.openbot.employee.v2+json" as const;

export const employeeTemplateDssePayloadType = "application/vnd.openbot.employee.v1+json" as const;

/** Binds activation to the exact package and review result previously shown to the Owner. */
export const activateEmployeeImportInputSchema = z
  .object({
    package: z.union([unsignedEmployeeTemplatePackageSchema, dsseEnvelopeSchema]),
    expectedPackageId: z.string().uuid(),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ownerReviewed: z.literal(true),
    allowUnsigned: z.boolean(),
    idempotencyKey: z.string().uuid(),
    employeeName: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type ActivateEmployeeImportInput = z.infer<typeof activateEmployeeImportInputSchema>;
