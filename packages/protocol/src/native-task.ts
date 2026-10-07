import { z } from "zod";
import {
  attachmentByteLimit,
  attachmentMetadataSchema,
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
} from "./attachments.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identities = (max: number) =>
  z
    .array(z.string().uuid())
    .max(max)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length);

// The Web input projection preserves spelling/order. The Server adapter below canonicalizes
// identities before persistence; a declared scope alone never authorizes a resource operation.
export const nativeTaskScopeInputSchema = z
  .object({
    version: z.literal(1),
    attachmentIds: identities(MAX_TASK_ATTACHMENTS),
    collaboratorBotIds: identities(32),
    knowledge: z.boolean(),
    plugins: z.boolean(),
    web: z.boolean(),
  })
  .strict();
export type NativeTaskScopeInput = z.infer<typeof nativeTaskScopeInputSchema>;

function canonicalUuid(value: string): string | null {
  // Match the retained Python UUID string input, including URN, braces and compact hex.
  const hex = value.replace(/urn:|uuid:|-/g, "").replace(/^[{}]+|[{}]+$/g, "");
  if (!/^[a-f0-9]{32}$/i.test(hex)) return null;
  const lower = hex.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}
const serverIdentities = (max: number) =>
  z
    .array(z.string())
    .max(max)
    .transform((ids, context) => {
      const canonical = ids.map(canonicalUuid);
      if (canonical.some((id) => id === null) || new Set(canonical).size !== ids.length) {
        context.addIssue({ code: "custom", message: "Invalid native scope identities." });
        return z.NEVER;
      }
      return (canonical as string[]).sort();
    });
export const nativeTaskScopeRequestSchema = nativeTaskScopeInputSchema.extend({
  attachmentIds: serverIdentities(MAX_TASK_ATTACHMENTS),
  collaboratorBotIds: serverIdentities(32),
});

export function emptyNativeTaskScope(): NativeTaskScopeInput {
  return {
    version: 1,
    attachmentIds: [],
    collaboratorBotIds: [],
    knowledge: false,
    plugins: false,
    web: false,
  };
}

export const ownerAttachmentSchema = z
  .object({
    ...attachmentMetadataSchema.shape,
    scopeKind: z.literal("owner"),
    ownerId: z.literal("owner"),
  })
  .omit({ channelId: true })
  .strict()
  .refine((file) => file.sizeBytes <= attachmentByteLimit(file.mediaType));
export type OwnerAttachment = z.infer<typeof ownerAttachmentSchema>;

export const nativeTaskScopeSchema = nativeTaskScopeInputSchema
  .extend({
    sha256: hash,
    attachments: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: attachmentMetadataSchema.shape.name,
            mediaType: attachmentMetadataSchema.shape.mediaType,
            sizeBytes: attachmentMetadataSchema.shape.sizeBytes,
            sha256: hash,
            metadataSha256: hash,
          })
          .strict()
          .refine((file) => file.sizeBytes <= attachmentByteLimit(file.mediaType)),
      )
      .max(MAX_TASK_ATTACHMENTS),
  })
  .strict()
  .refine(
    (scope) =>
      scope.attachments.length === scope.attachmentIds.length &&
      new Set(scope.attachments.map((file) => file.id)).size === scope.attachmentIds.length &&
      scope.attachments.every((file) => scope.attachmentIds.includes(file.id)) &&
      scope.attachments.reduce((total, file) => total + file.sizeBytes, 0) <=
        MAX_TASK_ATTACHMENT_BYTES,
  );
export type NativeTaskScope = z.infer<typeof nativeTaskScopeSchema>;
