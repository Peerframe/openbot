# Contributor work packages

Current independent lanes, dependencies and acceptance: [Development tracks](DEVELOPMENT_TRACKS.md).

[English](CONTRIBUTOR_TASKS.md) · [简体中文](CONTRIBUTOR_TASKS.zh-CN.md)

These packages turn roadmap items into independently reviewable contributions. Open an issue from
the matching form before implementation, link the pinned upstream review, and keep every support
claim at the lowest level proven by tests.

## Next: fresh-checkout contributor smoke

Status: proposed, not delivered. Prioritize a contributor being able to work without maintainer-private setup.

- **Outcome:** one documented CI/local path proves a clean checkout can start Server/Web, sign in,
  enroll an optional development Node and restart it with the retained identity.
- **Start in:** `CONTRIBUTING.md`, `scripts`, `.github/workflows/ci.yml`, existing auth/Node fixtures.
- **Research first:** reuse the current pinned Node/npm/PostgreSQL toolchain and lifecycle tests;
  compare existing CI service/readiness patterns before introducing a runner.
- **Acceptance:** fresh private fixture paths, synthetic credentials, no paid model or user profile;
  readiness failures explain the missing service; processes and fixture data are cleaned up.
- **Out of scope:** installer publication, new Providers or an owner-only setup service.

## Next: retained-data migration regression

Status: proposed. Local upgrade evidence exists; CI does not yet retain the complete old-data fixture.

- **Outcome:** contributors can prove that the reviewed old migration prefix upgrades with retained
  appearance, Employee templates, import receipts and automation rows unchanged.
- **Start in:** `packages/db`, `scripts/verify-database.mjs`, the existing CI database job, and
  [manual migration guidance](DATABASE.md).
- **Research first:** reuse the reviewed Drizzle/Postgres.js runner and PostgreSQL transaction
  semantics from [workflow research](research/developer-workflow-refactor.md).
- **Acceptance:** a repository-owned synthetic fixture, explicit suite/environment/database mapping,
  concurrent and repeated migration, old-row equality, retained constraints, and application rollback
  that keeps applied migrations. A missing requested fixture must fail clearly rather than skip.
- **Out of scope:** rewriting migration history or claiming full cross-machine backup restoration.

## Next: consistent workspace snapshot contract

Status: coherent snapshot and independent subscription baseline implemented; a durable global ordering contract is not implemented. See [snapshot contract](WORKSPACE_SYNC.md) and `npm run test:workspace`. The existing Web optimistic projections remain a separate migration.

- **Outcome:** define snapshot revision and count semantics that another client can implement without
  reproducing the Web client's event heuristics.
- **Start in:** Server workspace queries/events, `packages/domain`, `packages/protocol`, and
  `apps/web/src/use-workspace-state.ts`; see [workspace research](research/workspace-state-refactor.md).
- **Research first:** compare maintained revisioned snapshot/event APIs and PostgreSQL snapshot
  isolation; record an ADR before changing the wire format.
- **Acceptance:** a deterministic reproduction covers counts queried at different times, active Runs
  outside the recent-Run page, duplicate events and reconnect. Define compatible behavior before
  implementation; the existing Web currently does not consume `counts.activeRuns`.
- **Out of scope:** a new global client cache framework or moving Server authority into the browser.

## Starter: accessibility regression runner

- **Outcome:** a repeatable report catches keyboard, name/role/state, and high-confidence WCAG
  regressions in the built Web app.
- **Start in:** `apps/web`, `.github/workflows`, `docs/ACCESSIBILITY.md`.
- **Research first:** compare `axe-core`, Playwright accessibility tooling, and maintained Vitest
  integrations; pin versions and licenses.
- **Acceptance:** deterministic local command; CI artifact; no live network; documented false
  positives; one fixture that proves a violation fails the gate.
- **Out of scope:** claiming screen-reader or WCAG conformance from automation alone.

## Starter: translation consistency checker

- **Outcome:** English source docs and maintained locale files cannot silently lose required safety
  warnings, commands, or configuration names.
- **Start in:** `scripts/check-docs.mjs`, `README*.md`, `docs/*.md`.
- **Research first:** evaluate documentation-lint and localization consistency tools before adding
  local rules.
- **Acceptance:** catches a deliberately missing warning/link in a fixture; does not require machine
  translation; prints the exact file and missing contract.
- **Out of scope:** judging prose quality or modifying translations automatically.

## Delivered foundation: Provider conformance runner

- **Delivered:** `@openbot/provider-conformance-runner` executes bounded, deterministic scenario
  lifecycles, suppresses raw thrown values, always attempts cleanup, applies explicit
  expected-failure baselines, and creates a new private JSON evidence file without overwrite.
- **Start in:** `packages/provider-conformance-runner`, `packages/provider-sdk`, Provider integration
  tests, and `.github/workflows`.
- **Research baseline:** pinned MCP Conformance, OCI runtime-tools, Sonobuoy, and Vitest reviews; see
  [the runner research record](research/provider-conformance-runner.md).
- **Remaining contribution:** author Provider-specific hermetic suites, connect report artifacts to
  the hosted matrix, and run named suites on controlled Windows, macOS, and Linux devices.
- **Preserve:** no raw secrets in artifacts; expected failures stay non-conformant and expire;
  real-device metadata is mandatory; the runner never self-certifies a platform.
- **Still out of scope:** a hosted certification authority or provisioning a real-device CI fleet.

## Intermediate: Agent Skills quarantine worker

- **Outcome:** an isolated Worker inspects a bounded skill directory with the official `skills-ref`
  validator and returns findings without installing or executing it.
- **Start in:** a new inspection Provider/Worker, not the Server process.
- **Research first:** Agent Skills validator, OpenClaw quarantine guidance, archive extraction
  libraries, and sandbox options.
- **Acceptance:** path traversal, symlinks, size expansion, unknown files, invalid metadata, and
  validator failure all fail closed; the Server receives only a bounded report.
- **Out of scope:** activation, host grants, autonomous skill execution, or network access.

## Completed baseline: signed Employee package design

- **Delivered:** ADR-0014 and ADR-0024 define the signature envelope, encrypted local keyring,
  explicit trust, rotation, revocation, and offline verification for `openbot.employee/v1`.
- **Start in:** `docs/decisions`, `apps/server/src/employee-package.ts`, `packages/domain`.
- **Research first:** Sigstore, in-toto, DSSE, TUF, and existing agent-package signing work.
- **Remaining contribution:** add native keyring/KMS adapters, publisher-key expiry, TUF continuity,
  and public identity/transparency without changing the DSSE package contract.
- **Still out of scope:** activation or ownership transfer.

## Delivered baseline: reviewed Employee activation

- **Delivered:** a quarantined preview becomes a new local Employee only through an exact digest,
  explicit Owner command, candidate-only skills, and immutable idempotent receipt.
- **Start in:** `apps/server`, `packages/db`, `apps/web`.
- **Research baseline:** Backstage preview/review/create, Kubernetes dry-run, and OpenClaw
  default-untrusted skills; see ADR-0025.
- **Remaining contribution:** package-family updates, registry distribution, selective-memory clone,
  richer receipt inspection, and authenticated ownership transfer.
- **Preserve:** fresh Employee id; imported skills disabled; no memory or Worker Host binding;
  idempotent exact replay; changed or duplicate activation fails closed.

## Delivered baseline: Owner-managed Employee memory

- **Delivered:** bounded Owner-only create/edit/delete, optimistic revisions, credential-value
  blocking, physical content deletion, content-free lifecycle audit, and an accessible profile
  editor. Every v1 Employee package still contains zero memories.
- **Start in:** `apps/server`, `apps/web`, `packages/protocol`, `packages/db`, and ADR-0026.
- **Research baseline:** Hermes, Letta, Mem0, and LangMem; see
  `docs/research/owner-managed-employee-memory.md`.
- **Remaining contribution:** retrieval, retention, autonomous proposal review, prompt-injection
  defenses, version restoration, redaction, and selective export.
- **Preserve:** the Server is authoritative; models and Worker Hosts cannot write Owner records;
  secrets are references only; audit never retains titles, content, or content hashes.

## Delivered baseline: Owner-managed profile details

- **Delivered:** authenticated role and biography editing, strict field bounds, PostgreSQL
  compare-and-swap revisions, content-free evolution/SSE metadata, multi-device stale-draft review,
  and biography preservation in safety-scanned Employee templates.
- **Start in:** `apps/server/src/postgres-store.ts`, `apps/web/src/components/EmployeeProfileView.tsx`,
  `packages/protocol`, `packages/db`, and the
  [research record](research/owner-employee-profile-details.md).
- **Research baseline:** Hermes profile editing/UI metadata CAS and Kubernetes `resourceVersion`.
- **Remaining contribution:** independently review and implement display-name, model/Provider,
  Worker Host, schedule, and composable-appearance editors.
- **Preserve:** prose cannot grant authority; stale writes return conflict; audit/realtime events
  never carry biography text; imported packages still create a fresh local identity.

## Advanced: proof-of-possession Node identity

- **Outcome:** replace the current individually revocable bearer credential with a rotatable,
  proof-of-possession Worker Host identity.
- **Start in:** `apps/server`, `apps/node`, `packages/protocol`, deployment docs.
- **Research first:** SPIFFE/SPIRE, mTLS bootstrap patterns, short-lived certificate rotation, and
  device enrollment threat models.
- **Acceptance:** preserve one-time enrollment and revocation; add non-exportable-key support,
  challenge/response, rotation, replay tests, Server audit, and no inbound public Node port.
- **Out of scope:** employee identity or OS account provisioning.

## Platform: native Windows, macOS, or Linux Provider

- **Outcome:** one narrowly scoped native Provider advances from Declared to Integrated with real
  target-platform evidence.
- **Start in:** `providers/<name>`, `packages/provider-sdk`, `docs/CROSS_PLATFORM.md`.
- **Research first:** use the Provider issue form and compare mature OS automation projects before
  writing an adapter.
- **Acceptance:** exact capability majors; hermetic negative cases; real-device report; local OS
  permission diagnostics; approval boundary; bounded artifacts; fail-closed cancellation.
- **Out of scope:** claiming other platforms, arbitrary administrator access, or bypassing Server
  routing and approval.
