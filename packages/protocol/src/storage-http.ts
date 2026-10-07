import { z } from "zod";
import {
  attachmentByteLimit,
  attachmentMetadataSchema,
  attachmentOperations,
} from "./attachments.js";
import { runStatusSchema } from "./control-http.js";
import { ownerAttachmentSchema } from "./native-task.js";

export const attachmentReferenceCountSchema = z.strictObject({
  messages: z.number().int().min(0).max(10000),
  tasks: z.number().int().min(0).max(10000),
});
const listedAttachmentSchema = z
  .strictObject({
    ...attachmentMetadataSchema.shape,
    referenceCount: attachmentReferenceCountSchema,
  })
  .refine((file) => file.sizeBytes <= attachmentByteLimit(file.mediaType));
export const channelAttachmentsResponseSchema = z.strictObject({
  attachments: z.array(listedAttachmentSchema).max(1024),
});
export const channelAttachmentResponseSchema = z.strictObject({
  attachment: attachmentMetadataSchema,
});
export const ownerAttachmentsResponseSchema = z.strictObject({
  attachments: z.array(ownerAttachmentSchema).max(1024),
});
export const ownerAttachmentResponseSchema = z.strictObject({ attachment: ownerAttachmentSchema });
export const attachmentProcessInputSchema = z.strictObject({
  operation: z.enum(attachmentOperations),
  password: z
    .string()
    .max(256)
    .refine((value) => value.length <= 256 && !/[\ud800-\udfff]/u.test(value))
    .meta({ "x-openbot-max-utf16-units": 256 })
    .optional(),
});
export const attachmentReferencesSchema = z.strictObject({
  messages: z
    .array(
      z.strictObject({
        id: z.string(),
        createdAt: z.string(),
        author: z.strictObject({
          kind: z.enum(["owner", "bot", "system"]),
          botId: z.string().optional(),
        }),
        preview: z.string().max(120),
      }),
    )
    .max(100),
  tasks: z
    .array(
      z.strictObject({
        runId: z.string(),
        title: z.string().max(160),
        status: runStatusSchema,
        createdAt: z.string(),
      }),
    )
    .max(100),
  messageCount: z.number().int().min(0).max(10000),
  taskCount: z.number().int().min(0).max(10000),
  hasMore: z.boolean(),
});
export const attachmentPurgeSchema = z.strictObject({
  id: z.string(),
  purged: z.literal(true),
  freedBytes: z.number().int().nonnegative(),
});
// The legacy storage parser accepts canonical UUID strings without imposing UUID version bits.
export const trashCleanupInputSchema = z.strictObject({
  requestKey: z
    .string()
    .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)
    .transform((value) => value.toLowerCase()),
});
export const trashCleanupSchema = z.strictObject({
  removed: z.number().int().nonnegative(),
  retained: z
    .array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        referenceCount: attachmentReferenceCountSchema,
      }),
    )
    .max(100),
  retainedCount: z.number().int().nonnegative(),
  retainedHasMore: z.boolean(),
  freedBytes: z.number().int().nonnegative(),
});
export const storageTrashCleanupSchema = trashCleanupSchema.extend({
  channelCount: z.number().int().nonnegative(),
});
export const storageSettingsInputSchema = z.strictObject({
  expectedRevision: z
    .number()
    .int()
    .min(1)
    .max(2147483647)
    .meta({ "x-openbot-json-integer-token": true }),
  trashAutoPurgeDays: z.literal(30).nullable(),
});
export const storageSettingsSchema = z.strictObject({
  revision: z.number().int().min(1).max(2147483647),
  trashAutoPurgeDays: z.literal(30).nullable(),
  updatedAt: z.string(),
  lastAutoPurgeAt: z.string().nullable(),
});
export const storageCategorySchema = z.strictObject({
  sizeBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative().optional(),
});
export const storageUsageSchema = z.strictObject({
  totalBytes: z.number().int().nonnegative(),
  measuredAt: z.string(),
  categories: z.strictObject({
    channelFiles: storageCategorySchema,
    trash: storageCategorySchema,
    ownerTaskFiles: storageCategorySchema,
    taskOutputs: storageCategorySchema.nullable(),
    retainedRunOutputs: storageCategorySchema.nullable(),
    other: storageCategorySchema,
    database: storageCategorySchema,
    workingComputerBrowserData: z.null(),
  }),
  trash: z.strictObject({
    fileCount: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    referencedFileCount: z.number().int().nonnegative(),
    referencedSizeBytes: z.number().int().nonnegative(),
  }),
  topChannels: z
    .array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        deleted: z.boolean(),
        sizeBytes: z.number().int().nonnegative(),
        fileCount: z.number().int().nonnegative(),
      }),
    )
    .max(20),
  topChannelsLimit: z.literal(20),
});
export type StorageCategory = z.infer<typeof storageCategorySchema>;
export type StorageUsage = z.infer<typeof storageUsageSchema>;
export type StorageSettings = z.infer<typeof storageSettingsSchema>;
export type StorageSettingsInput = z.infer<typeof storageSettingsInputSchema>;
export type AttachmentPurgeResult = z.infer<typeof attachmentPurgeSchema>;
export type TrashCleanupResult = z.infer<typeof trashCleanupSchema>;
