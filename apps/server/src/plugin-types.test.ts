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
  it.each([
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
  ])("rejects unsupported %s only in schema positions", (keyword) => {
    for (const schema of [
      { type: "object", [keyword]: true },
      { type: "object", properties: { value: { [keyword]: true } } },
      { type: "object", allOf: [{ [keyword]: true }] },
      { type: "object", definitions: { value: { [keyword]: true } } },
    ])
      expect(() => checkPluginSchema(schema)).toThrow(
        `Unsupported plugin schema keyword ${keyword}`,
      );
    const schema = {
      type: "object",
      properties: { [keyword]: { type: "string" } },
      default: { [keyword]: true },
      examples: [{ [keyword]: true }],
      allOf: [
        { enum: [{ [keyword]: "business data" }] },
        { const: { [keyword]: "business data" } },
      ],
    };
    expect(() => checkPluginSchema(schema)).not.toThrow();
    expect(
      new AjvJsonSchemaValidator().getValidator(schema)({ [keyword]: "business data" }).valid,
    ).toBe(true);
  });

  it.each([
    {
      keyword: "prefixItems",
      schema: { properties: { values: { type: "array", prefixItems: [{ const: "read" }] } } },
      input: { values: ["delete"] },
    },
    {
      keyword: "dependentRequired",
      schema: { dependentRequired: { present: ["required"] } },
      input: { present: true },
    },
    {
      keyword: "dependentSchemas",
      schema: { dependentSchemas: { present: { required: ["required"] } } },
      input: { present: true },
    },
    {
      keyword: "unevaluatedProperties",
      schema: { unevaluatedProperties: false },
      input: { unlisted: true },
    },
    {
      keyword: "unevaluatedItems",
      schema: {
        properties: {
          values: { type: "array", items: [{ const: "read" }], unevaluatedItems: false },
        },
      },
      input: { values: ["read", "delete"] },
    },
    {
      keyword: "minContains",
      schema: {
        properties: { values: { type: "array", contains: { const: "read" }, minContains: 2 } },
      },
      input: { values: ["read"] },
    },
    {
      keyword: "maxContains",
      schema: {
        properties: { values: { type: "array", contains: { const: "read" }, maxContains: 1 } },
      },
      input: { values: ["read", "read"] },
    },
  ])("fails closed when the pinned SDK would ignore $keyword", ({ keyword, schema, input }) => {
    const candidate = { type: "object", ...schema };
    expect(new AjvJsonSchemaValidator().getValidator(candidate)(input).valid).toBe(true);
    expect(() => checkPluginSchema(candidate)).toThrow(
      `Unsupported plugin schema keyword ${keyword}`,
    );
  });

  it("accepts only the documented explicit draft-07 dialect and preserves synchronous constraints", () => {
    const schema = {
      type: "object",
      properties: {
        $schema: { type: "string" },
        values: { type: "array", items: [{ const: "read" }], additionalItems: false },
      },
      dependencies: { values: ["$schema"] },
      additionalProperties: false,
    };
    for (const dialect of [
      undefined,
      "http://json-schema.org/draft-07/schema",
      "http://json-schema.org/draft-07/schema#",
    ]) {
      const candidate = { ...schema, ...(dialect === undefined ? {} : { $schema: dialect }) };
      expect(() => checkPluginSchema(candidate)).not.toThrow();
      const validate = new AjvJsonSchemaValidator().getValidator(candidate);
      expect(validate({ $schema: "business data", values: ["read"] }).valid).toBe(true);
      expect(validate({ $schema: "business data", values: ["read", "delete"] }).valid).toBe(false);
      expect(validate({ values: ["read"] }).valid).toBe(false);
    }
    for (const dialect of [
      "https://json-schema.org/draft/2020-12/schema",
      "https://json-schema.org/draft/2019-09/schema",
      "http://json-schema.org/draft-04/schema#",
      "https://example.com/custom",
      true,
    ])
      for (const candidate of [
        { type: "object", $schema: dialect },
        { type: "object", properties: { value: { $schema: dialect } } },
      ])
        expect(() => checkPluginSchema(candidate)).toThrow("Unsupported plugin schema dialect");
  });

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
