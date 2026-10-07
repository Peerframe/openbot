import {
  createChannelInputSchema,
  createMessageInputSchema,
  joinChannelBotInputSchema,
} from "./channel-inputs.js";
import * as control from "./control-http.js";
import { createBotInputSchema, quickCreateBotInputSchema } from "./employee.js";
import { type HttpOperation, httpOpenApi } from "./http-openapi.js";
import { lifecycleHttpOperations, lifecycleHttpSchemas } from "./lifecycle-http.js";
import { employeeHttpOperations, employeeHttpSchemas } from "./employee-http.js";
import { automationHttpOperations, automationHttpSchemas } from "./automation-http.js";
import { nodeHttpOperations, nodeHttpSchemas } from "./node-http.js";
import { pluginHttpOperations, pluginHttpSchemas } from "./plugin-http.js";
import { browserHttpOperations, browserHttpSchemas } from "./browser-http.js";
import { portabilityHttpOperations, portabilityHttpSchemas } from "./portability-http.js";
import { resourceHttpOperations, resourceHttpSchemas } from "./model-storage-openapi.js";
import { ownerPreferencesInputSchema, ownerPreferencesSchema } from "./owner-preferences.js";
import {
  ownerPasswordChangeResponseSchema,
  ownerSessionRevocationResponseSchema,
  ownerSessionsResponseSchema,
} from "./owner-security.js";
import { workHttpOperations, workHttpSchemas } from "./work-openapi.js";
import {
  workspacePrimaryBotInputSchema,
  workspacePrimaryBotSchema,
} from "./workspace-primary-bot.js";

export const controlHttpSchemas = {
  LoginInput: control.loginRequestSchema,
  LoginResponse: control.loginResponseSchema,
  AuthSession: control.authSessionSchema,
  PasswordChangeInput: control.ownerPasswordChangeRequestSchema,
  PasswordChangeResponse: ownerPasswordChangeResponseSchema,
  OwnerSessionsResponse: ownerSessionsResponseSchema,
  RevokeSessionsResponse: ownerSessionRevocationResponseSchema,
  CreateBotInput: createBotInputSchema,
  QuickCreateBotInput: quickCreateBotInputSchema,
  CreateChannelInput: createChannelInputSchema,
  JoinChannelInput: joinChannelBotInputSchema,
  CreateMessageInput: createMessageInputSchema,
  Bot: control.botSchema,
  Channel: control.channelSchema,
  Message: control.messageSchema,
  BotResponse: control.botResponseSchema,
  QuickBotResponse: control.quickBotResponseSchema,
  ChannelResponse: control.channelResponseSchema,
  BotsResponse: control.botsResponseSchema,
  ChannelsResponse: control.channelsResponseSchema,
  MessagesResponse: control.messagesResponseSchema,
  Run: control.runSchema,
  RunUsage: control.runModelUsageSchema,
  RunsResponse: control.runsResponseSchema,
  SubmitTaskResult: control.submitTaskResponseSchema,
  WorkspaceSnapshot: control.workspaceSnapshotSchema,
  Bootstrap: control.bootstrapSchema,
  WorkspacePrimaryBotInput: workspacePrimaryBotInputSchema,
  WorkspacePrimaryBot: workspacePrimaryBotSchema,
  OwnerPreferencesInput: ownerPreferencesInputSchema,
  OwnerPreferences: ownerPreferencesSchema,
  RunProgressDetails: control.runProgressDetailsSchema,
  WorkspaceReady: control.workspaceReadySchema,
  ChannelReady: control.channelReadySchema,
  ChannelMessageCreated: control.channelMessageCreatedSchema,
  EmployeeProfileChanged: control.employeeProfileChangedSchema,
  ControlHttpError: control.controlHttpErrorSchema,
} as const;

// Operation IDs retain the actual Python registrations, including the generated product IDs.
// The registry is phase coverage, never routing/authorization; services still enforce authority.
export const controlHttpOperations: readonly HttpOperation[] = [
  {
    method: "get",
    path: "/api/v1/auth/session",
    operationId: "getOwnerSession",
    status: 200,
    response: "AuthSession",
    owner: false,
  },
  {
    method: "post",
    path: "/api/v1/auth/login",
    operationId: "loginOwner",
    status: 200,
    request: "LoginInput",
    response: "LoginResponse",
    maxBodyBytes: 8192,
    owner: false,
    errors: [400, 401, 403, 408, 413, 422, 429, 503],
  },
  { method: "post", path: "/api/v1/auth/logout", operationId: "logoutOwner", status: 204 },
  {
    method: "get",
    path: "/api/v1/auth/sessions",
    operationId: "listOwnerSessions",
    status: 200,
    response: "OwnerSessionsResponse",
  },
  {
    method: "post",
    path: "/api/v1/auth/sessions/revoke-others",
    operationId: "revokeOtherOwnerSessions",
    status: 200,
    response: "RevokeSessionsResponse",
  },
  {
    method: "post",
    path: "/api/v1/auth/password",
    operationId: "changeOwnerPassword",
    status: 200,
    request: "PasswordChangeInput",
    response: "PasswordChangeResponse",
    maxBodyBytes: 8192,
    errors: [400, 401, 403, 408, 413, 422, 429, 503],
  },
  {
    method: "get",
    path: "/api/v1/bots",
    operationId: "listBots",
    status: 200,
    response: "BotsResponse",
  },
  {
    method: "post",
    path: "/api/v1/bots",
    operationId: "createBot",
    status: 201,
    request: "CreateBotInput",
    response: "BotResponse",
    maxBodyBytes: 8192,
  },
  {
    method: "post",
    path: "/api/v1/bots/quick",
    operationId: "quickCreateBot",
    status: 201,
    request: "QuickCreateBotInput",
    response: "QuickBotResponse",
    maxBodyBytes: 8192,
  },
  {
    method: "get",
    path: "/api/v1/channels",
    operationId: "listChannels",
    status: 200,
    response: "ChannelsResponse",
  },
  {
    method: "post",
    path: "/api/v1/channels",
    operationId: "createChannel",
    status: 201,
    request: "CreateChannelInput",
    response: "ChannelResponse",
    maxBodyBytes: 8192,
  },
  {
    method: "post",
    path: "/api/v1/bots/{bot_id}/conversation",
    operationId: "getOrCreateDirectConversation",
    status: 200,
    response: "ChannelResponse",
  },
  {
    method: "post",
    path: "/api/v1/channels/{channel_id}/bots",
    operationId: "joinBotToChannel",
    status: 200,
    request: "JoinChannelInput",
    response: "ChannelResponse",
    maxBodyBytes: 8192,
  },
  {
    method: "get",
    path: "/api/v1/channels/{channel_id}/messages",
    operationId: "listMessages",
    status: 200,
    response: "MessagesResponse",
    query: [
      { name: "before", schema: { type: "string", maxLength: 2048 } },
      { name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 100 } },
    ],
  },
  {
    method: "post",
    path: "/api/v1/channels/{channel_id}/messages",
    operationId: "submitTask",
    status: 201,
    request: "CreateMessageInput",
    response: "SubmitTaskResult",
    maxBodyBytes: 131072,
  },
  {
    method: "get",
    path: "/api/v1/channels/{channel_id}/runs",
    operationId: "listRuns",
    status: 200,
    response: "RunsResponse",
  },
  {
    method: "get",
    path: "/api/v1/workspace",
    operationId: "endpoint_api_v1_workspace_get",
    status: 200,
    response: "WorkspaceSnapshot",
  },
  {
    method: "get",
    path: "/api/v1/bootstrap",
    operationId: "endpoint_api_v1_bootstrap_get",
    status: 200,
    response: "Bootstrap",
  },
  {
    method: "put",
    path: "/api/v1/workspace/primary-bot",
    operationId: "endpoint_api_v1_workspace_primary_bot_put",
    status: 200,
    request: "WorkspacePrimaryBotInput",
    response: "WorkspacePrimaryBot",
    maxBodyBytes: 1024,
  },
  {
    method: "get",
    path: "/api/v1/settings/general",
    operationId: "endpoint_api_v1_settings_general_get",
    status: 200,
    response: "OwnerPreferences",
  },
  {
    method: "put",
    path: "/api/v1/settings/general",
    operationId: "endpoint_api_v1_settings_general_put",
    status: 200,
    request: "OwnerPreferencesInput",
    response: "OwnerPreferences",
    maxBodyBytes: 2048,
  },
  {
    method: "get",
    path: "/api/v1/runs/{run_id}/progress",
    operationId: "endpoint_api_v1_runs__run_id__progress_get",
    status: 200,
    response: "RunProgressDetails",
    query: [
      {
        name: "steps",
        schema: { type: "string", pattern: "^[1-9][0-9]{0,6}(?:,[1-9][0-9]{0,6}){0,11}$" },
      },
    ],
  },
  {
    method: "get",
    path: "/api/v1/workspace/events",
    operationId: "workspace_events_api_v1_workspace_events_get",
    status: 200,
    mediaType: "text/event-stream",
  },
  {
    method: "get",
    path: "/api/v1/channels/{channel_id}/events",
    operationId: "channel_events_api_v1_channels__channel_id__events_get",
    status: 200,
    mediaType: "text/event-stream",
  },
];

export function controlHttpOpenApi() {
  return httpOpenApi(
    "OpenBot Control HTTP",
    {
      ...workHttpSchemas,
      ...controlHttpSchemas,
      ...resourceHttpSchemas,
      ...lifecycleHttpSchemas,
      ...employeeHttpSchemas,
      ...automationHttpSchemas,
      ...nodeHttpSchemas,
      ...pluginHttpSchemas,
      ...browserHttpSchemas,
      ...portabilityHttpSchemas,
    },
    [
      ...workHttpOperations,
      ...controlHttpOperations,
      ...resourceHttpOperations,
      ...lifecycleHttpOperations,
      ...employeeHttpOperations,
      ...automationHttpOperations,
      ...nodeHttpOperations,
      ...pluginHttpOperations,
      ...browserHttpOperations,
      ...portabilityHttpOperations,
    ],
    "ControlHttpError",
  );
}
