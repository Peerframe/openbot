import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPluginToolResult } from "./plugin-compatibility.js";
import { startExamplePlugin } from "./plugin-example.js";
import { preflightPlugin } from "./plugin-preflight.js";
import {
  type CompatibilityScenario,
  startCompatibilityFixture,
} from "./plugin-preflight-fixture.js";

test("example: discovers actual tools without executing or changing notes", async (t) => {
  const example = await startExamplePlugin(0);
  t.after(() => example.close());
  const result = await preflightPlugin(example.endpoint);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tools.sort(), ["append_note", "sum_numbers"]);
  assert.deepEqual(example.notes, []);
  assert.equal(result.toolCalls, 0);
});

const failures: Array<[CompatibilityScenario, string]> = [
  ["input-schema", "schema_unsupported"],
  ["output-schema", "schema_unsupported"],
  ["required-task", "execution_unsupported"],
  ["auth", "authentication_required"],
  ["forbidden", "access_denied"],
  ["transport", "transport_unsupported"],
  ["reset-content", "transport_unsupported"],
  ["protocol", "protocol_unsupported"],
  ["timeout", "timeout"],
  ["pagination", "catalog_unsupported"],
];
for (const [scenario, compatibility] of failures)
  test(`rejects ${scenario} with ${compatibility}`, async (t) => {
    const fixture = await startCompatibilityFixture(scenario);
    t.after(() => fixture.close());
    await assert.rejects(
      preflightPlugin(fixture.endpoint, { timeoutMs: scenario === "timeout" ? 100 : 5000 }),
      (error: unknown) => {
        assert.equal((error as { compatibility: string }).compatibility, compatibility);
        assert.doesNotMatch(
          String(error),
          /private-response|unsupported-private|untrusted.invalid/u,
        );
        return true;
      },
    );
    assert.ok(!fixture.methods.includes("tools/call"));
  });

test("accepts a dedicated bearer token without OAuth or a service account", async (t) => {
  const fixture = await startCompatibilityFixture("auth");
  t.after(() => fixture.close());
  assert.equal((await preflightPlugin(fixture.endpoint, { token: "fixture-token" })).ok, true);
});

test("shared result policy accepts text and rejects binary or oversized results", () => {
  assert.deepEqual(checkPluginToolResult({ content: [{ type: "text", text: "42" }] }), {
    content: [{ type: "text", text: "42" }],
  });
  for (const content of [
    [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }],
    [{ type: "text" as const, text: "x".repeat(13 * 1024) }],
  ])
    assert.throws(() => checkPluginToolResult({ content }), {
      compatibility: "result_unsupported",
    });
});
