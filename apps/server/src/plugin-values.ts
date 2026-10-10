/** Validates bounded plugin records and canonical state shared by transport and storage. */
import { createHash } from "node:crypto";
import {
  installedPluginHttpSchema,
  pluginManifestHttpSchema,
  pluginPromptHttpSchema,
  pluginResourceHttpSchema,
  pluginToolHttpSchema,
} from "@openbot/protocol";
import { Ajv } from "ajv";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { refuse } from "./owner-transaction.js";
export function pluginError(
  code: "invalid" | "unavailable" | "conflict" | "forbidden" | "not_found" | "rejected" | "expired",
): never {
  return refuse(
    {
      invalid: 400,
      unavailable: 503,
      conflict: 409,
      forbidden: 403,
      not_found: 404,
      rejected: 409,
      expired: 409,
    }[code],
    code,
  );
}
export function pluginBytes(value: unknown, maximum: number): Buffer {
  try {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length <= maximum) return bytes;
  } catch {}
  return pluginError("invalid");
}
export function pluginParse<T>(schema: z.ZodType<T>, value: unknown, maximum = 24576): T {
  pluginBytes(value, maximum);
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : pluginError("invalid");
}
const scalar = z.string().refine((s) => !/[\ud800-\udfff]/u.test(s));
export const pluginStateSchema = z.strictObject({
  plugins: z
    .array(
      installedPluginHttpSchema.extend({
        token: scalar.refine((s) => s.length <= 2048).optional(),
      }),
    )
    .max(16),
  audit: z
    .array(
      z.strictObject({
        at: z.string(),
        phase: scalar.refine((s) => s.length <= 64),
        pluginId: z.string(),
        botId: z.string().optional(),
        runId: z.string().optional(),
        callId: z.string().optional(),
        toolName: z.string().optional(),
      }),
    )
    .max(500),
});
export type PluginState = z.infer<typeof pluginStateSchema>;
export type Plugin = PluginState["plugins"][number];
export function publicPlugin(plugin: Plugin) {
  const { token: _token, ...value } = plugin;
  return structuredClone(value);
}
export function pluginAudit(
  state: PluginState,
  phase: string,
  id: string,
  ids: Partial<PluginState["audit"][number]> = {},
) {
  state.audit.push({ at: new Date().toISOString(), phase, pluginId: id, ...ids });
  state.audit = state.audit.slice(-500);
}
const forbidden = new Set([
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "$id",
  "pattern",
  "patternProperties",
  "format",
  "x-mcp-header",
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
const maps = new Set(["properties", "$defs", "definitions"]),
  arrays = new Set(["allOf", "anyOf", "oneOf"]),
  singles = new Set([
    "additionalProperties",
    "additionalItems",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
  ]);
export function pluginValidator<T = unknown>(schema: Record<string, unknown>) {
  if (!schema || Array.isArray(schema) || schema.type !== "object") return pluginError("invalid");
  pluginBytes(schema, 12288);
  let count = 0;
  function walk(value: unknown, depth: number, position: string) {
    if (depth > 12 || ++count > 1000) pluginError("invalid");
    if (Array.isArray(value)) {
      for (const child of value)
        walk(child, depth + 1, position === "schema-array" ? "schema" : "data");
    } else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        let next = "data";
        if (position === "schema") {
          if (
            forbidden.has(key) ||
            (key === "$schema" &&
              ![
                "http://json-schema.org/draft-07/schema#",
                "http://json-schema.org/draft-07/schema",
              ].includes(child as string))
          )
            pluginError("invalid");
          if (maps.has(key)) next = "schema-map";
          else if (arrays.has(key)) next = "schema-array";
          else if (key === "dependencies") next = "dependencies";
          else if (key === "items") next = Array.isArray(child) ? "schema-array" : "schema";
          else if (singles.has(key)) next = "schema";
        } else if (
          position === "schema-map" ||
          (position === "dependencies" && !Array.isArray(child))
        )
          next = "schema";
        walk(child, depth + 1, next);
      }
  }
  walk(schema, 0, "schema");
  // Fresh provider: no imported schema identifiers or cross-plugin compiled schema cache.
  try {
    return new AjvJsonSchemaValidator(
      new Ajv({
        strict: false,
        validateFormats: false,
        validateSchema: true,
        allErrors: false,
        logger: false,
      }),
    ).getValidator<T>(schema);
  } catch {
    return pluginError("invalid");
  }
}
export function pluginManifest(
  name: string,
  endpoint: string,
  rawTools: unknown[],
  rawResources: unknown[],
  rawPrompts: unknown[],
) {
  const tools = rawTools.map((v) => pluginParse(pluginToolHttpSchema, v)),
    resources = rawResources.map((v) => pluginParse(pluginResourceHttpSchema, v)),
    prompts = rawPrompts.map((v) => pluginParse(pluginPromptHttpSchema, v));
  if (!tools.length && !resources.length && !prompts.length) pluginError("invalid");
  for (const names of [
    tools.map((v) => v.name),
    resources.map((v) => v.uri),
    prompts.map((v) => v.name),
  ])
    if (names.length > 32 || new Set(names).size !== names.length) pluginError("invalid");
  for (const tool of tools) pluginValidator(tool.inputSchema);
  for (const prompt of prompts)
    if (new Set(prompt.arguments.map((v) => v.name)).size !== prompt.arguments.length)
      pluginError("invalid");
  const compare = (a: string, b: string) => a.localeCompare(b, "en-US");
  tools.sort((a, b) => compare(a.name, b.name));
  resources.sort((a, b) => compare(a.uri, b.uri));
  prompts.sort((a, b) => compare(a.name, b.name));
  const body = {
    name,
    endpoint,
    tools,
    ...(resources.length ? { resources } : {}),
    ...(prompts.length ? { prompts } : {}),
  };
  function canonical(v: any): any {
    return Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => compare(a, b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  }
  const digest = createHash("sha256")
    .update(pluginBytes(canonical(body), 65536))
    .digest("hex");
  return pluginParse(pluginManifestHttpSchema, { ...body, digest }, 65536);
}
