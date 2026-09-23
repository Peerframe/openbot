# Architecture migration delivery plan

[English](ARCHITECTURE_MIGRATION_PLAN.md) · [简体中文](ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)

Status: active, 2026-09-23. This plan governs the remaining migration, not only the
accepted Python execution slice. A completed stage does not complete the overall goal.

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

## Baselines and completed foundation

- Migration source: `codex/architecture-migration`, `c33e03f1a14de739196113769c59fdaace9029e7`.
- Separate feature source: `feat/cross-platform-employees`, `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`.
- Accepted foundation: bounded Python SDK loop, supervised process adapter, real Server/PostgreSQL
  deterministic journeys, opt-in startup selection, optional Python container and locked dependencies.
- TypeScript is still the default. Python owns neither the business database nor actual provider
  credentials. These checks do not prove live model quality, crash continuation or a full Python backend.
- The feature source includes human-operated employee browser sessions and model connections which
  must be reconciled explicitly. Do not add the capabilities of two checkouts and call them one release.

## Ordered stages

| Stage | Deliverable | Exit evidence | State |
| --- | --- | --- | --- |
| S1 — Reconcile and freeze preservation scope | Source-backed capability/retirement matrix, both migration histories, data compatibility risks, target API/event ownership, reversible source checkpoints | Every target capability mapped to current evidence and an owning stage; divergent SQL histories detected; no private data copied | Complete (source scope; no data cutover) |
| S2 — Python control layer and compatible clients | Research-backed FastAPI/Pydantic reference; identity/auth, Bot/channel/message APIs, task/approval/usage/audit/artifact/schedule services, generated client and defined snapshot/event behavior | S2a authenticated read/identity journey; S2b task/tools/approval single-writer journey; S2c settings/files/schedules and client parity. Same fixtures against selected implementations; no double dispatch or production shadow writes | Pending |
| S3 — Durable tasks and recovery | Durable transitions/checkpoints, approval wait/resume, cancellation, reconciliation of unknown effects, explicit per-effect retry policy and shared budgets | Kill/restart before and after dispatch/commit/approval; completed work retained; unknown external writes not blindly repeated; client disconnect independent of execution | Pending |
| S4 — Persistent execution and deliverables | Linux browser sessions, human takeover, reviewed autonomous browse/form/upload/download, persistent workspace, restricted commands, isolated code changes and document tools | Real local fixture site with separate Bot profiles; approved write, takeover, cancel and restart; exported files open/render; isolated repository produces a tested patch | Pending |
| S5 — Memory, skills and learning evaluation | Scoped relevant retrieval, candidate lessons/skills from correction and supported teaching, version/review/test/disable/rollback; separate evaluation tooling | A correction becomes a reviewed skill, improves a held-out task, and can be revoked; provenance/scope/deletion preserved; no authority increase. Preserve Hermes attribution | Pending |
| S6 — Collaboration and extensibility | Existing delegation preserved through durable execution, shared resource/budget constraints; MCP authentication lifecycle and compatibility; preservation/migration of per-Bot model configuration and reviewed local endpoints | Delegated browser/file work with independent grants; conflict/cancel tests; connector refresh/revoke/failure cases; model switch keeps identity/data; independent module contribution fixture | Pending |
| S7 — Consolidate, migrate and qualify | Synthetic old-data upgrades and full backup/restore; thin Desktop/Web/mobile-browser supervision; reversible retirement packages, default-selection and release preparation | Full product journey, fresh-checkout checks, target CI and explicit live-provider evaluation. Final production/publication actions remain separately visible; no unsupported platform claims | Pending |

S2 has three separately accepted slices; never merge all business state at once. S3 informs S4's
execution receipts and retry policy. S5 can proceed independently after stable S2 task/artifact
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

- S1 source reconciliation: 17 identical SQL migrations followed by two timestamp/hash conflicts;
  the committed-source preflight rejects both divergent histories and unsafe inputs. Existing
  runtime migration guards remain unchanged. No existing database was inspected or changed.
- Real Git preflight fixtures and the required full `npm run check` pass. S2 implementation
  acceptance is recorded separately.

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
