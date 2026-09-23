# Architecture migration delivery plan

[English](ARCHITECTURE_MIGRATION_PLAN.md) · [简体中文](ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)

Status: active after renewed user approval, 2026-09-23. This is the single delivery plan.
The latest approved direction prioritizes long-term product quality over migration effort.
A completed stage does not complete the overall goal.

## Product and final architecture

Deliver a self-hosted digital colleague that retains its identity and work, completes
bounded cross-tool tasks, accepts supervision, safely resumes interrupted work, and reuses
reviewed lessons. Keep one main repository: TypeScript/React Web and a thin Electron client;
Python business/authority control layer and independently testable Python Agent Runtime;
PostgreSQL plus files; isolated Linux browser, workspace and command execution. Reuse mature
execution backends. Rust is optional and requires a demonstrated host requirement.

The Server is a responsibility and authority boundary, not a requirement to retain TypeScript.
During migration the existing Server is authoritative; each migrated responsibility has exactly
one selected writer. Credentials, approvals and terminal task publication never become model authority.
The old TypeScript business backend is transitional, not a second permanent product backend.

See the [work execution target contract](WORK_EXECUTION_CONTRACT.md) for identity, recovery,
action outcomes, budget and the next complete acceptance journey.

## Approved design constraints and immediate order

The target is a work-centered product, not a line-by-line translation of the old Server.
Bot is persistent identity; Task is the user's objective; Run is an execution attempt;
Action is an individually authorized effect; Artifact is an independently accessible result.
Chat and channels are interaction surfaces, not the authority for work lifetime. These are
responsibility definitions, not an approved SQL schema or a requirement for more services.

The Python backend stays modular. Runtime proposes decisions; the control layer owns policy,
budgets, approvals and durable outcomes. A mature workflow engine owns recovery orchestration;
an action receipt and reconciliation policy handle the gap between external effects and local
commits. Neither engine replay nor a tool-call ID proves an external write happened exactly once.
A process, virtual environment or container alone does not establish the required isolation.

The next sequence is **S3 recovery selection and S4 isolation design → S2/S3 task vertical
slice → remaining S2 client/API coverage → S4 real work → S5/S6/S7 qualification**. Stage IDs
remain stable for prior evidence. Do not finish translating CRUD before making these decisions.
Compare pinned DBOS and Temporal releases against process-crash, approval-wait, cancellation,
authority-revocation, duplicate-dispatch and uncertain-effect cases. Select one recovery owner;
do not stack independent retry engines. Keep the first experiment separate from production.

Existing work is classified as product invariants, candidate implementations, or transitional
facilities. Preserve useful tests and fixes; candidate code must earn acceptance. Session
interoperability and partial backend modes need an eventual exit. Source/schema/API redesign
is allowed when justified by the target behavior; old user data and migration history remain
protected. Language changes require new evidence, not competitor fashion or sunk-cost reasoning.

The assisted Temporal worker and independent Codex fault runner have completed local qualification.
The work-domain admission slice now persists independent Tasks, exact Action approvals, shared
reservations and unresolved outcomes; it has no dispatcher. Next: qualify the official SDK durable
adapters alongside deferred continuation, then connect the public Task/approval/effect/reconciliation/
artifact journey. Production persistence and execution isolation remain engine-selection gates.
Unsent TASK_015 model settings work is superseded as the next task. Its existing uncommitted
research/dependency changes remain preserved and are not accepted or activated by this decision.

## Baselines and completed foundation

- Migration source: `codex/architecture-migration`, `c33e03f1a14de739196113769c59fdaace9029e7`.
- Separate feature source: `feat/cross-platform-employees`, `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`.
- Accepted foundation: bounded Python SDK loop, supervised process adapter, real Server/PostgreSQL
  deterministic journeys, opt-in startup selection, optional Python container and locked dependencies.
- TypeScript is still the default. Python control has explicitly selected database writes and local lifecycle tests through
  `5beed49`; the public execution dispatcher and production provider/tool composition are incomplete.
  These checks do not prove live model quality, crash continuation or a complete Python product.
- The feature source includes human-operated employee browser sessions and model connections which
  must be reconciled explicitly. Do not add the capabilities of two checkouts and call them one release.

## Ordered stages

| Stage | Deliverable | Exit evidence | State |
| --- | --- | --- | --- |
| S1 — Reconcile and freeze preservation scope | Source-backed capability/retirement matrix, both migration histories, data compatibility risks, target API/event ownership, reversible source checkpoints | Every target capability mapped to current evidence and an owning stage; divergent SQL histories detected; no private data copied | Complete (source scope; no data cutover) |
| S2 — Python control layer and compatible clients | Research-backed FastAPI/Pydantic reference; identity/auth, Bot/channel/message APIs, task/approval/usage/audit/artifact/schedule services, generated client and defined snapshot/event behavior | S2a authenticated read/identity journey; S2b task/tools/approval single-writer journey; S2c settings/files/schedules and client parity. Same fixtures against selected implementations; no double dispatch or production shadow writes | In progress: S2a identity/authentication slice accepted locally; S2b queued submission/read and control host/process seam accepted locally; persisted lifecycle accepted locally; next: recovery/domain decision before dispatcher expansion |
| S3 — Durable tasks and recovery | Durable transitions/checkpoints, approval wait/resume, cancellation, reconciliation of unknown effects, explicit per-effect retry policy and shared budgets | Kill/restart before and after dispatch/commit/approval; completed work retained; unknown external writes not blindly repeated; client disconnect independent of execution | In progress: fault probes, fenced work authority and verified artifact publication; no engine selected yet |
| S4 — Persistent execution and deliverables | Linux browser sessions, human takeover, reviewed autonomous browse/form/upload/download, persistent workspace, restricted commands, isolated code changes and document tools | Real local fixture site with separate Bot profiles; approved write, takeover, cancel and restart; exported files open/render; isolated repository produces a tested patch | Pending |
| S5 — Memory, skills and learning evaluation | Scoped relevant retrieval, candidate lessons/skills from correction and supported teaching, version/review/test/disable/rollback; separate evaluation tooling | A correction becomes a reviewed skill, improves a held-out task, and can be revoked; provenance/scope/deletion preserved; no authority increase. Preserve Hermes attribution | Pending |
| S6 — Collaboration and extensibility | Existing delegation preserved through durable execution, shared resource/budget constraints; MCP authentication lifecycle and compatibility; preservation/migration of per-Bot model configuration and reviewed local endpoints | Delegated browser/file work with independent grants; conflict/cancel tests; connector refresh/revoke/failure cases; model switch keeps identity/data; independent module contribution fixture | Pending |
| S7 — Consolidate, migrate and qualify | Synthetic old-data upgrades and full backup/restore; thin Desktop/Web/mobile-browser supervision; reversible retirement packages, default-selection and release preparation | Full product journey, fresh-checkout checks, target CI and explicit live-provider evaluation. Final production/publication actions remain separately visible; no unsupported platform claims | Pending |

S2 retains three separately accepted slices. S3 selection and the S4 execution boundary now
precede further S2 expansion; this order implements the renewed long-term product decision. S3
informs S4's execution receipts and retry policy. S5 can proceed independently after stable S2 task/artifact
contracts. S6 depends on those contracts, not on every optional file processor. Reassess order only
when new source or experiment evidence changes a dependency; record the reason here.

## Coverage of the twelve target capabilities

| Target | Owning stages |
| --- | --- |
| 01 Persistent Bot identity | S1 preservation, S2 migration, S7 acceptance |
| 02 Private chats and collaboration channels | S2 API/client parity, S7 acceptance |
| 03 Multi-step execution | Accepted loop, S2 authority, S3 recovery, S4 real tools |
| 04 Persistent work environment | S3 receipts, S4 workspace and browser |
| 05 Browser and tool operations | S4 execution, S6 connector compatibility |
| 06 Files and code delivery | S2 artifact authority, S4 processors/workspace |
| 07 Approval and human takeover | S2 approval state, S3 recovery, S4 control |
| 08 Background, schedules and safe recovery | S2 schedules, S3 durability, S7 lifecycle |
| 09 Scoped long-term memory | S5 retrieval and provenance |
| 10 Skills and teaching reuse | S5 review, evaluation and rollback |
| 11 Responsible multi-Bot collaboration | S6 delegation, shared budgets and conflicts |
| 12 Open tools, execution backends and model configuration | S6 compatibility and independent contribution |

Target file operations cover text/code, Markdown, CSV/JSON, PDF, DOCX, XLSX and PPTX. Record
read/extract/create/edit/render separately; no promise of arbitrary format fidelity. OCR,
transcription, image generation and specialist processors remain optional extensions.

## S1 authority and preservation baseline

The [capability inventory](MIGRATION_CAPABILITIES.md) maps all twelve targets and retirement
candidates to evidence; [SQL compatibility](MIGRATION_DATA_COMPATIBILITY.md) records the incompatible
histories. Full commit IDs above are recovery references for source, not user-data backups. Original
uncommitted files and runtime data are outside this migration's write scope.

| Responsibility | Current authority | Target authority and gate |
| --- | --- | --- |
| Owner sessions, Bot identity, channel membership, settings | TypeScript Server and PostgreSQL/encrypted settings | Python control layer in S2; compatible IDs/DTOs, explicit writer selection |
| Task transitions, approvals, cancellation, audits, artifact registration | Server-owned database state and policy | Python control layer in S2/S3; transaction/receipt and revocation checks |
| Strategy, context assembly, delegation suggestions, lessons | Bounded runtime proposals; Server verifies effects | Replaceable Python Runtime; no credential or policy ownership |
| Browser/workspace effects and human control | Enrolled Worker/backend plus Server approval | S4 isolated executor; scoped grants, durable receipts and human veto |
| Client snapshots and events | Server data and transient realtime notifications | S2 defines revision/cursor/reconnect semantics; clients are projections, never writers of authority |
| Learned memory/skill eligibility | Owner-reviewed persisted facts | S5 review/version/scope gates; runtime cannot approve itself |

S1 freezes ownership, not a speculative new event protocol. Exact snapshot revisions and durable
cursor behavior are S2 deliverables validated by duplicate/out-of-order/reconnect fixtures.

## Acceptance record

- Work publication extends the admission slice with migration `0028`, monotonic attempt claims,
  guarded final publication and authenticated byte-verified Artifact downloads. Real HTTP process
  restart preserves pending approval and committed Task state. File/audit failure, cancellation
  during staging, supersession and claim expiry cannot publish success. This is a control/file
  reference; the deterministic workflow fixture does not yet integrate an engine or external tools.
  The owned PostgreSQL/HTTP gate passes 119 cases; Python package checks pass 810 cases with the
  119 database cases run separately, and `npm run check` passes. Local POSIX evidence does not
  qualify production storage or Linux isolation. See [publication research](research/work-artifact-publication.md).

- Runtime continuation: 14 pinned-SDK cases independently pass with fresh interpreter processes.
  One already-completed read executes once; resume adds one model call and carries request counts
  from 2 to 3. Invalid continuations are checked before extra model/tool work. A tampered but
  structurally valid history is accepted by SDK validation, so control-owned provenance remains
  required. Official granular durable adapters remain candidates; SDK IDs are not business Run IDs.
  Full Python package checks pass (788, with 105 DB cases run separately); repository checks pass.

- Work-domain admission: additive migration `0027` introduces independent Task/Run identities,
  an atomic pending handoff, immutable Actions, exact expiring approvals, Task-scoped budget
  reservations and revisioned events. Ten new owned-PostgreSQL cases pass (105 in the combined
  control gate), including concurrent submission/reservation, conflicting approvals, revoke,
  cancellation with unknown effects, overrun accounting and transaction rollback. ASGI clients
  can close and reopen against the same committed snapshot; this is not browser/SSE reconnect
  or real-worker recovery. At that checkpoint there was no engine bridge, public resolution
  endpoint or artifact completion path; the publication slice above adds the last of these only. See [scope and research](research/work-domain-admission.md).

- Renewed-direction experiment: [ten local DBOS fault cases](../experiments/durable-execution/README.md)
  pass with actual killed/restarted Python processes, disposable PostgreSQL and independent fake HTTP
  effect counts. The negative control repeats an unsafe write; the intent guard stops with an unknown
  outcome. Approval persists across worker absence; current revocation prevents dispatch; cancellation
  preserves already-applied effects. This is candidate evidence, not S3 completion or production selection.
  The controlled stale-worker case requires effect-boundary fencing. The current Task/Run/Action
  boundaries still require an integrated domain and client journey.
- WorkBuddy's pinned [Temporal source review](research/temporal-durability-review.md) was independently
  checked and corrected for business/engine identity and cancellation boundaries. The subsequent
  [12-case local Temporal probe](../experiments/durable-execution/README.md#temporal-observations)
  passes with pinned SDK/CLI/Server and development SQLite history. Its explicit shielded-action
  cases and first failed assertion are documented; this is not production deployment or selection.


- S1 source reconciliation: 17 identical SQL migrations followed by two timestamp/hash conflicts;
  the committed-source preflight rejects both divergent histories and unsafe inputs. Existing
  runtime migration guards remain unchanged. No existing database was inspected or changed.
- S2a-1/2: separate Python reads and explicitly selected Owner login/logout, OpenAPI, exact-history
  guard and persistent auth throttling are implemented. 198 local package cases and nine owned
  PostgreSQL/real-HTTP cases pass, including both directions of TS/Python session revocation and
  failure rollback. DeepSeek's 128 projection cases were independently reviewed; stricter invalid
  legacy-state behavior is documented and exercised against PostgreSQL. No default/backend switch.
- S2a-3: explicit Bot/channel creation and atomic identity/member/audit transactions are implemented.
  Nineteen combined PostgreSQL/HTTP cases pass, including conflict, partial-failure rollback,
  revocation while waiting, expiry before commit and TS readback. The worker's inputs and generated schema were independently reviewed: 253 package checks and
  81 real Zod/Python differential cases pass; nineteen fixture-only cases also passed against
  PostgreSQL/HTTP. Source notices are bundled with the Python package. Earlier auth Unicode bounds were
  corrected to installed Zod's code-point semantics.
- S2a-4: direct-conversation singleton creation and idempotent ordinary-channel joins are accepted.
  Owner transactions are shared with identity creation. 275 package checks and 24 combined real
  PostgreSQL/HTTP checks pass, with TS readback and all 81 input differential cases retained.
  Concurrent creation/joins, exact audits, rollback and malformed-member refusal are exercised.
- S2a-5: authenticated latest-100 message reads match the actual TS fixture and real loopback HTTP.
  The final package has 288 cases; 29 combined PostgreSQL/HTTP checks and 81 input comparisons pass.
  Text transfer and JSON have independent 4 MiB guards; deterministic ties and revocation during
  reads are covered. No message dispatch is enabled.
- S2a-6: optimistic Owner profile-detail edits commit the Bot revision, evolution and audit together.
  316 final package cases, 35 combined real PostgreSQL/HTTP cases and 105 actual Zod/Python input comparisons pass,
  including concurrent edits, rollback, revoked/expired sessions and TS profile readback. Shared
  HTTP authorization preflight retains the locked database recheck.
- S2b-1: explicit atomic queued task submission and latest-50 Run reads are locally accepted.
  345 package cases, 45 combined PostgreSQL/HTTP cases, 129 real input comparisons and 60 actual
  TS/Python routing/Run projection comparisons pass. Exact audits, complete multi-recipient rollback,
  same-channel replies, direct scope, concurrent timestamps and TS readback are covered.
  WorkBuddy DeepSeek supplied inputs/routing/projections; the integrator owns SQL/HTTP and independent
  acceptance. Actual file references fail closed pending S2c; no task executor is attached yet.
- S2b-2 control host/process seam: 651 local package cases pass, including 83 process/actual-SDK
  cases and 49 host authority cases; 48 actual TS/Python wire comparisons pass. The existing 45
  database cases pass separately. DeepSeek supplied the codec/process draft and adversarial fixtures;
  the integrator implemented the host and corrected cancellation/early-PID ownership with independent
  regressions. No runtime credential or default backend change. Linux qualification is recorded in
  [the supervision evidence](research/python-control-runtime-supervision.md).
- S2b Owner run commands: cancel/steer are available in the explicit task reference. Cancellation
  atomically settles the native target and eligible active descendants; steering retains at most
  eight Owner corrections under the same Run lock. 71 combined real PostgreSQL/HTTP cases pass,
  including actual concurrent writers, audit rollback, expiry during row contention, node/profile
  refusal, bounds and TS cancellation/steering readback. Final Python package: 728 passed, 71
  fixture-only skips independently verified; 34 actual Zod command comparisons and full npm check passed. This is persisted command authority;
  process/plugin notifications, execution dispatch, completion and realtime remain unfinished.
- S2b persisted lifecycle: 95 combined PostgreSQL/HTTP/SDK cases pass, including 24 new claim,
  context, usage, failure, completion and real-worker cases. Completion retains files, revision-bound
  memory/skills, pending proposals and Owner corrections. Actual TS reads the result/context and
  owned file digests match committed metadata. DeepSeek supplied pure values/tests and the actual
  40-case TS comparator; Root implemented SQL/integration and hardened nested metadata validation.
  Final acceptance: 766 package cases, 95 separately executed fixture cases, all paired contracts
  and full npm check pass. Public task dispatch and real tool/model/approval composition remain unfinished.
- The S2a identity/authentication journey is locally accepted. Further S2b tool/model/approval
  and dispatcher work now follows the recovery/domain decision above; previous next-task wording
  is superseded. Preserve the [authority review](research/python-task-authority.md).
  The aggregate profile read includes task, approval, artifact, skill and memory projections and
  moves with S2c client parity; do not publish empty substitutes. Task submission is atomic in S2b-1; member removal remains with S2b cancellation: the
  existing source atomically creates runs with messages and cancels runs/approvals when removing
  a member. Splitting those writes into an earlier chat-only slice would break current authority. Realtime/client parity is still unfinished.
- Hosted Linux checks are wired into the existing Python CI job; they have not run for this local
  unpushed change. Full checks and commit references are recorded at integration.

## Work allocation and review

The integrating developer owns architecture, public contracts, permission/data/lifecycle code and
independent acceptance. One assisted implementation worker owns a bounded file list at a time,
with frozen inputs, expected outputs and checks. Use short task cards and file-based handoffs;
do not reread entire chat histories or repeat unchanged checks. Parallel work must not share writes.
A worker's summary is not acceptance: inspect the diff and run relevant independent verification.
Each behavioral slice records pinned primary-source reuse evidence before implementation and updates
English/Chinese public documentation. Run the repository-required full check before integration.

## Preservation and retirement

Keep Bot identity/configuration, conversations, tasks, files, reviewed knowledge/skills, approvals,
cancellation, audit, schedules, model configuration and useful import/export. Source retirement
candidates are Swift/C# host exploration, their superseded install chains, office visualization,
unimplemented Provider placeholders and replaced TypeScript backend code. Preserve necessary
credential protection, authorization, licenses, migration history and effective security tests.

Retirement requires a capability decision, dependency/build/CI impact, replacement evidence, a
source recovery reference and a tested data path. Do not delete private data or uncommitted work.
Native mobile apps, all-OS local computer control, employee trading, full plugin marketplace,
enterprise billing/multitenancy and autonomous model training are outside this completion scope.

## Overall completion

A user creates a Bot, uploads a spreadsheet, checks records on a fixture business site, delegates
an independent check, approves a concrete external change, closes/reopens the client, survives an
intentional service interruption, receives a usable result file, and teaches a rule reused on a new
input. Prove model replacement preserves assets, revocation cannot be bypassed, and old synthetic
data can upgrade and restore. Separate deterministic/local evidence from live external evidence.

No stage is complete from directories, translated source, passing mocks or deleted old files alone.
Keep this goal active while required development remains. Publication, live production changes and
irreversible cleanup require concrete prepared results and applicable authorization.
