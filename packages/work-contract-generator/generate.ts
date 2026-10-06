import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { controlHttpOpenApi, workHttpOpenApi } from "@openbot/protocol";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";

const argv = process.argv.slice(2);
if (argv.length > 1 || argv.some((arg) => arg !== "--check")) {
  throw new Error("Only --check is supported.");
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const document = workHttpOpenApi();
const schema = `${JSON.stringify(document, null, 2)}\n`;
const controlSchema = `${JSON.stringify(controlHttpOpenApi(), null, 2)}\n`;
const jsonValueReferences = new Set<string>();
function collectJsonValueReferences(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Reflect.get(value, "x-openbot-json-value") === true) {
    const reference = Reflect.get(value, "$ref");
    if (typeof reference === "string") jsonValueReferences.add(reference);
  }
  for (const child of Object.values(value)) collectJsonValueReferences(child);
}
collectJsonValueReferences(document);
const ast = await openapiTS(schema, {
  alphabetize: true,
  defaultNonNullable: false,
  // Recursive JSON values cannot be expressed as a self-indexed interface property (TS2502).
  // Only the trusted shared schema marker maps to its inferred type; keep the JSON Schema intact.
  postTransform(_type, metadata) {
    if (jsonValueReferences.has(metadata.path ?? "")) {
      return ts.factory.createTypeReferenceNode("WorkJsonValue");
    }
  },
});
const generated =
  "// Generated from @openbot/protocol Work HTTP contracts. Run npm run contracts:generate.\n" +
  'import type { WorkJsonValue } from "@openbot/protocol";\n' +
  astToString(ast);
const output = new URL("../../apps/web/src/generated/work-contract.ts", import.meta.url);
const openapiOutput = new URL("../protocol/generated/work-openapi.json", import.meta.url);
const controlOutput = new URL("../protocol/generated/control-openapi.json", import.meta.url);
// Use the repository's formatter so freshness includes the format actually reviewed in Git.
const formatted = execFileSync(
  `${root}node_modules/.bin/biome`,
  ["format", "--stdin-file-path=work-contract.ts"],
  { cwd: root, input: generated, encoding: "utf8" },
);
if (argv.includes("--check")) {
  if (
    (await readFile(output, "utf8")) !== formatted ||
    (await readFile(openapiOutput, "utf8")) !== schema ||
    (await readFile(controlOutput, "utf8")) !== controlSchema
  )
    throw new Error("Control/Work contracts are stale; run npm run contracts:generate.");
  console.log("Control/Work OpenAPI and Work types match TS; Python parity is a separate gate.");
} else {
  await writeFile(openapiOutput, schema);
  await writeFile(controlOutput, controlSchema);
  await writeFile(output, formatted);
  console.log("Generated TS-owned Control/Work OpenAPI and Work compatibility types.");
}
