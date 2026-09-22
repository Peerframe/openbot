import { createHash } from "node:crypto";
import type { PluginManifest, PluginPrompt, PluginResource, PluginTool } from "@openbot/protocol";
import { boundedJson, PluginError } from "./plugin-compatibility.js";

// Compatibility entry point: public data contracts are owned by the shared protocol package.
export {
  applyPluginUpdateSchema,
  callPluginSchema,
  decidePluginCallSchema,
  grantPluginSchema,
  type InstalledPlugin,
  installPluginSchema,
  type PendingPluginCall,
  type PluginCatalogItem,
  type PluginEndpointInput,
  type PluginManifest,
  type PluginPrompt,
  type PluginResource,
  type PluginTool,
  type PluginToolGrant,
  pluginEndpointInputSchema,
  pluginPromptResultSchema,
  pluginPromptSchema,
  pluginResourceResultSchema,
  pluginResourceSchema,
  pluginToolGrantSchema,
  pluginToolSchema,
  readPluginContentSchema,
  removePluginSchema,
  toolName,
  updatePluginSchema,
} from "@openbot/protocol";
export { boundedJson, checkPluginSchema, PluginError } from "./plugin-compatibility.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function pluginManifest(
  name: string,
  endpoint: string,
  tools: PluginTool[],
  resources: PluginResource[] = [],
  prompts: PluginPrompt[] = [],
): PluginManifest {
  const ordered = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  if (
    !(ordered.length + resources.length + prompts.length) ||
    ordered.length > 32 ||
    new Set(ordered.map((tool) => tool.name)).size !== ordered.length
  )
    throw new PluginError("invalid");
  if (
    resources.length > 32 ||
    prompts.length > 32 ||
    new Set(resources.map((item) => item.uri)).size !== resources.length ||
    new Set(prompts.map((item) => item.name)).size !== prompts.length ||
    prompts.some(
      (item) => new Set(item.arguments.map((arg) => arg.name)).size !== item.arguments.length,
    )
  )
    throw new PluginError("invalid");
  const body = {
    name,
    endpoint,
    tools: ordered,
    ...(resources.length
      ? { resources: [...resources].sort((a, b) => a.uri.localeCompare(b.uri)) }
      : {}),
    ...(prompts.length
      ? { prompts: [...prompts].sort((a, b) => a.name.localeCompare(b.name)) }
      : {}),
  };
  const digest = createHash("sha256")
    .update(boundedJson(canonical(body), 64 * 1024))
    .digest("hex");
  return { ...body, digest };
}
