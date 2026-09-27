---
name: openbot-review
description: Review a fixed OpenBot diff for correctness, authority, contracts and usable validation. Use for review or handoff acceptance; do not implement a second competing patch.
---

# openbot-review

## Inputs

Use the review target (verified base/head or explicit working-tree diff), scope and claimed evidence.

## Steps

1. Resolve the target and preserve dirty files. Read root/local rules and the matching
   [repository route](../../../docs/REPOSITORY_MAP.md); follow changed contracts to actual consumers.
2. Check requested behavior and concrete failure cases. Look for authority leaks, unknown-effect
   retries, erased process/Activity differences, schema drift and tests that silently collect nothing.
3. Apply [research triggers](../../../CONTRIBUTING.md#research-evidence-and-documentation-exemptions)
   to the actual diff. Ordinary repairs reuse decisions. Dependency, public-contract, permission and
   persistence changes cannot hide behind a repair label; demand the affected evidence, not a whole
   stack report. The mechanical gate is conservative, not proof of semantic correctness.
4. Reproduce an actionable suspected defect with [openbot-check](../openbot-check/SKILL.md).
   Reuse unchanged test evidence; distinguish actual, cached, mocked and hosted results.

## Output and stop conditions

Report only actionable findings with file/line, triggering case, consequence and missing evidence.
If none, say so with remaining validation limits. Do not mutate a reviewed checkout or run paid/live
services without authorization. Keep the current handoff accurate about writers, revision and blockers.
