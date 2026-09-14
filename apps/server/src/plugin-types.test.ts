import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import { checkPluginSchema } from "./plugin-types.js";

const forbidden = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "$id",
  "pattern",
  "patternProperties",
  "format",
  "x-mcp-header",
];
describe("plugin schema policy positions", () => {
  it("allows keyword-like business names and ordinary enum/const/default data", () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(forbidden.map((key) => [key, { type: "string" }])),
      required: forbidden,
      allOf: [{ properties: { format: { enum: ["csv", "json"] } } }],
      default: { pattern: "uninterpreted", $ref: "not a reference" },
    };
    expect(() => checkPluginSchema(schema)).not.toThrow();
    expect(
      new AjvJsonSchemaValidator().getValidator(schema)(
        Object.fromEntries(forbidden.map((key) => [key, key === "format" ? "csv" : "value"])),
      ).valid,
    ).toBe(true);
    for (const keyword of ["enum", "const", "default", "examples"])
      expect(() =>
        checkPluginSchema({
          type: "object",
          [keyword]:
            keyword === "enum" || keyword === "examples"
              ? [{ $ref: "plain", pattern: "data" }]
              : { $ref: "plain", pattern: "data" },
        }),
      ).not.toThrow();
  });

  it.each(forbidden)("rejects the actual %s keyword in every subschema position", (keyword) => {
    const child = { [keyword]: "blocked" };
    const wrappers: Record<string, unknown>[] = [
      child,
      { properties: { format: child } },
      { $defs: { format: child } },
      { definitions: { pattern: child } },
      { dependentSchemas: { format: child } },
      { dependencies: { pattern: child } },
      { items: child },
      { items: [child] },
      ...["allOf", "anyOf", "oneOf", "prefixItems"].map((name) => ({ [name]: [child] })),
      ...[
        "additionalProperties",
        "additionalItems",
        "contains",
        "propertyNames",
        "not",
        "if",
        "then",
        "else",
        "unevaluatedProperties",
        "unevaluatedItems",
      ].map((name) => ({ [name]: child })),
    ];
    for (const wrapper of wrappers)
      expect(() => checkPluginSchema({ type: "object", ...wrapper })).toThrow();
  });

  it("preserves bounds even inside ordinary data and rejects cycles before serialization", () => {
    let nested: unknown = "value";
    for (let depth = 0; depth < 13; depth++) nested = { value: nested };
    for (const schema of [
      { type: "object", default: nested },
      { type: "object", enum: Array.from({ length: 1000 }, () => 0) },
      { type: "object", description: "x".repeat(12 * 1024) },
      { type: "array", items: {} },
    ])
      expect(() => checkPluginSchema(schema)).toThrow();
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.default = cyclic;
    expect(() => checkPluginSchema(cyclic)).toThrow();
  });
});
