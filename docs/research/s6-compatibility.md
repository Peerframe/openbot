# Research: S6 delegation, MCP and model preservation compatibility

- Status: experiment only; S6 remains pending
- Date: 2026-09-24
- Owner: OpenBot contributors
- Acceptance journey: synthetic channel Bots delegate through the existing Server store; the child
  uses its own MCP grant; persisted parent cancellation prevents later effects and publication;
  an authenticated loopback MCP endpoint fails without replay or restored authority.
- Security boundary: the existing Server and PostgreSQL own identity, ancestry, authorization,
  cancellation and publication. MCP declarations/results and model output remain untrusted.
- Scope: `experiments/s6-compat/**` and this document. No product wiring, production data, default
  configuration, Runtime, Worker or S4 execution changes.

## Search evidence

Reviewed before implementation on 2026-09-24:

- Migration source: `e176e90a9de3854f0bf745773b7996e7bd572c83`, matching the starting
  `codex/architecture-migration` reference. Feature source:
  `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`; inspect committed objects, not live configuration.
- Reuse ledger: [channel collaboration and asynchronous collaboration](../OPEN_SOURCE_REUSE.md),
  [MCP plugins](third-party-mcp-plugins.md), [MCP lifecycle](plugin-flow-refactor.md),
  [Temporal decision](../decisions/0046-temporal-as-recovery-owner.md),
  [Temporal SDK review](temporal-durability-review.md), and
  [migration preservation](../MIGRATION_DATA_COMPATIBILITY.md).
- GitHub searches: `modelcontextprotocol/typescript-sdk 1.30.0 streamable http session terminate
  issue 1708`, `a2aproject/A2A releases v0.3.0 delegated task authorization`, and Temporal child
  workflow cancellation/parent close policy. The earlier A2A review remains a transport comparison;
  this experiment adds no external-agent protocol.
- Primary standards: [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
  [MCP transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
  [PostgreSQL 17 locking](https://www.postgresql.org/docs/17/explicit-locking.html), and
  [Temporal parent close policy](https://docs.temporal.io/parent-close-policy).
- MCP SDK pinned [client source](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/client/streamableHttp.ts),
  installed package source and existing OpenBot real-SDK tests were inspected. Prior upstream test
  review is recorded in `third-party-mcp-plugins.md`. Current issue review includes
  [#1708](https://github.com/modelcontextprotocol/typescript-sdk/issues/1708) (expired sessions),
  [#2559](https://github.com/modelcontextprotocol/typescript-sdk/issues/2559) (JSON response cleanup),
  and [#2739](https://github.com/modelcontextprotocol/typescript-sdk/issues/2739) (lost SSE response).
  Reports inform bounded failure tests; this experiment does not reproduce every reported defect.

## Candidate comparison

| Candidate | Exact release or commit | License / maintenance / tests | Fit and decision |
| --- | --- | --- | --- |
| MCP standard and existing official SDK | 2025-11-25; SDK 1.30.0, `2d889f2b329e46680ec9bdd565de4616c497825a` | MIT SDK; released v1 line, transport/state tests and tracked lifecycle issues | Selected. Exercise OpenBot's existing bounded transport and service against the existing SDK example with a fixture-only HTTP authentication fault gate. No new protocol implementation. |
| PostgreSQL and current stores | 17.11, existing fixture image `postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` | PostgreSQL License; maintained server, transaction/advisory-lock support; existing collaboration integration tests | Selected. Separate temporary database, actual migrations and independent connections. Existing store operations are the authority under test. |
| AI SDK and Vitest | ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd`; Vitest 5.0.0 / `f441c6fab25e579c5b7dd3dd50538416f415fbae` | Apache-2.0 / MIT; existing mock model and integration tests | Selected existing locked dependencies. Deterministic model replies exercise actual runner budget composition without a paid model. |
| Temporal SDK | Python 1.33.0 / `ab52fdde33ee8ed193402625bfdba25d240a762d` | MIT; prior pinned source, workflow/activity/replay tests and cancellation issue review | Target recovery owner already selected in ADR-0046. Parent-close cancellation is not an authorization or external-effect receipt. Defer delegation integration until S2/S3 ports stabilize. |
| New synthetic authority/state machine | No dependency | Would duplicate Server grants, cancellation and budget behavior | Rejected for this deliverable: it would chiefly validate its own implementation. Use synthetic data with real implementations instead. |

## Reuse decision

The first viable option is existing standards and released dependencies through existing OpenBot
adapters. The local gap is a separately runnable cross-boundary acceptance fixture, plus an explicit
record of migration gaps. It creates only disposable synthetic data. The runner owns a loopback-only
PostgreSQL container and cleans it up; it never accepts the product database environment variable.
The MCP fault gate wraps the existing SDK example. It does not implement OAuth, JSON-RPC or a second
recovery engine. Missing prerequisites fail the command rather than silently skip scenarios.

Credential refresh must be distinguished from catalog refresh. Current `PluginService` refreshes
the reviewed manifest, supports static bearer credentials and revisioned grants, and revokes active
calls on grant/configuration changes. It has no OAuth authorization-code or refresh-token store.
The MCP standard binds tokens to the intended resource; a TCP disconnection does not establish
cancellation. This fixture can establish denial on HTTP 401 and revocation after reopening stores; it cannot
certify OAuth refresh/rotation, remote revocation, or exactly-once external writes.

## Source incorporation

No upstream source is copied or substantially adapted. The fixture reuses OpenBot's MIT
`scripts/test-runtime-headless.mjs` harness pattern and imports its existing stores, runner and SDK
example. Existing dependency notices remain in `THIRD_PARTY_NOTICES.md`; no new dependency or vendored
source is introduced.

## Verification plan

Run the standalone fixture from a fresh lockfile installation, then `npm run check`. Scenarios:

1. Parent-only MCP grant is unavailable to the actual delegated child; explicit child grant works.
2. Reopen database/store/service objects, cancel the parent, and reject a child's tools and late
   completion even if its caller-supplied ancestry fields are absent. Preserve completed results.
3. Cancellation during pending approval does not execute the write; the caller abort signal cleans
   up the pending call. This checks the service seam, not production cancellation notification.
4. Remote HTTP 401 makes a call and catalog update fail without a tool effect or automatic replay;
   local grant revocation survives reopening and does not resurrect when the endpoint recovers.
5. Independent root identities can claim concurrently; same-Bot/channel root claims serialize.
   This is not a browser-profile or workspace-file lock qualification.
6. Record actual parent/child runner web usage and distinguish existing per-Run limits from the
   target shared Task admission requirement; no aggregate limit is selected by this experiment.

## Interface dependencies and unverified work

| Owner | Required contract before product integration | Present evidence / gap |
| --- | --- | --- |
| S2 control | Server-created parent/root/child IDs, per-Bot grants, membership and current authority revisions; cancel/completion transaction ordering | Existing TypeScript PostgreSQL store can be tested; Python delegated Task/Run DTO and migration are not selected here. |
| S3 recovery | Durable child handoff receipt and deduplication; ancestor cancellation fence checked before every effect and terminal publication | Current persisted cancellation can be reloaded. No Temporal child workflow, worker crash or replay is exercised. |
| S2/S3 budget | Task-owned atomic admission/reservation, selected aggregate limits, cumulative model/tool usage, retry accounting and absolute deadline across descendants/restarts | Current runner creates a budget per `#execute` invocation; per-Run web limits are reproduced below. Root aggregate enforcement is not implemented by this runner. |
| S4 executor | Resource identity, exclusive lease/fencing and release/reconciliation after cancel; explicit browser/file grants per Bot | Only existing same-Bot/channel root claim serialization is in scope. Browser/file conflict and physical cancellation are unverified. |
| S6 connector | Credential revision and revocation fence, bounded refresh, failed/unknown effect outcome, no blind retry | Static bearer and catalog refresh only. OAuth refresh-token rotation, persistent pending approvals and effect receipt reconciliation remain open. |
| S2/S6/S7 models | Canonical per-Bot model selection, connection metadata/secret ownership, protected transfer and immutable run selection | Field map below is preservation guidance; no migration, model switch or data cutover is implemented. |

The independent contributor entry is the fixture command and its dedicated tests. It requires
no maintainer-private path, production credentials or verbal setup. CI wiring into a target job is
an integrator action because this workstream may not edit shared workflows or root scripts.

## Model configuration preservation map

This is a source-reviewed preservation map, not an approved target schema or executable migration.
`M` means migration commit `e176e90a9de3854f0bf745773b7996e7bd572c83`; `F` means feature commit
`9cc73c9e78451e572f57d142d6b9caf62ccb78e2`. Feature paths below refer to that Git tree even when
they do not exist in this checkout. Both lineages must remain recoverable.

| Source field | Target preservation requirement | Source contract |
| --- | --- | --- |
| M singleton `provider` | Preserve source value/provenance; M `moonshot` corresponds to F preset `kimi`. Other reviewed preset IDs have direct counterparts. Do not rewrite historical usage values. | M `packages/domain/src/model-providers.ts`; F `apps/server/src/model-provider-presets.ts` |
| M `baseUrl` | Preserve exact authorized endpoint; if absent, resolve using the frozen source preset before transfer. A later preset default is not migration evidence. | M `modelProviderBaseUrl()` |
| M `model` | Candidate selection field `modelId`; preserve exact spelling/provider prefix. M's 128-character restricted schema cannot ingest all F 256-character model IDs. | M `modelSettingsInputSchema`; F `packages/protocol/src/model-services.ts` |
| M `apiKey` | Protected decrypt/re-encrypt only if formats change. No plaintext or ciphertext in normal reports, DTOs, prompts or events. | M `ModelSettingsService.save()` / `#read()` |
| M `revision` | Keep UUID as source revision/provenance. It is not an F integer connection revision or a Bot profile revision. | M `ModelSettingsService`; F `PostgresModelConnectionStore` |
| M `agentEnabled`, `agentEnabledAt` | Preserve execution consent and activation cutoff independently of connection validity. Do not map them to F connection `enabled`. | M `agentSettings()` and `NativeAgentRunner.#drain()` |
| F `model_connections.id`, `name`, `preset_id`, `base_url`, `protocol`, `enabled`, `revision`, `created_at`, `updated_at` | Preserve stable IDs, metadata, revisions and disabled state. Validate protocol against preset; connection metadata grants no Bot/tool authority. | F `packages/db/migrations/0018_model_services.sql`, `PostgresModelConnectionStore`, `ModelServices.#active()` |
| F `encrypted_api_key` | Preserve matching key and AAD identity. Changing connection ID, preset or endpoint requires authenticated decryption and re-encryption. | F `apps/server/src/model-credential-cipher.ts`, `associatedData()` |
| F `bots.configuration.model = {connectionId, modelId}` | Preserve per-Bot selection and unrelated configuration keys. Switching keeps Bot identity; F updates require `computerProfile === "model"`, optimistic `profileRevision` and evolution/audit. | F `PostgresControlPlaneStore.updateEmployeeModel()` |
| F `runs.model_selection` | Preserve original queued selection. Do not backfill existing Runs from the Bot's current selection. It does not contain connection revision, endpoint or credential revision. | F `PostgresControlPlaneStore.submitTask()` / `toRun()` |
| F absent selection and `legacy-kimi` | Preserve absence and environment-backed fallback semantics. Explicit missing/disabled connection must fail, not silently fallback. Do not fabricate a persisted connection row. | F `ModelServices.resolve()` / `#legacy()`; protected `MOONSHOT_API_KEY`, `MOONSHOT_BASE_URL`, `MOONSHOT_MODEL` provenance |
| M `runs.model_usage` | Preserve observed provider/model, steps and nullable input/output token counts. Usage is not a queued model selection. | M `RunModelUsage`, `runs_model_usage_native` |
| Reviewed custom/local endpoint | M has no custom provider. F permits exact HTTPS custom endpoints in `OPENBOT_MODEL_CUSTOM_BASE_URLS`, without credentials/query/fragment. Preserve the operator allowlist independently. Ordinary HTTP localhost support and runtime reachability are not established. | F `modelBaseUrlSchema`, `ModelServices.#endpoint()`; M `modelProviderBaseUrl()` |

The key and ciphertext formats are incompatible:

| Boundary | M singleton | F connections |
| --- | --- | --- |
| Payload | Entire retained settings JSON | API key only |
| Algorithm / AAD | AES-256-GCM; literal `openbot.model-settings/v1` | AES-256-GCM; JSON `{id,presetId,baseUrl}` |
| Envelope | JSON `{version:1,nonce,tag,ciphertext}` with base64 | `v1.<nonce>.<tag>.<ciphertext>` with base64url |
| Key | 64 lowercase hex characters in `encryption.key`, or protected legacy configuration | 32 raw bytes at `OPENBOT_MODEL_CREDENTIAL_KEY_PATH` |
| Missing key | Refuses replacement beside retained settings | Existing connections cause `allowCreate:false` |
| Platform boundary | Dedicated directory/file validation and Windows ACL integration | POSIX owner/mode/`O_NOFOLLOW` checks; equivalent Windows behavior not established |

Matching preset names/protocol labels do not prove wire compatibility: M's OpenAI `agentModel()`
uses Responses, while F's `openai-chat` path uses Chat Completions. Tools, inference behavior and
recovery need their own conformance journey.

Model-switch acceptance must compare Bot IDs/profile/configuration/channel memberships; messages,
Run ancestry/terminal outcomes/queued selection/usage; memory provenance/scope/review/deletion;
skills and versions; files, attachment/object references and browser profile binding; approvals,
audit and evolution. Database/object/secret backups must be paired. Preserve both migration
histories: conflicting indices 17/18 cannot be repaired by rewriting SQL or applied records.

Required unresolved decisions: S2 owns canonical connection/selection DTOs, separate execution
consent and single-writer revisions. S3 owns model-selection provenance and reauthorization on
resume after disable/rotation; secrets must not enter workflow history. S6 owns child model
resolution and endpoint validation independent of tool grants. S7 qualifies a synthetic bridge,
paired backup/restore and rollback after new writes. This experiment runs none of the feature
branch's model migration, switch, cipher or live-provider tests.

## Verification results

- `node experiments/s6-compat/run.mjs`: six probes passed on macOS arm64, Node 22.23.2,
  Docker 29.5.2 and the pinned PostgreSQL image. Dedicated TypeScript checking passed.
- Five positive boundary probes verify independent MCP grants, persisted cancellation and retained
  completed replies, cancelled approval rejection, real SDK/HTTP 401 failure with no retry, durable
  grant revocation, and root claim serialization across two database clients.
- **Baseline `S6-BUDGET-BASELINE`:** the actual native runner completes three parent web reads and
  two child reads (five synthetic reads). Both Runs complete. `NativeAgentRunner.#execute` creates
  a new budget for each child invocation. This agrees with [current architecture](../ARCHITECTURE.md)
  and [asynchronous collaboration](../ASYNC_COLLABORATION.md), which define per-Run limits and a shared
  root deadline. [Capability inventory C11](../MIGRATION_CAPABILITIES.md) instead says the budget is
  shared; that inventory statement is not supported by this code/probe. Record this documentation
  mismatch for the integrator without changing shared files here. The target
  [work contract](../WORK_EXECUTION_CONTRACT.md) requires shared Task admission; its limits and
  durable accounting belong to S2/S3. This is a pending S6 capability, not evidence that the current
  per-Run four-call limit was bypassed.
- Reload means fresh PostgreSQL clients and plugin store/service objects in one test process.
  Process death, Temporal replay, runtime cancellation propagation and durable approval recovery
  are not tested. HTTP 401 exercises a static bearer failure; OAuth refresh remains absent.
- `npm run check`: passed. Documentation/research/migration/release/security checks and root lint
  completed; unchanged workspace typecheck, test and build tasks reused successful Turbo cache
  entries. The standalone six-probe fixture ran afresh and is not part of those cached tasks.
- Dedicated formatting/lint, TypeScript and `git diff --check` passed. No fixture containers remain.

S6 is not complete and no default is activated. The standalone fixture plus model field map is the
first deliverable; the table above defines the next integration dependencies.
