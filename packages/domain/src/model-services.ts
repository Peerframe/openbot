export type ModelApiProtocol = "openai-chat" | "anthropic-messages";

export interface ModelConnectionPreset {
  id: string;
  name: string;
  protocol: ModelApiProtocol;
  endpoints: Array<{ name: string; baseUrl: string }>;
  suggestedModels: string[];
  discovery: boolean;
  description: string;
  docsUrl: string;
}

export interface ModelSelection {
  connectionId: string;
  modelId: string;
}

/** Public projection only. Credentials never belong in workspace or Employee DTOs. */
export interface ModelConnection {
  id: string;
  name: string;
  presetId: string;
  baseUrl: string;
  protocol: ModelApiProtocol;
  enabled: boolean;
  hasApiKey: boolean;
  revision: number;
  source: "saved" | "environment";
  defaultModel?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ModelServicesSnapshot {
  presets: ModelConnectionPreset[];
  connections: ModelConnection[];
  customBaseUrls: string[];
}

export interface CreateModelConnectionInput {
  name: string;
  presetId: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string | null | undefined;
}

export interface UpdateModelConnectionInput {
  expectedRevision: number;
  name?: string | undefined;
  apiKey?: string | undefined;
  enabled?: boolean | undefined;
  defaultModel?: string | null | undefined;
}

export interface VerifyModelConnectionInput {
  presetId: string;
  baseUrl: string;
  apiKey: string;
}

export interface DeleteModelConnectionInput {
  expectedRevision: number;
}

export interface ModelConnectionDependencies {
  bots: Array<{ id: string; name: string }>;
  runIds: string[];
  ownerDefault: boolean;
}

export interface ModelConnectionDeletionConflict extends ModelConnectionDependencies {
  error: "model_connection_in_use";
}

export interface UpdateEmployeeModelInput {
  expectedRevision: number;
  model: ModelSelection | null;
}
