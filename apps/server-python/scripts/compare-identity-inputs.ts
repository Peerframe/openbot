// Differential check: the installed compiled Zod identity schemas versus the Python input module.
//
//   node apps/server-python/scripts/compare-identity-inputs.ts
//
// Loads `packages/protocol/dist/index.js` (the retained OpenBot schemas compiled from
// packages/protocol/src/index.ts, typed by its emitted declarations) and the fixtures in
// tests/fixtures/{identity,profile,task}-inputs.json, then runs the Python parsers in an isolated
// interpreter with an explicitly inserted source path. Success/failure and the normalized public
// payload must agree case by case.
//
// Fixed paths only: no shell, no network, no database, no caller-supplied input path, no inherited
// environment (the child gets an explicit PATH-only env, so no ambient secret can leak).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  comparatorPaths,
  runPythonComparator,
  spawnErrorCode,
  THIRTY_SECONDS,
  TWO_MIB,
} from "./python-comparator.ts";

const PROTOCOL_BUILD_COMMAND = "npm exec -- turbo run build --filter=@openbot/protocol";

const scriptsDirectory = new URL(".", import.meta.url);
const packageDirectory = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);

const compiledSchemas = new URL("packages/protocol/dist/index.js", repositoryRoot);
const fixturePaths = [
  new URL("tests/fixtures/identity-inputs.json", packageDirectory),
  new URL("tests/fixtures/profile-inputs.json", packageDirectory),
  new URL("tests/fixtures/task-inputs.json", packageDirectory),
  new URL("tests/fixtures/rename-inputs.json", packageDirectory),
];
const pythonPath = comparatorPaths(packageDirectory).interpreter;

type SchemaName = "bot" | "channel" | "profile" | "task" | "botRename" | "channelRename";
interface IdentityCase {
  readonly id: string;
  readonly schema: SchemaName;
  readonly input: unknown;
}
type PythonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };
type ZodOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isSchemaName = (value: unknown): value is SchemaName =>
  value === "bot" ||
  value === "channel" ||
  value === "profile" ||
  value === "task" ||
  value === "botRename" ||
  value === "channelRename";

if (!existsSync(compiledSchemas)) {
  fail(
    `Missing compiled protocol schemas: ${compiledSchemas.pathname}\n` +
      `Build them first with the targeted command:\n  ${PROTOCOL_BUILD_COMMAND}\n` +
      "This check never builds or installs anything itself.",
  );
}
if (!existsSync(pythonPath)) {
  fail(
    `Missing package interpreter: ${pythonPath.pathname}\n` +
      "Create it with the package bootstrap (the only networked step):\n" +
      "  apps/server-python/scripts/bootstrap.sh",
  );
}

// Imported only after the existence check, so a missing build keeps the targeted diagnostic.
const protocol = await import("../../../packages/protocol/dist/index.js");
const schemas = {
  bot: protocol.createBotInputSchema,
  channel: protocol.createChannelInputSchema,
  profile: protocol.updateEmployeeProfileDetailsInputSchema,
  task: protocol.createMessageInputSchema,
  botRename: protocol.renameBotInputSchema,
  channelRename: protocol.renameChannelInputSchema,
};

function readCases(path: URL): IdentityCase[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const cases = isRecord(parsed) ? parsed.cases : undefined;
  if (!isList(cases)) fail(`Malformed fixture without a case list: ${fileURLToPath(path)}`);
  return cases.map((entry, index) => {
    if (!isRecord(entry)) fail(`Malformed fixture case ${index}: ${fileURLToPath(path)}`);
    const { id, schema, input } = entry;
    if (typeof id !== "string" || !isSchemaName(schema))
      fail(`Malformed fixture case ${index}: ${fileURLToPath(path)}`);
    return { id, schema, input };
  });
}
const fixture = { cases: fixturePaths.flatMap(readCases) };

// One fixed, self-contained program: insert the pinned source path, validate every fixture case.
const bootstrap = `
import json
import sys

sys.path.insert(0, sys.argv[1])
from pydantic import ValidationError
from openbot_server.identity_inputs import parse_bot_create, parse_channel_create
from openbot_server.profile_details import parse_profile_details
from openbot_server.task_inputs import parse_message
from openbot_server.identity_lifecycle import RenameBotInput, RenameChannelInput

parsers = {"bot": parse_bot_create, "channel": parse_channel_create, "profile": parse_profile_details, "task": parse_message,
           "botRename": RenameBotInput.model_validate, "channelRename": RenameChannelInput.model_validate}
fixture = {"cases": []}
for path in sys.argv[2:]:
    with open(path, encoding="utf-8") as handle:
        fixture["cases"].extend(json.load(handle)["cases"])

results = []
for case in fixture["cases"]:
    try:
        payload = parsers[case["schema"]](case["input"]).model_dump(mode="json", exclude_none=True)
        results.append({"id": case["id"], "ok": True, "value": payload})
    except ValidationError as error:
        first = error.errors()[0]
        results.append({"id": case["id"], "ok": False, "error": first["type"], "loc": list(first["loc"])})

json.dump({"results": results}, sys.stdout, ensure_ascii=True)
`;

function runPython(): Map<string, PythonResult> {
  const result = runPythonComparator({
    packageRoot: packageDirectory,
    program: bootstrap,
    unbuffered: true,
    programArguments: fixturePaths.map((path) => fileURLToPath(path)),
    cwd: scriptsDirectory,
    timeoutMs: THIRTY_SECONDS,
    maxBufferBytes: TWO_MIB,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Python differential failed (${spawnErrorCode(result.error) ?? result.status}): ${result.stderr ?? ""}`,
    );
  }
  const payload: unknown = JSON.parse(result.stdout);
  const results = isRecord(payload) ? payload.results : undefined;
  if (!isList(results)) throw new Error("Python differential produced no result list.");
  const byId = new Map<string, PythonResult>();
  for (const entry of results) {
    if (!isRecord(entry)) throw new Error("Python differential produced a malformed result.");
    const { id, ok, value, error } = entry;
    if (typeof id !== "string" || typeof ok !== "boolean")
      throw new Error("Python differential produced a malformed result.");
    byId.set(id, ok ? { ok: true, value } : { ok: false, error: String(error) });
  }
  return byId;
}

// Stable key order, so the two runtimes can be compared as text.
function canonical(value: unknown): unknown {
  if (isList(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function viaZod(schemaName: SchemaName, input: unknown): ZodOutcome {
  const result = schemas[schemaName].safeParse(input);
  if (result.success) return { ok: true, text: JSON.stringify(canonical(result.data)) };
  const first = result.error.issues[0];
  if (first === undefined) throw new Error(`Zod rejected a ${schemaName} input without an issue.`);
  return { ok: false, error: first.code };
}

const pythonResults = runPython();
const mismatches: string[] = [];

for (const testCase of fixture.cases) {
  const expected = viaZod(testCase.schema, testCase.input);
  const actual = pythonResults.get(testCase.id);
  if (actual === undefined) {
    mismatches.push(`${testCase.id}: python produced no result`);
    continue;
  }
  if (expected.ok !== actual.ok) {
    mismatches.push(
      `${testCase.id}: zod ${expected.ok ? "accepted" : `rejected (${expected.error})`} but python ` +
        `${actual.ok ? "accepted" : `rejected (${actual.error})`}`,
    );
    continue;
  }
  if (!expected.ok || !actual.ok) continue;
  const actualText = JSON.stringify(canonical(actual.value));
  if (expected.text !== actualText) {
    mismatches.push(`${testCase.id}: zod ${expected.text} !== python ${actualText}`);
  }
}

const accepted = fixture.cases.filter(
  (testCase) => viaZod(testCase.schema, testCase.input).ok,
).length;
process.stdout.write(
  `identity inputs: ${fixture.cases.length} cases (${accepted} accepted, ` +
    `${fixture.cases.length - accepted} rejected), ${fixture.cases.length - mismatches.length} agreed\n`,
);
if (mismatches.length > 0) {
  for (const mismatch of mismatches) process.stderr.write(`MISMATCH ${mismatch}\n`);
  process.stderr.write(`${mismatches.length} mismatch(es) between Zod and the Python module\n`);
  process.exit(1);
}
process.stdout.write("Zod and the Python input module agree on every fixture case\n");
