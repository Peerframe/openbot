# Repository map

[简体中文](REPOSITORY_MAP.zh-CN.md)

Start with [root rules](../AGENTS.md), then one route below and its local rules. Commands run from
this repository root. Check paths against the actual checkout; follow imports/calls or a failing test
when the route does not answer the question. Do not load all research records. Setup is in
[CONTRIBUTING](../CONTRIBUTING.md); the [development entry](../.agents/README.md) links existing workflows.
The [completed upgrade record](REPOSITORY_UPGRADE_PLAN.md) preserves C1→C2→C3 evidence, not a standing
work queue. Resolve the current task and revision independently of those historical checkpoints.

Python is the product control default. `apps/server` retains only a retirement README; the
[frozen oracle](../tests/oracles/legacy-server/AGENTS.md) is comparison input only. Current runtime
source is `packages/harness`; core checks and product consumers install its typed wheel.

## UI interaction

- Rules/design: [Web AGENTS](../apps/web/AGENTS.md), [design reading entry](design/README.md).
- Representative interaction: the channel rail [ContextRail](../apps/web/src/components/ContextRail.tsx)
  and its [test](../apps/web/src/components/ContextRail.test.tsx), opened from the title pill in
  [WorkspaceHeader](../apps/web/src/components/WorkspaceHeader.tsx). [App](../apps/web/src/App.tsx)
  binds join/remove/profile navigation; read both when changing focus/navigation.
- State/consumers: [workspace hook](../apps/web/src/use-workspace-state.ts) and
  [API](../apps/web/src/api.ts) project Server facts into Web and the shared Desktop renderer.
  Work uses [work-api](../apps/web/src/work-api.ts) and
  [WorkTasksScreen](../apps/web/src/components/WorkTasksScreen.tsx).
- Checks: `npm exec -- turbo run build --filter=@openbot/web^...`, then
  `npm exec --workspace @openbot/web -- vitest run src/components/ContextRail.test.tsx` and
  `npm run typecheck --workspace @openbot/web`. Choose the affected component's test, not a fixed demo.
- Environment: locked `npm ci`; actual page via the documented Python Server/Web dev loop, synthetic
  Owner/database, wide/narrow viewport and affected states. No paid model needed. Component tests
  alone do not verify rendered behavior. Read [Desktop rules](../apps/desktop/AGENTS.md) for bridge work.

## Python core

- Rules/contract: [runtime AGENTS](../packages/harness/AGENTS.md),
  [contracts](../packages/harness/src/openbot_agent_runtime/contracts.py),
  [existing reviewed decision](../packages/harness/RESEARCH.md#9-real-server-catalog-and-tool-correlation-integration).
  Section 9 supersedes the earlier catalog decision in sections 4/4a; use the current implementation.
- Representative implementation: [executor](../packages/harness/src/openbot_agent_runtime/executor.py),
  [catalog](../packages/harness/src/openbot_agent_runtime/catalog.py),
  [bounds](../packages/harness/src/openbot_agent_runtime/bounds.py).
- Actual consumers: control [runtime host](../apps/server-python/src/openbot_server/runtime_host.py),
  [process](../apps/server-python/src/openbot_server/runtime_process.py),
  [Work runtime](../apps/server-python/src/openbot_server/work_product_runtime.py) and
  [Desktop payload builder](../apps/desktop/scripts/prepare-native-server.ts).
  Optional [Temporal composition](../packages/harness/src/openbot_agent_runtime/temporal_agent.py)
  has a different lifecycle; control owns [trusted ports](../apps/server-python/src/openbot_server/work_runtime_ports.py).
- Tests: [limits/catalog](../packages/harness/tests/test_catalog_and_limits.py),
  [authority](../packages/harness/tests/test_authority.py),
  [lifecycle](../packages/harness/tests/test_lifecycle.py),
  [Temporal](../packages/harness/tests/test_temporal_agent.py).
- Commands: `packages/harness/scripts/bootstrap.sh` (Python 3.12+, network only for locked
  install), then `packages/harness/scripts/check.sh -k catalog` for a catalog change;
  omit `-k` for the package suite. Check collection counts. No DB, Electron, Temporal or model account
  is needed for the base suite. Optional Worker tests require the separate environment in
  [the control README](../apps/server-python/README.md); base success does not prove replay.

## Cross-language contract

- Read [protocol rules](../packages/protocol/AGENTS.md) and [control rules](../apps/server-python/AGENTS.md).
  Retained Node wire schemas live in [protocol/src](../packages/protocol/src/index.ts), consumed by
  [Node client](../apps/node/src/client.ts). Do not replace their authority with a second DTO registry.
- Python product HTTP currently uses explicit projections in
  [work routes](../apps/server-python/src/openbot_server/work_routes.py) and
  [public Work DTOs](../apps/server-python/src/openbot_server/work_models.py); actual TS consumption is
  [work-api](../apps/web/src/work-api.ts), [its tests](../apps/web/src/work-api.test.ts),
  and [WorkTasksScreen](../apps/web/src/components/WorkTasksScreen.tsx). Work create/get/cancel
  requests, responses and errors have generated Python-to-TS types; see the checks below.
- Existing runtime wire: [Python control validator](../apps/server-python/src/openbot_server/runtime_wire.py)
  ↔ [runtime wire](../packages/harness/src/openbot_agent_runtime/wire.py);
  [comparison script](../apps/server-python/scripts/compare-runtime-wire.mjs) checks the frozen TS
  oracle, not an active TS Server. Preserve missing/null, errors, bounds and unknown-field rejection.
- Checks: `npm run oracle:build`, `apps/server-python/scripts/bootstrap.sh`, then
  `node apps/server-python/scripts/compare-runtime-wire.mjs` (synthetic, no DB/model).
  For product HTTP run `npm run contracts:test` and the affected control tests. This command builds
  shared dependencies before the Python HTTP→Web fixtures, including on a cold checkout.
  For an isolated Web regression, `npm exec --workspace @openbot/web -- vitest run src/work-api.test.ts`
  assumes those dependencies have already been built. Node wire uses
  `npm run test --workspace @openbot/protocol`.
  `npm run test:control:python` adds real disposable PostgreSQL and differential checks; Worker
  coverage additionally needs the documented `OPENBOT_TEMPORAL_TEST_PYTHON` environment.

## Control and persistence

[Control rules](../apps/server-python/AGENTS.md) → [app](../apps/server-python/src/openbot_server/app.py)
→ [product composition](../apps/server-python/src/openbot_server/product_control.py).
Control owns identity, authorization, routing, approvals, budgets, task/action facts and audit.
[Task store](../apps/server-python/src/openbot_server/task_store.py) owns retained submission;
[Work store](../apps/server-python/src/openbot_server/work_store.py) owns durable Work facts.
Web/Desktop and Node consume these facts. The live SQL history stays in `packages/db/migrations`.

Use `apps/server-python/scripts/bootstrap.sh` then `apps/server-python/scripts/check.sh -q` for the
base profile (prepare `npm run oracle:build` for interoperability tests). The script reports Worker
files delegated to the separate gate, and DB tests require the disposable fixture. Schema changes use
`npm run migration:plan --workspace @openbot/db -- --name describe_change`,
`npm run migrations:check` and [the migration contract](DATABASE.md#author-a-migration).
Never alter applied SQL or run acceptance against a user database.

## Other bounded routes

| Area | Owner / entry and consumers | Validation / environment |
| --- | --- | --- |
| MCP extensions | Python `plugin_*.py`; [PLUGINS](PLUGINS.md); Web `Plugin*` | Control plugin tests, Web sandbox tests; synthetic MCP fixture |
| Node / Providers | `apps/node/src/runtime.ts`, `providers/*`, `packages/provider-sdk`; Server dispatch | Node/provider tests and [conformance](PROVIDER_CONFORMANCE.md); enroll only for a real Node journey |
| Shared product types | `packages/domain/src`; Web and Node | `npm run typecheck --workspace @openbot/domain`, affected consumer builds |
| Desktop host | [Desktop rules](../apps/desktop/AGENTS.md), main/preload/native-server | Desktop tests; package/install/start/stop on affected OS when payload changes |
| Packaging / CI | `scripts`, `.github/workflows`, `deploy`; product installers and CI | `npm run release:check`, affected build/native lane; `npm run check` remains the local total |
| Rules / developer skills | root/local AGENTS, `.agents/skills`, contribution/PR research gate | `npm run docs:check`, `npm run research:check`, actual discovery/read acceptance; scripts also require full check |

## Change flow and generated data

Consult the relevant [reuse entry](OPEN_SOURCE_REUSE.md) and follow
[research triggers](../CONTRIBUTING.md#research-evidence-and-documentation-exemptions). Ordinary fixes
reuse valid decisions; a new boundary needs targeted evidence. Follow affected contracts to consumers,
add meaningful failure checks, and update English docs and maintained translations. Keep apps → shared
packages dependency direction. Use [openbot-check](../.agents/skills/openbot-check/SKILL.md) for evidence.

`dist`, `node_modules`, `.turbo`, Python venvs, Desktop `out`/`native-runtime`, `.env`, databases and logs
are generated/private, not source. Development skills are excluded from product resources. Backups
follow [the persistent-asset inventory](DATABASE.md#backup-boundary); retained notices live in
[licenses/runtime](../licenses/runtime/README.md). Read migration history only for the affected decision.


### Installed core and Work HTTP contribution checks

Use `npm run harness:check` / `npm run harness:wheel` and, after `bootstrap-quality.sh`,
the package's `scripts/quality.sh --core` for ordinary core changes. Default `quality.sh` adds
real Temporal/control types and requires the Worker environment.
`sh apps/server-python/scripts/bootstrap-worker.sh` installs the same wheel into the Worker env.
Build/quality tools and product dependencies have separate exact locks; see
[harness setup](../packages/harness/README.md).

The real Work create/get/cancel requests, snapshots and errors come from `work_models.py` through `work_routes.py`.
`npm run contracts:generate` writes [consumer types](../apps/web/src/generated/work-contract.ts);
`npm run contracts:check` checks freshness. [work-api](../apps/web/src/work-api.ts) consumes the
generated type and keeps Zod runtime validation. Run
`apps/server-python/scripts/bootstrap.sh` once, then `npm run contracts:test` for actual Python
HTTP→Web serialization/status fixtures. The command builds shared dependencies in a cold checkout;
calling Vitest directly assumes those outputs already exist. No DB or model is needed.
The Node wire protocol remains owned by `packages/protocol`.

### CI selection and artifact qualification

Use `npm run ci:scope -- --local` for tracked/untracked work, or verified `--base SHA --head SHA`
for a committed PR. `npm run check:affected` takes the same explicit arguments and runs only the
validation lane; separate required jobs are printed. `npm run check` remains the repository total.
The actual policy is [ci-selection](../scripts/ci-selection.ts), with success-only
[aggregation](../scripts/ci-results.ts); counterexamples run via `npm run ci:check`. Read
[contribution rules](../CONTRIBUTING.md#required-ci-completion) before CI work. The upgrade record's
[historical producer/duty table](REPOSITORY_UPGRADE_PLAN.md#c3-check-duties-and-artifact-ownership)
explains the accepted baseline; current scripts and workflows determine the applicable checks.
