import { z } from "zod";
import { botSchema, controlHttpErrorSchema } from "./control-http.js";
import { employeeEvidenceReferenceSchema } from "./employee.js";
import { type HttpOperation, productHttpOperation as productOperation } from "./http-openapi.js";
import * as models from "./model-services.js";
import * as storage from "./storage-http.js";
import {
  transcriptionSettingsInputSchema,
  transcriptionSettingsSchema,
} from "./transcription-settings.js";

export const employeeModelResponseSchema = z.strictObject({
  employee: botSchema,
  details: z.strictObject({
    description: z.string(),
    revision: z.number().int().positive(),
    updatedAt: z.string(),
  }),
  evolution: z.strictObject({
    id: z.string(),
    botId: z.string(),
    type: z.literal("configuration_changed"),
    title: z.string(),
    summary: z.string(),
    source: z.literal("manual"),
    evidence: z.array(employeeEvidenceReferenceSchema),
    createdAt: z.string(),
  }),
});
export const resourceHttpSchemas = {
  CreateModelConnectionInput: models.createModelConnectionInputSchema,
  UpdateModelConnectionInput: models.updateModelConnectionInputSchema,
  VerifyModelConnectionInput: models.verifyModelConnectionInputSchema,
  DeleteModelConnectionInput: models.deleteModelConnectionInputSchema,
  TestModelConnectionInput: models.testModelConnectionInputSchema,
  UpdateEmployeeModelInput: models.updateEmployeeModelInputSchema,
  ModelConnectionResponse: models.modelConnectionResponseSchema,
  ModelConnection: models.modelConnectionSchema,
  ModelServicesSnapshot: models.modelServicesSnapshotSchema,
  ModelConnectionDeletion: models.modelConnectionDeletionSchema,
  ModelConnectionDeletionError: z.union([
    controlHttpErrorSchema,
    models.modelConnectionDeletionConflictSchema,
  ]),
  DiscoveredModels: models.discoveredModelsSchema,
  ModelConnectionTest: models.modelConnectionTestSchema,
  EmployeeModelResponse: employeeModelResponseSchema,
  TranscriptionSettings: transcriptionSettingsSchema,
  TranscriptionSettingsInput: transcriptionSettingsInputSchema,
  ChannelAttachmentsResponse: storage.channelAttachmentsResponseSchema,
  ChannelAttachmentResponse: storage.channelAttachmentResponseSchema,
  OwnerAttachmentsResponse: storage.ownerAttachmentsResponseSchema,
  OwnerAttachmentResponse: storage.ownerAttachmentResponseSchema,
  AttachmentProcessInput: storage.attachmentProcessInputSchema,
  EmptyAttachmentCommand: z.strictObject({}),
  AttachmentReferences: storage.attachmentReferencesSchema,
  AttachmentPurge: storage.attachmentPurgeSchema,
  TrashCleanupInput: storage.trashCleanupInputSchema,
  TrashCleanup: storage.trashCleanupSchema,
  StorageTrashCleanup: storage.storageTrashCleanupSchema,
  StorageSettingsInput: storage.storageSettingsInputSchema,
  StorageSettings: storage.storageSettingsSchema,
  StorageUsage: storage.storageUsageSchema,
} as const;

const attachmentErrors = [401, 403, 404, 408, 409, 410, 413, 415, 422, 503];
const uploadOptions = {
  status: 201,
  requestMediaType: "application/octet-stream" as const,
  maxBodyBytes: 10 * 1024 * 1024,
  headers: [
    {
      name: "x-openbot-filename",
      required: true,
      schema: {
        type: "string",
        minLength: 1,
        maxLength: 2048,
        description: "Percent-encoded UTF-8 filename",
      },
    },
  ],
  errors: attachmentErrors,
};
const channel = "/api/v1/channels/{channel_id}/attachments";
const owner = "/api/v1/task-attachments";
export const resourceHttpOperations: readonly HttpOperation[] = [
  productOperation("/api/v1/artifacts/{artifact_id}/content", "get", undefined, undefined, {
    responseMediaTypes: ["image/png", "text/markdown"],
    errors: [401, 404, 422, 503],
  }),
  productOperation("/api/v1/model-services", "get", "ModelServicesSnapshot"),
  productOperation(
    "/api/v1/model-connections",
    "post",
    "ModelConnectionResponse",
    "CreateModelConnectionInput",
    { status: 201, maxBodyBytes: 8192 },
  ),
  productOperation(
    "/api/v1/model-connections/verify",
    "post",
    "DiscoveredModels",
    "VerifyModelConnectionInput",
    { maxBodyBytes: 8192 },
  ),
  productOperation(
    "/api/v1/model-connections/{connection_id}",
    "patch",
    "ModelConnectionResponse",
    "UpdateModelConnectionInput",
    { maxBodyBytes: 4096 },
  ),
  productOperation(
    "/api/v1/model-connections/{connection_id}",
    "delete",
    "ModelConnectionDeletion",
    "DeleteModelConnectionInput",
    { maxBodyBytes: 1024, errorSchemas: { 409: "ModelConnectionDeletionError" } },
  ),
  productOperation(
    "/api/v1/model-connections/{connection_id}/models",
    "post",
    "DiscoveredModels",
    undefined,
    {
      maxBodyBytes: 1024,
    },
  ),
  productOperation(
    "/api/v1/model-connections/{connection_id}/test",
    "post",
    "ModelConnectionTest",
    "TestModelConnectionInput",
    { maxBodyBytes: 1024 },
  ),
  productOperation(
    "/api/v1/bots/{bot_id}/model",
    "patch",
    "EmployeeModelResponse",
    "UpdateEmployeeModelInput",
    { maxBodyBytes: 2048 },
  ),
  productOperation("/api/v1/settings/transcription", "get", "TranscriptionSettings"),
  productOperation(
    "/api/v1/settings/transcription",
    "put",
    "TranscriptionSettings",
    "TranscriptionSettingsInput",
    { maxBodyBytes: 1024, errors: attachmentErrors },
  ),
  productOperation("/api/v1/storage", "get", "StorageUsage"),
  productOperation("/api/v1/settings/storage", "get", "StorageSettings"),
  productOperation("/api/v1/settings/storage", "put", "StorageSettings", "StorageSettingsInput", {
    maxBodyBytes: 4096,
  }),
  productOperation(
    "/api/v1/storage/trash/cleanup",
    "post",
    "StorageTrashCleanup",
    "TrashCleanupInput",
    { maxBodyBytes: 4096 },
  ),
  productOperation(`${channel}/cleanup`, "post", "TrashCleanup", "TrashCleanupInput", {
    maxBodyBytes: 4096,
  }),
  productOperation(
    `${channel}/{attachment_id}/purge`,
    "delete",
    "AttachmentPurge",
    "EmptyAttachmentCommand",
    {
      requestRequired: false,
      maxBodyBytes: 32768,
      errors: attachmentErrors,
    },
  ),
  ...([channel, owner] as const).flatMap((base) => {
    const scope = base === channel ? "Channel" : "Owner";
    return [
      productOperation(base, "get", `${scope}AttachmentsResponse`, undefined, {
        errors: attachmentErrors,
      }),
      productOperation(base, "post", `${scope}AttachmentResponse`, undefined, uploadOptions),
      productOperation(`${base}/{attachment_id}`, "get", `${scope}AttachmentResponse`, undefined, {
        errors: attachmentErrors,
      }),
      productOperation(`${base}/{attachment_id}/content`, "get", undefined, undefined, {
        mediaType: "application/octet-stream",
        errors: attachmentErrors,
      }),
      productOperation(
        `${base}/{attachment_id}`,
        "delete",
        `${scope}AttachmentResponse`,
        scope === "Owner" ? "EmptyAttachmentCommand" : undefined,
        { requestRequired: false, maxBodyBytes: 32768, errors: attachmentErrors },
      ),
      productOperation(
        `${base}/{attachment_id}/restore`,
        "post",
        `${scope}AttachmentResponse`,
        scope === "Owner" ? "EmptyAttachmentCommand" : undefined,
        { requestRequired: false, maxBodyBytes: 32768, errors: attachmentErrors },
      ),
      productOperation(
        `${base}/{attachment_id}/process`,
        "post",
        `${scope}AttachmentResponse`,
        "AttachmentProcessInput",
        { maxBodyBytes: 4096, errors: attachmentErrors },
      ),
    ];
  }),
  productOperation(
    `${channel}/{attachment_id}/references`,
    "get",
    "AttachmentReferences",
    undefined,
    {
      query: [
        { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      ],
      errors: attachmentErrors,
    },
  ),
];
