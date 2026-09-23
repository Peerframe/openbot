// Compare the Python persisted-execution-value port with the actual compiled Server modules.
//
// The oracle is the real compiled TypeScript (`apps/server/dist/agent-observations.js`,
// `agent-knowledge.js` and `sensitive-content.js`), never a JavaScript restatement of it. If the
// Server source changed, rebuild it first: `npm run build --workspace @openbot/server`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeFailureMessages } from "../../../apps/server/dist/agent-observations.js";
import {
  boundedKnowledgeText,
  validateKnowledgeProposal,
} from "../../../apps/server/dist/agent-knowledge.js";
import { scanSensitiveText } from "../../../apps/server/dist/sensitive-content.js";

const packageRoot = new URL("../", import.meta.url);

const proposalInputs = [
  { kind: "semantic", title: "Deployment notes", content: "Rotate the staging key monthly." },
  { kind: "procedural", title: "  Trim me  ", content: "\tBody\t" },
  { kind: "episodic", title: "t".repeat(160), content: "b" },
  { kind: "episodic", title: "t".repeat(161), content: "b" },
  { kind: "semantic", title: "   ", content: "b" },
  { kind: "semantic", title: "note\0name", content: "b" },
  { kind: "semantic", title: "t", content: "\u{1f600}".repeat(2000) },
  { kind: "semantic", title: "t", content: "\u{1f600}".repeat(2001) },
  { kind: "semantic", title: "t", content: "body\0body" },
  { kind: "semantic", title: "-----BEGIN RSA PRIVATE KEY-----", content: "b" },
  { kind: "semantic", title: "t", content: "AKIAIOSFODNN7EXAMPLE" },
  { kind: "semantic", title: "t", content: "password=abcdef" },
  { kind: "unknown", title: "t", content: "b" },
  { kind: "semantic", title: "t", content: "b", ownerReviewed: true },
  null,
  { kind: "semantic", title: "t", content: "/Users/owner/notes.md" },
];
const boundedCases = [
  ["abc", 3],
  ["a\u{1f600}", 4],
  ["\u{1f600}\u{1f600}", 7],
  ["\u{1f600}", 3],
  ["\u00e9\u00e9\u00e9", 4],
  ["", 0],
  ["abc", 0],
  [" e\u0301", 3],
  ["\u00a0abc", 4],
  ["\ufeffa", 4],
];
const sensitiveCases = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "AKIAIOSFODNN7EXAMPLE",
  "akiaiosfodnn7example",
  `ghp_${"a".repeat(36)}`,
  `npm_${"a".repeat(36)}`,
  `sk_live_${"A".repeat(16)}`,
  `Bearer ${"a".repeat(20)}`,
  "password: 'abcdef'",
  "token=abc",
  "/Users/owner/notes.md",
  "\u00e9secret=abcdef",
  "\u017fecret=abcdef",
  "password\u001c=abcdef",
  "password\ufeff=abcdef",
];
const cases = [
  ...proposalInputs.map((input) => ({ kind: "proposal", input })),
  ...boundedCases.map(([value, maximumBytes]) => ({ kind: "bounded", value, maximumBytes })),
  ...sensitiveCases.map((value) => ({ kind: "sensitive", value })),
];

function oracle(testCase) {
  if (testCase.kind === "proposal") {
    try {
      return { ok: true, value: validateKnowledgeProposal(testCase.input) };
    } catch {
      return { ok: false };
    }
  }
  if (testCase.kind === "bounded")
    return { ok: true, value: boundedKnowledgeText(testCase.value, testCase.maximumBytes) };
  return {
    ok: true,
    value: scanSensitiveText(testCase.value, "field", { portable: false }).length > 0,
  };
}

const program = `
import json, sys
sys.path.insert(0, sys.argv[1])
from openbot_server import execution_values as values
results = []
for case in json.load(sys.stdin):
    kind = case["kind"]
    try:
        if kind == "proposal":
            results.append({"ok": True, "value": values.validate_proposal(case["input"])})
        elif kind == "bounded":
            results.append({"ok": True, "value": values.bounded_text(case["value"], case["maximumBytes"])})
        else:
            results.append({"ok": True, "value": values.has_sensitive_text(case["value"])})
    except (ValueError, TypeError):
        results.append({"ok": False})
json.dump({"failures": dict(values.FAILURE_MESSAGES), "results": results}, sys.stdout,
          ensure_ascii=True)
`;
const child = spawnSync(
  fileURLToPath(new URL(".venv/bin/python", packageRoot)),
  ["-I", "-u", "-c", program, fileURLToPath(new URL("src", packageRoot))],
  {
    cwd: fileURLToPath(packageRoot),
    env: { PATH: "/usr/bin:/bin" },
    input: JSON.stringify(cases),
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
if (child.status !== 0) console.error(child.stderr);
assert.equal(child.error, undefined, "Python execution-value comparator did not run.");
assert.equal(child.status, 0, "Python execution-value comparator failed.");
const actual = JSON.parse(child.stdout);
assert.equal(actual.results.length, cases.length);

assert.equal(Object.keys(nativeFailureMessages).length, 20);
assert.equal(Object.keys(actual.failures).length, 20);
assert.deepEqual(
  actual.failures,
  nativeFailureMessages,
  "The Python failure-message map disagrees with the compiled Server map.",
);

for (const [index, testCase] of cases.entries()) {
  assert.deepEqual(
    actual.results[index],
    oracle(testCase),
    `Execution-value case ${index} (${testCase.kind}) disagreed with the compiled TypeScript.`,
  );
}

// Two Python refusals deliberately have no TypeScript counterpart, and both are covered by
// tests/test_execution_values.py instead of a comparison case:
//   * `boundedKnowledgeText("abc", -1)` answers "" where this port refuses the budget.
//   * `boundedKnowledgeText("\ud800", 3)` answers "\ud800", counting a lone surrogate as the three
//     bytes of the replacement character it would become; this port refuses any text that is not
//     UTF-8. Escaped JSON can carry it into Python; the value boundary explicitly refuses it.
assert.equal(boundedKnowledgeText("abc", -1), "");
assert.equal(boundedKnowledgeText("\ud800", 3), "\ud800");
assert.equal(Buffer.byteLength("\ud800"), 3);

console.log(
  `Execution values: 20 failure codes and ${cases.length} actual compiled-TypeScript cases agree; ` +
    "2 Python-only refusals are asserted in the focused pytest.",
);
