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
   actual `package.json` or its own check script. Commands below the map run from the repository root.
2. Start with its focused positive/negative tests. Build shared TS packages before downstream tests
   when needed; `npm exec -- turbo run build --filter=@openbot/web^...` uses the existing graph.
   The TS Server uses its workspace unit/integration commands, `npm run test:control:ts`,
   `npm run test:work:ts`, and `npm run contracts:http:ts` / `contracts:http:tls` for affected
   product contracts. These fixtures own disposable PostgreSQL/Temporal resources. The old Python
   gates remain required while retirement is pending. Core-only Python work uses `packages/harness/scripts/bootstrap.sh`, package `check.sh` and
   `bootstrap-quality.sh` → `quality.sh --core`, without the product environment. Optional Temporal
   and control adapters retain default `quality.sh` against the Worker closure and affected
   integration checks. Work HTTP uses `npm run contracts:test`, which builds cold prerequisites;
   direct Vitest assumes they already exist.
3. For rules/skills/prompts run `npm run docs:check` and `npm run research:check`, plus the affected
   workflow tests. Verify actual discovery and a realistic reading task; file existence is insufficient.
4. For implementation/script integration run `npm run check`. Pure instruction/prose changes use
   applicable workflow/documentation gates. `npm run check:affected -- --local` runs the selected
   validation lane and lists separate qualifications. A PR uses verified immutable `--base SHA
   --head SHA`; do not mix local/untracked changes into that range. Security and required hosted
   results remain necessary. Do not suppress a check merely to shorten a run.
5. Count collected/executed tests, inspect skips and first useful failure. Fix task regressions;
   record existing unrelated failures. Reuse unchanged evidence with its original revision and scope.

## Output and stop conditions

Report exact commands, exit codes, counts, executed versus cached results, skips and environment gaps.
Zero tests and fixture-only success do not establish the requested integration. Stop a test before it
can use production data or a paid model without authorization. Missing environments remain explicit
acceptance gaps. Full local success does not substitute for hosted platform/packaging qualification.
