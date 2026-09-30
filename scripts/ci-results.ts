/**
 * ci-results.ts
 *
 * Final CI aggregate: every job must report, required jobs must succeed, and
 * non-required runs cannot conceal failure.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { JOBS } from "./ci-selection.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function checkResults(plan: unknown, needs: unknown): string {
  if (!isRecord(plan)) assert.fail("Missing or unsupported CI scope.");
  assert.equal(plan.version, 1, "Missing or unsupported CI scope.");
  if (!isRecord(needs)) assert.fail("Every job must report a result.");
  assert.deepEqual(
    Object.keys(needs).sort(),
    ["scope", ...JOBS].sort(),
    "Every job must report a result.",
  );
  const scope = needs.scope;
  assert.equal(
    isRecord(scope) ? scope.result : undefined,
    "success",
    "Scope selection must succeed.",
  );
  assert(
    Array.isArray(plan.required) && Array.isArray(plan.notApplicable),
    "Invalid CI selection.",
  );
  const required = plan.required as unknown[];
  const notApplicable = plan.notApplicable as unknown[];
  const classified = [...required, ...notApplicable];
  assert.deepEqual(
    [...classified].sort(),
    [...JOBS].sort(),
    "Every job must be classified exactly once.",
  );
  assert(
    required.includes("security") && required.includes("validate"),
    "Repository and security checks are always required.",
  );
  for (const job of JOBS) {
    const entry: unknown = needs[job];
    const result: unknown = isRecord(entry) ? entry.result : undefined;
    if (required.includes(job))
      assert.equal(result, "success", `${job}: required result is ${result ?? "missing"}.`);
    else
      assert(
        result === "skipped" || result === "success",
        `${job}: even a non-required run cannot conceal ${result ?? "missing"}.`,
      );
  }
  return `CI requirements satisfied: ${required.length} required jobs; ${notApplicable.length} explicitly not applicable.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(
    checkResults(
      JSON.parse(process.env.OPENBOT_CI_PLAN ?? "null") as unknown,
      JSON.parse(process.env.OPENBOT_CI_NEEDS ?? "null") as unknown,
    ),
  );
}
