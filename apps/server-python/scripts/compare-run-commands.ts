// Compare the installed protocol schema and Zod cancellation object with the Python adapters.
import assert from "node:assert/strict";
import { z } from "zod";
import { steerNativeRunInputSchema } from "../../../packages/protocol/dist/index.js";
import { runPythonComparator, THIRTY_SECONDS, TWO_MIB } from "./python-comparator.ts";

type CommandKind = "steer" | "cancel";
interface CommandCase {
  readonly kind: CommandKind;
  readonly input: unknown;
}

const packageRoot = new URL("../", import.meta.url);
const text = (instruction: unknown): { readonly instruction: unknown } => ({ instruction });
const steerInputs: readonly unknown[] = [
  text("check"),
  text("  corrected 🧪  "),
  text("\t\n\u00a0check\u3000\ufeff"),
  text("\u001c"),
  text("\u0085"),
  text("\u200b"),
  text("x".repeat(4000)),
  text("x".repeat(4001)),
  text("😀".repeat(4000)),
  text("😀".repeat(4001)),
  text(`e${"\u0301".repeat(3999)}`),
  text(`e${"\u0301".repeat(4000)}`),
  text(""),
  text(" "),
  text("\ufeff"),
  text(null),
  text(1),
  text(true),
  text([]),
  text({}),
  {},
  { instruction: "check", extra: true },
  null,
  [],
  "check",
  text("\ud800"),
  text("\udfff"),
];
const cancelInputs: readonly unknown[] = [{}, { force: true }, null, [], 1, true, "cancel"];
const cases: readonly CommandCase[] = [
  ...steerInputs.map((input): CommandCase => ({ kind: "steer", input })),
  ...cancelInputs.map((input): CommandCase => ({ kind: "cancel", input })),
];
const schemas = { steer: steerNativeRunInputSchema, cancel: z.object({}).strict() };
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const program = `
import json, sys
from pydantic import ValidationError
sys.path.insert(0, sys.argv[1])
from openbot_server.run_commands import parse_steering, parse_cancel
parsers = {"steer": parse_steering, "cancel": parse_cancel}
results = []
for case in json.load(sys.stdin):
    try:
        value = parsers[case["kind"]](case["input"]).model_dump(mode="json")
        results.append({"ok": True, "value": value})
    except ValidationError:
        results.append({"ok": False})
json.dump(results, sys.stdout, ensure_ascii=True)
`;
const child = runPythonComparator({
  packageRoot,
  program,
  unbuffered: true,
  cwd: packageRoot,
  stdin: JSON.stringify(cases),
  timeoutMs: THIRTY_SECONDS,
  maxBufferBytes: TWO_MIB,
});
assert.equal(child.error, undefined, "Python command comparator did not run.");
assert.equal(child.status, 0, "Python command comparator failed.");
const actual: unknown = JSON.parse(child.stdout);
if (!isList(actual)) assert.fail("Python command comparator produced no result list.");
assert.equal(actual.length, cases.length);
for (const [index, testCase] of cases.entries()) {
  const expected = schemas[testCase.kind].safeParse(testCase.input);
  assert.deepEqual(
    actual[index],
    expected.success ? { ok: true, value: expected.data } : { ok: false },
    `Owner command case ${index} (${testCase.kind}) disagreed with the installed Zod schema.`,
  );
}
console.log(`Owner run commands: ${cases.length} actual Zod/Python cases agree.`);
