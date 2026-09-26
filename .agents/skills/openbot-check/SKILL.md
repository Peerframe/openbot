---
name: openbot-check
description: Select and run existing focused OpenBot checks, then applicable integration gates. Use for validation or a failure; not to replace the full check or to claim skipped tests passed.
---

# openbot-check

## Inputs

Use changed files (including untracked task files), the acceptance scope and available environments.
For a PR use its verified base/head; do not infer the diff from a stale remote branch.

## Steps

1. Read the changed area's local rules and [map](../../../docs/REPOSITORY_MAP.md), then inspect the
   actual `package.json` or `scripts/check.sh`. Commands below the map run from the repository root.
2. Start with its focused positive/negative tests. Build shared TS packages before downstream tests
   when needed; `npm exec -- turbo run build --filter=@openbot/web^...` uses the existing graph.
   Core-only Python work uses its locked bootstrap and package check, not the entire product.
3. For rules/skills/prompts run `npm run docs:check` and `npm run research:check`, plus the affected
   workflow tests. Verify actual discovery and a realistic reading task; file existence is insufficient.
4. For implementation/script integration run `npm run check`. Pure instruction/prose changes use
   applicable workflow/documentation gates; this does not waive hosted required CI. C3 has not yet
   changed CI selection. Do not edit workflows or suppress a check merely to shorten this run.
5. Count collected/executed tests, inspect skips and first useful failure. Fix task regressions;
   record existing unrelated failures. Reuse unchanged evidence with its original revision and scope.

## Output and stop conditions

Report exact commands, exit codes, counts, executed versus cached results, skips and environment gaps.
Zero tests and fixture-only success do not establish the requested integration. Stop a test before it
can use production data or a paid model without authorization. Missing environments remain explicit
acceptance gaps. Full local success does not substitute for hosted platform/packaging qualification.
