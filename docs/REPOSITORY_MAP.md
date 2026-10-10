# Repository map

Start with the [root map](../AGENTS.md), then one route below and its local rules. Commands run from
the repository root. When a route does not answer the question, follow imports, calls or a failing
test. Setup is in [CONTRIBUTING](../CONTRIBUTING.md).

The single TypeScript control plane is in [apps/server](../apps/server/AGENTS.md), following
[ADR-0050](decisions/0050-typescript-control-plane.md). The [frozen oracle](../tests/oracles/legacy-server/AGENTS.md)
is comparison input only. Legacy Python packaging and CI remain pending retirement approval;
the Python-specific routes below describe those retained gates, not the TS development entry.

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
- Environment: locked `npm ci`; actual page via the documented TS Server/Web dev loop, synthetic
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
  and [WorkTasksScreen](../apps/web/src/components/WorkTasksScreen.tsx). Under accepted
  [ADR-0050](decisions/0050-typescript-control-plane.md), Work/native Task HTTP definitions now live
  in [shared TS](../packages/protocol/src/work-http.ts), with identity/auth/workspace/read groups in
  [control HTTP](../packages/protocol/src/control-http.ts), plus
  [model/storage/attachment operations](../packages/protocol/src/model-storage-openapi.ts) backed by
  [model inputs](../packages/protocol/src/model-services.ts) and [storage/attachment schemas](../packages/protocol/src/storage-http.ts).
  [Lifecycle/approval/audit operations](../packages/protocol/src/lifecycle-http.ts) reuse retained
  input/wire validators with explicit public response projections.
  [Employee HTTP](../packages/protocol/src/employee-http.ts) owns profile/knowledge/skill/memory
  projections; [automation HTTP](../packages/protocol/src/automation-http.ts) preserves the product's
  UTF-16/UTC/update-admission rules over [automation DTOs](../packages/protocol/src/automations.ts).
  [Node HTTP](../packages/protocol/src/node-http.ts) reuses retained enrollment wire inputs and public
  metadata; the resource registry also owns PNG/Markdown Run artifact downloads.
  [Plugin HTTP](../packages/protocol/src/plugin-http.ts) reuses retained declarations/catalog and
  preserves Python trim, case-sensitive UUID revisions and direct-field/collection Unicode bounds;
  [Web plugin types](../apps/web/src/plugin-api.ts) derive from these HTTP schemas.
  [Browser HTTP](../packages/protocol/src/browser-http.ts) preserves strict actions/session projections;
  [portability HTTP](../packages/protocol/src/portability-http.ts) owns export/import preview, package,
  activation and receipt contracts. Domain identity/session/message/Run/model/portable types derive from
  shared validators. Default registrations and reviewed consumers are inventoried; mixed-entry
  forwarding and actual engine/native execution retain their applicable migration phase gates.
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
  `npm run contracts:http:python` runs the [black-box Work/resource/lifecycle/Employee/automation/browser/portability/Node/artifact/plugin/control suites](../packages/contract-tests/README.md)
  against real `serve.py` product mode, owned PostgreSQL and a private loopback MCP fixture; no Temporal/provider/tool calls.
  Legacy plugin decisions have refusal-only HTTP evidence; successful/native durable approvals remain pending.
  Synthetic browser peers qualify original binding/observation/maintenance and bounded cancelled waits;
  trusted human control/Provider execution remains a separate gate. `-- --suite publisher` qualifies
  configured signed v1/v2 HTTP with disposable offline keys and public-only trust metadata.
  `-- --suite models` qualifies real Owner HTTP/SQL/SDK with synthetic OpenAI Chat/Anthropic transport;
  its count-only receipt refuses unauthorized dispatch/retry/fallback. Native Work decision/reconciliation
  success and cancellation/replay are real HTTP transactions over synthetic publication states.
  The real inventory includes reviewed consumer source digests and service composition; actual
  Web/Desktop settings PUT and Owner file transport are exercised with Node Fetch, without claiming
  installed Electron/platform behavior.
  Synthetic pending approvals/unread/audit publication states qualify real HTTP transactions only.
  Artifact fixtures also qualify native Work's separate8MiB files, empty binary downloads, snapshot links
  and integrity/no-follow refusal. SSE qualifies persisted change, slow-reader coalescing, deletion and
  revocation; saturation pressure remains pending. Use `-- --suite control` for owned focused verification;
  the complete `--inventory` run still requires all suites.
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

Shared TS defines Work/native Task, core control and model/storage/attachment HTTP; Python DTOs/routes remain parity input.
`npm run contracts:generate` writes [Control OpenAPI](../packages/protocol/generated/control-openapi.json),
[Work OpenAPI](../packages/protocol/generated/work-openapi.json) and
[compatibility types](../apps/web/src/generated/work-contract.ts) from shared TS Work schemas;
`npm run contracts:check` checks freshness without Python. [work-api](../apps/web/src/work-api.ts)
consumes shared validators/inferred types, preserving its additive response projection. Run
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
[contribution rules](../CONTRIBUTING.md#required-ci-completion) before CI work. Current scripts and workflows determine the applicable checks.
