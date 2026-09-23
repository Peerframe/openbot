// Differential check: the installed compiled Zod identity schemas versus the Python input module.
//
//   node apps/server-python/scripts/compare-identity-inputs.mjs
//
// Loads `packages/protocol/dist/index.js` (the retained OpenBot schemas compiled from
// packages/protocol/src/index.ts) and the fixture in tests/fixtures/identity-inputs.json, then runs
// `openbot_server.identity_inputs` in an isolated interpreter with an explicitly inserted source
// path. Success/failure and the normalized public payload must agree case by case.
//
// Fixed paths only: no shell, no network, no database, no caller-supplied input path, no inherited
// environment (the child gets an explicit minimal env, so no ambient secret can leak).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROTOCOL_BUILD_COMMAND = "npm exec -- turbo run build --filter=@openbot/protocol";

const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url));
const packageDirectory = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);

const compiledSchemas = new URL("packages/protocol/dist/index.js", repositoryRoot);
const fixturePath = new URL("tests/fixtures/identity-inputs.json", packageDirectory);
const profileFixturePath = new URL("tests/fixtures/profile-inputs.json", packageDirectory);
const pythonPath = new URL(".venv/bin/python", packageDirectory);
const sourcePath = new URL("src", packageDirectory);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

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

const { createBotInputSchema, createChannelInputSchema, updateEmployeeProfileDetailsInputSchema } =
  await import(compiledSchemas.href);
const schemas = {
  bot: createBotInputSchema,
  channel: createChannelInputSchema,
  profile: updateEmployeeProfileDetailsInputSchema,
};
const fixture = {
  cases: [fixturePath, profileFixturePath].flatMap(
    (path) => JSON.parse(readFileSync(path, "utf8")).cases,
  ),
};

// One fixed, self-contained program: insert the pinned source path, validate every fixture case.
const bootstrap = `
import json
import sys

sys.path.insert(0, sys.argv[1])
from pydantic import ValidationError
from openbot_server.identity_inputs import parse_bot_create, parse_channel_create
from openbot_server.profile_details import parse_profile_details

parsers = {"bot": parse_bot_create, "channel": parse_channel_create, "profile": parse_profile_details}
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

function runPython() {
  const result = spawnSync(
    fileURLToPath(pythonPath),
    [
      "-I",
      "-u",
      "-c",
      bootstrap,
      fileURLToPath(sourcePath),
      fileURLToPath(fixturePath),
      fileURLToPath(profileFixturePath),
    ],
    {
      cwd: scriptsDirectory,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Python differential failed (${result.error?.code ?? result.status}): ${result.stderr ?? ""}`,
    );
  }
  const payload = JSON.parse(result.stdout);
  return new Map(payload.results.map((entry) => [entry.id, entry]));
}

// Stable key order, so the two runtimes can be compared as text.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function viaZod(schemaName, input) {
  const result = schemas[schemaName].safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data, text: JSON.stringify(canonical(result.data)) };
  }
  const first = result.error.issues[0];
  return { ok: false, error: first.code, loc: first.path };
}

const pythonResults = runPython();
const mismatches = [];

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
  if (!expected.ok) continue;
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
