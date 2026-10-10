# Repository map

Start with the [root map](../AGENTS.md), then one route below and its local rules. Commands run from
the repository root. When a route does not answer the question, follow imports, calls or a failing
test. Setup is in [CONTRIBUTING](../CONTRIBUTING.md).

The single TypeScript control plane is in [apps/server](../apps/server/AGENTS.md), following
[ADR-0050](decisions/0050-typescript-control-plane.md). The [frozen oracle](../tests/oracles/legacy-server/AGENTS.md)
is comparison input only. Required setup and checks use TypeScript; frozen legacy outputs retain compatibility provenance.

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

## Execution core

- Rules: [Server rules](../apps/server/AGENTS.md); accepted [ADR-0050](decisions/0050-typescript-control-plane.md).
- Runtime: [Work runtime](../apps/server/src/work-runtime.ts), [ledger](../apps/server/src/work-ledger.ts)
  and [Temporal package](../packages/work/src/index.ts). Control retains authority and durable facts;
  external effects run in Activities, never Workflow replay.
- Consumers: the [product entry](../apps/server/src/desktop-entry.ts), Web Work API and enrolled Node.
- Checks: `npm run test:work:ts` owns disposable PostgreSQL/mTLS Temporal and deterministic model peers.
  It includes real process death, deferred approvals, cancellation, corrections, receipts and replay.
  Native command/browser isolation uses the separate required Linux qualification.

## Cross-language contract

- Read [protocol rules](../packages/protocol/AGENTS.md) and [control rules](../apps/server/AGENTS.md).
  Retained Node wire schemas live in [protocol/src](../packages/protocol/src/index.ts), consumed by
  [Node client](../apps/node/src/client.ts). Do not replace their authority with a second DTO registry.
- Product HTTP projects control-owned facts through [Server](../apps/server/src/app.ts);
  [work-api](../apps/web/src/work-api.ts) consumes shared validators. Under accepted
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
  preserves the retired Python trim, case-sensitive UUID revisions and direct-field/collection Unicode bounds;
  [Web plugin types](../apps/web/src/plugin-api.ts) derive from these HTTP schemas.
  [Browser HTTP](../packages/protocol/src/browser-http.ts) preserves strict actions/session projections;
  [portability HTTP](../packages/protocol/src/portability-http.ts) owns export/import preview, package,
  activation and receipt contracts. Domain identity/session/message/Run/model/portable types derive from
  shared validators. Default registrations and reviewed consumers are inventoried; mixed-entry
  forwarding and actual engine/native execution retain their applicable migration phase gates.
- Frozen legacy runtime wire, routing and execution values run via `npm run contracts:legacy`;
  preserve missing/null, errors, bounds and unknown-field rejection.
- Product contracts: `npm run contracts:test`, `npm run contracts:http:ts`, and
  `npm run contracts:http:tls`. These build cold prerequisites and use owned fixtures.
  Node wire uses `npm run test --workspace @openbot/protocol`.
  `npm run contracts:check` checks generated OpenAPI/types without an interpreter.

## Control and persistence

[Control rules](../apps/server/AGENTS.md) → [app](../apps/server/src/app.ts)
→ [product entry](../apps/server/src/desktop-entry.ts).
Control owns identity, authorization, routing, approvals, budgets, task/action facts and audit.
[Work ledger](../apps/server/src/work-ledger.ts) owns durable Work facts. Web/Desktop and Node
consume these facts. The live SQL history stays in `packages/db/migrations`.

Use `npm run test:control:ts` for persisted control cohorts and `npm run test:work:ts` for
execution/recovery. Both own disposable PostgreSQL/Temporal fixtures. Schema changes use
`npm run migration:plan --workspace @openbot/db -- --name describe_change`,
`npm run migrations:check` and [the migration contract](DATABASE.md#author-a-migration).
Never alter applied SQL or run acceptance against a user database.

## Other bounded routes

| Area | Owner / entry and consumers | Validation / environment |
| --- | --- | --- |
| MCP extensions | `apps/server/src/plugin-*.ts`; [PLUGINS](PLUGINS.md); Web `Plugin*` | Control plugin tests, Web sandbox tests; synthetic MCP fixture |
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


### Work HTTP contribution checks

Shared TS owns Work/native Task, control, model/storage/attachment HTTP. `npm run contracts:generate`
writes [Control OpenAPI](../packages/protocol/generated/control-openapi.json),
[Work OpenAPI](../packages/protocol/generated/work-openapi.json) and
[compatibility types](../apps/web/src/generated/work-contract.ts); `npm run contracts:check` checks freshness.
[work-api](../apps/web/src/work-api.ts) consumes shared validators with its additive response projection.
`npm run contracts:test` builds shared dependencies and compares hash-fixed legacy fixtures.
Real HTTP/PG behavior runs in `contracts:http:ts`, `contracts:http:tls` and the Work integration gate.
The Node wire protocol remains owned by `packages/protocol`.

### CI selection and artifact qualification

Use `npm run ci:scope -- --local` for tracked/untracked work, or verified `--base SHA --head SHA`
for a committed PR. `npm run check:affected` takes the same explicit arguments and runs only the
validation lane; separate required jobs are printed. `npm run check` remains the repository total.
The actual policy is [ci-selection](../scripts/ci-selection.ts), with success-only
[aggregation](../scripts/ci-results.ts); counterexamples run via `npm run ci:check`. Read
[contribution rules](../CONTRIBUTING.md#required-ci-completion) before CI work. Current scripts and workflows determine the applicable checks.
