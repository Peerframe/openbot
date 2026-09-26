import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JOBS } from "./ci-scope.mjs";

export function checkResults(plan, needs) {
  assert.equal(plan?.version, 1, "Missing or unsupported CI scope.");
  assert.deepEqual(
    Object.keys(needs).sort(),
    ["scope", ...JOBS].sort(),
    "Every job must report a result.",
  );
  assert.equal(needs.scope?.result, "success", "Scope selection must succeed.");
  assert(
    Array.isArray(plan.required) && Array.isArray(plan.notApplicable),
    "Invalid CI selection.",
  );
  const classified = [...plan.required, ...plan.notApplicable];
  assert.deepEqual(
    [...classified].sort(),
    [...JOBS].sort(),
    "Every job must be classified exactly once.",
  );
  assert(
    plan.required.includes("security") && plan.required.includes("validate"),
    "Repository and security checks are always required.",
  );
  for (const job of JOBS) {
    const result = needs[job]?.result;
    if (plan.required.includes(job))
      assert.equal(result, "success", `${job}: required result is ${result ?? "missing"}.`);
    else
      assert(
        ["skipped", "success"].includes(result),
        `${job}: even a non-required run cannot conceal ${result ?? "missing"}.`,
      );
  }
  return `CI requirements satisfied: ${plan.required.length} required jobs; ${plan.notApplicable.length} explicitly not applicable.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(
    checkResults(
      JSON.parse(process.env.OPENBOT_CI_PLAN ?? "null"),
      JSON.parse(process.env.OPENBOT_CI_NEEDS ?? "null"),
    ),
  );
}
