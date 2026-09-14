import { createHash } from "node:crypto";
import type { PluginManifest, PluginPrompt, PluginResource, PluginTool } from "@openbot/protocol";

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

export class PluginError extends Error {
  constructor(
    public readonly code:
      | "invalid"
      | "unavailable"
      | "conflict"
      | "forbidden"
      | "not_found"
      | "rejected"
      | "expired",
    message?: string,
  ) {
    super(
      message ??
        {
          invalid: "插件配置或调用参数无效。",
          unavailable: "插件暂不可用，请检查服务。不会自动重试。",
          conflict: "插件声明或授权已变化，请重新检查。",
          forbidden: "当前员工没有这项插件授权。",
          not_found: "插件或待审批调用不存在。",
          rejected: "插件调用已被拒绝。",
          expired: "插件调用审批已过期。",
        }[code],
    );
  }
}

export function boundedJson(value: unknown, maximumBytes: number): string {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > maximumBytes) throw new PluginError("invalid");
  return text;
}

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

/** Schema positions follow JSON Schema; all data still consumes the same depth/node budget. */
export function checkPluginSchema(schema: Record<string, unknown>): void {
  type Position = "schema" | "schema-map" | "schema-array" | "dependencies" | "data";
  const forbidden = new Set([
    "$ref",
    "$dynamicRef",
    "$recursiveRef",
    "$id",
    "pattern",
    "patternProperties",
    "format",
    "x-mcp-header",
  ]);
  const maps = new Set(["properties", "$defs", "definitions", "dependentSchemas"]);
  const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const singles = new Set([
    "additionalProperties",
    "additionalItems",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "unevaluatedProperties",
    "unevaluatedItems",
  ]);
  let nodes = 0;
  const walk = (value: unknown, depth: number, position: Position): void => {
    if (depth > 12 || ++nodes > 1000) throw new PluginError("invalid");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value)
        walk(item, depth + 1, position === "schema-array" ? "schema" : "data");
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      let next: Position = "data";
      if (position === "schema") {
        if (forbidden.has(key))
          throw new PluginError("invalid", "插件参数结构含当前不支持的引用、正则或请求头扩展。");
        if (maps.has(key)) next = "schema-map";
        else if (arrays.has(key)) next = "schema-array";
        else if (key === "dependencies") next = "dependencies";
        else if (key === "items") next = Array.isArray(child) ? "schema-array" : "schema";
        else if (singles.has(key)) next = "schema";
      } else if (
        position === "schema-map" ||
        (position === "dependencies" && !Array.isArray(child))
      ) {
        next = "schema";
      }
      // Property names and enum/const/default/example values are data, not schema keywords.
      walk(child, depth + 1, next);
    }
  };
  if (schema.type !== "object") throw new PluginError("invalid");
  walk(schema, 0, "schema");
  boundedJson(schema, 12 * 1024);
}
