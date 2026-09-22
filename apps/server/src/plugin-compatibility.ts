import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

/** This author-facing policy is shared with the Server; it never grants authority. */
export type PluginCompatibilityReason =
  | "authentication_required"
  | "access_denied"
  | "transport_unsupported"
  | "protocol_unsupported"
  | "schema_unsupported"
  | "execution_unsupported"
  | "catalog_unsupported"
  | "result_unsupported"
  | "timeout"
  | "cancelled";

const compatibilityMessages: Record<PluginCompatibilityReason, string> = {
  authentication_required: "插件需要有效的专用 bearer token；当前不支持 OAuth 登录。",
  access_denied: "插件服务拒绝访问，请检查 token 权限或服务端访问策略。",
  transport_unsupported:
    "插件需要可直接访问的 Streamable HTTP MCP 地址，不支持跳转或旧版 SSE 地址。",
  protocol_unsupported: "插件协商的协议版本不受当前 MCP SDK 支持。",
  schema_unsupported: "插件 schema 不符合当前同步 draft-07 子集或超出大小限制。",
  execution_unsupported: "插件工具要求 task 执行模式，当前仅支持直接工具调用。",
  catalog_unsupported: "插件工具目录不符合名称、数量或完整单页要求。",
  result_unsupported: "插件工具结果必须为有界文本和可选结构化 JSON。",
  timeout: "插件连接或请求已超时；不会自动重试。",
  cancelled: "插件检查已取消；不会自动重试。",
};

export function pluginCompatibilityError(
  reason: PluginCompatibilityReason,
  code: "invalid" | "unavailable" = "invalid",
): PluginError {
  return new PluginError(code, compatibilityMessages[reason], reason);
}

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
    public readonly compatibility?: PluginCompatibilityReason,
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
  // SDK 1.30 uses synchronous draft-07 Ajv. Ignored newer constraints must not look validated;
  // $async would return a Promise that the SDK's synchronous adapter mistakes for success.
  const unsupported = new Set([
    "$async",
    "$anchor",
    "$dynamicAnchor",
    "$recursiveAnchor",
    "$vocabulary",
    "dependentRequired",
    "dependentSchemas",
    "prefixItems",
    "minContains",
    "maxContains",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
    "discriminator",
  ]);
  const maps = new Set(["properties", "$defs", "definitions"]);
  const arrays = new Set(["allOf", "anyOf", "oneOf"]);
  const singles = new Set([
    "additionalProperties",
    "additionalItems",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
  ]);
  let nodes = 0;
  const walk = (value: unknown, depth: number, position: Position): void => {
    if (depth > 12 || ++nodes > 1000)
      throw new PluginError("invalid", undefined, "schema_unsupported");
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
          throw new PluginError(
            "invalid",
            "插件参数结构含当前不支持的引用、正则或请求头扩展。",
            "schema_unsupported",
          );
        if (unsupported.has(key))
          throw new PluginError(
            "invalid",
            `Unsupported plugin schema keyword ${key}; use OpenBot's synchronous draft-07 subset.`,
            "schema_unsupported",
          );
        if (
          key === "$schema" &&
          child !== "http://json-schema.org/draft-07/schema#" &&
          child !== "http://json-schema.org/draft-07/schema"
        )
          throw new PluginError(
            "invalid",
            "Unsupported plugin schema dialect; omit $schema or use http://json-schema.org/draft-07/schema#.",
            "schema_unsupported",
          );
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
  if (schema.type !== "object") throw new PluginError("invalid", undefined, "schema_unsupported");
  walk(schema, 0, "schema");
  try {
    boundedJson(schema, 12 * 1024);
  } catch {
    throw pluginCompatibilityError("schema_unsupported");
  }
}

export function pluginFailure(error: unknown, signal?: AbortSignal): PluginError {
  if (error instanceof PluginError) return error;
  if (signal?.aborted)
    return pluginCompatibilityError(
      signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
      "unavailable",
    );
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
    return pluginCompatibilityError("timeout", "unavailable");
  // SDK 1.30.0 exposes negotiation failure as Error; never reflect its remote version string.
  if (
    error instanceof Error &&
    error.message.startsWith("Server's protocol version is not supported:")
  )
    return pluginCompatibilityError("protocol_unsupported");
  return new PluginError("unavailable");
}

export function checkPluginHttpResponse(status: number, contentType: string): void {
  if (status === 401) throw pluginCompatibilityError("authentication_required", "unavailable");
  if (status === 403) throw pluginCompatibilityError("access_denied", "unavailable");
  if (status === 205 || (status >= 300 && status < 400) || status === 404 || status === 405)
    throw pluginCompatibilityError("transport_unsupported", "unavailable");
  if (status >= 400) throw new PluginError("unavailable");
  if (
    ![202, 204].includes(status) &&
    !/^(?:application\/json|text\/event-stream)(?:\s*;|$)/iu.test(contentType)
  )
    throw pluginCompatibilityError("transport_unsupported", "unavailable");
}

export function createPluginMcpClient(): Client {
  return new Client(
    { name: "openbot", version: "0.1.0" },
    {
      capabilities: {},
      jsonSchemaValidator: {
        getValidator(schema) {
          checkPluginSchema(schema as Record<string, unknown>);
          try {
            return new AjvJsonSchemaValidator().getValidator(schema);
          } catch {
            throw pluginCompatibilityError("schema_unsupported");
          }
        },
      },
    },
  );
}

export async function listCompatiblePluginTools(client: Client, signal: AbortSignal) {
  if (!client.getServerCapabilities()?.tools) return [];
  try {
    const result = await client.listTools({}, { signal, timeout: 30_000 });
    if (
      result.nextCursor ||
      result.tools.length > 32 ||
      new Set(result.tools.map((tool) => tool.name)).size !== result.tools.length
    )
      throw pluginCompatibilityError("catalog_unsupported");
    for (const tool of result.tools) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(tool.name) || (tool.description?.length ?? 0) > 2000)
        throw pluginCompatibilityError("catalog_unsupported");
      if (tool.execution?.taskSupport === "required")
        throw pluginCompatibilityError("execution_unsupported");
      checkPluginSchema(tool.inputSchema);
      try {
        new AjvJsonSchemaValidator().getValidator(tool.inputSchema as Record<string, unknown>);
      } catch {
        throw pluginCompatibilityError("schema_unsupported");
      }
    }
    return result.tools;
  } catch (error) {
    throw pluginFailure(error, signal);
  }
}

export function checkPluginToolResult(value: unknown) {
  const parsed = CallToolResultSchema.safeParse(value);
  if (!parsed.success) throw pluginCompatibilityError("result_unsupported", "unavailable");
  const result = parsed.data;
  if (result.isError) throw new PluginError("unavailable");
  if (result.content.some((item) => item.type !== "text"))
    throw pluginCompatibilityError("result_unsupported", "unavailable");
  const output = {
    content: result.content.map((item) => ({
      type: "text" as const,
      text: item.type === "text" ? item.text : "",
    })),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
  try {
    boundedJson(output, 12 * 1024);
  } catch {
    throw pluginCompatibilityError("result_unsupported", "unavailable");
  }
  return output;
}
