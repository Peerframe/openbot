/** Frozen pre-retirement Python outputs retain the old cross-language input/projection evidence. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { steerNativeRunInputSchema } from "../packages/protocol/dist/index.js";
import { toRun } from "../tests/oracles/legacy-server/dist/postgres-task-records.js";
import { selectChannelAssignees } from "../tests/oracles/legacy-server/dist/task-routing.js";
import { runtimeWorkerMessageSchema } from "../tests/oracles/legacy-server/dist/agent-runtime-wire.js";
import {
  boundedKnowledgeText,
  validateKnowledgeProposal,
} from "../tests/oracles/legacy-server/dist/agent-knowledge.js";
import { nativeFailureMessages } from "../tests/oracles/legacy-server/dist/agent-observations.js";
import { scanSensitiveText } from "../tests/oracles/legacy-server/dist/sensitive-content.js";
const raw = readFileSync(
  new URL("./integration/fixtures/legacy-adapter-compatibility.json", import.meta.url),
);
assert.equal(
  createHash("sha256").update(raw).digest("hex"),
  "e363d1b4aef175ee04f25ea09957aca9a39972b5d449a9072bb93e6fb3a2cda6",
);
const { samples } = JSON.parse(raw);
const task = samples["task-contracts"];
for (const [index, input] of task.cases.routing.entries())
  test("retained routing projection " + index, () => {
    let actual;
    try {
      actual = {
        ids: selectChannelAssignees(input.candidates, input.input, input.directBotId).map(
          (value) => value.id,
        ),
      };
    } catch (error) {
      actual = { error: error.message };
    }
    assert.deepEqual(actual, task.results.routing[index]);
  });
for (const [index, input] of task.cases.runs.entries())
  test("retained Run/usage projection " + index, () => {
    const mapped = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
        value,
      ]),
    );
    mapped.createdAt = new Date(mapped.createdAt);
    mapped.updatedAt = new Date(mapped.updatedAt);
    assert.deepEqual(toRun(mapped), task.results.runs[index]);
  });
for (const [index, input] of samples["runtime-wire"].cases.entries())
  test("retired harness wire provenance " + index, () => {
    const parsed = runtimeWorkerMessageSchema.safeParse(input);
    assert.deepEqual(
      parsed.success ? { ok: true, value: parsed.data } : { ok: false },
      samples["runtime-wire"].results[index],
    );
  });
for (const [index, item] of samples["run-commands"].cases.entries())
  test("Owner command contract " + index, () => {
    const parsed = (
      item.kind === "steer" ? steerNativeRunInputSchema : z.object({}).strict()
    ).safeParse(item.input);
    assert.deepEqual(
      parsed.success ? { ok: true, value: parsed.data } : { ok: false },
      samples["run-commands"].results[index],
    );
  });
for (const [index, item] of samples["execution-values"].cases.entries())
  test("retained execution value " + index, () => {
    let actual;
    try {
      actual = {
        ok: true,
        value:
          item.kind === "proposal"
            ? validateKnowledgeProposal(item.input)
            : item.kind === "bounded"
              ? boundedKnowledgeText(item.value, item.maximumBytes)
              : scanSensitiveText(item.value, "field", { portable: false }).length > 0,
      };
    } catch {
      actual = { ok: false };
    }
    assert.deepEqual(actual, samples["execution-values"].results.results[index]);
  });
test("all twenty retained failure messages remain unchanged", () => {
  assert.equal(Object.keys(nativeFailureMessages).length, 20);
  assert.deepEqual(nativeFailureMessages, samples["execution-values"].results.failures);
});
