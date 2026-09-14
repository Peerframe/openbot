# Research: shared task and attachment flow

[English](task-flow-refactor.md) · [简体中文](task-flow-refactor.zh-CN.md)

- Status: Accepted for implementation
- Date: 2026-09-14
- Owner: @yxflc11
- Baseline: OpenBot `3a02750e8851298a1b27246fd1ac4925f319fdc1`
- Acceptance journey: a processed attachment reaches the actual Agent; an automatic task retains
  its attachments before its first run and stops with a visible reason when a reference fails.
- Security boundary: Server remains authoritative for identity, membership, tool scope and audit.
  Models, attachments and Provider declarations do not grant authority.

## Search evidence

Reviewed the reuse ledger's native Agent, channel attachment and recurring task entries, plus
[native Agent](native-agent-loop.md), [attachments](channel-attachments.md), and
[automations](server-automations.md). Searches on 2026-09-14: `vercel ai ToolLoopAgent tools
activeTools`, `PostgreSQL 17 explicit locking SKIP LOCKED deadlocks`, and `pg-boss transaction
queue`. Inspected the pinned GitHub source and test directories, release metadata and open issues.

| Candidate | Exact reviewed release / commit | License and evidence | Decision |
| --- | --- | --- | --- |
| PostgreSQL explicit locking | PostgreSQL 17 semantics; existing 17.11-bookworm test image | PostgreSQL License; [locks and deadlocks](https://www.postgresql.org/docs/17/explicit-locking.html), [SELECT](https://www.postgresql.org/docs/17/sql-select.html); existing real migration/automation fixtures | First viable standard: keep database row locks, transactions, next-occurrence audit and no replay. Acquire the existing file mutation lock before any transaction that validates attachment references. |
| AI SDK | ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd` | Apache-2.0; [agent source and tests](https://github.com/vercel/ai/tree/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/agent), [tool API](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling); Node platform matches | Keep the released ToolLoopAgent. Build one scoped tool map, wrap each execution for audit, and validate reported tool names against that map. No replacement loop or dynamic permission surface. |
| pg-boss | 12.26.0 / `31a4cf0093b0df73d077782689b738bcd0292021` | MIT; [release](https://github.com/timgit/pg-boss/releases/tag/12.26.0), `src/plans.ts` fetchNextJob, concurrency/transaction tests inspected | Maintained queue, but does not own OpenBot's file lock, membership or atomic Message/Run contract. PostgreSQL is already the first viable option. No queue dependency. |
| Shared schema implementation | Existing Zod 4.5.4 and OpenBot protocol package | MIT; existing exact-pinned dependency and protocol tests | Move pure attachment descriptors, media/extension limits and operations to the existing protocol package. Retain byte sniffing, storage and authority in Server. |

AI SDK [issue 14170](https://github.com/vercel/ai/issues/14170) discusses changing activeTools
between steps and prompt caching; this change keeps a fixed map per Run and does not rely on
activeTools as an authority check. pg-boss open proposals 890/899/901 concern transactional workers
and controllable clocks; they do not replace the existing Server transaction or file lifecycle.

### Continuous PostgreSQL acceptance

The pre-merge review of `11ac702ca1fb3dd389adf8d97f9a8b09fe1e9714` found that the new attachment
integration suite required `OPENBOT_ATTACHMENT_TEST_DATABASE_URL`, but no CI step supplied it.
The ordinary test command therefore skipped this PostgreSQL acceptance journey. On 2026-09-14,
reviewed GitHub's [PostgreSQL service-container guide](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
(GitHub search: `repo:github/docs creating PostgreSQL service containers`) and PostgreSQL 17's
[`CREATE DATABASE` contract](https://www.postgresql.org/docs/17/sql-createdatabase.html).
Runner-hosted jobs reach the service through its published loopback port; database creation uses
the existing privileged fixture connection outside a transaction.

Reuse the existing `database` job, its healthy `postgres:17.11-bookworm` service, Postgres.js 3.4.9
(Unlicense), Vitest 5.0.0 (MIT), and Node 22.22.2. Keep the existing pinned
[`actions/checkout` v7.0.1](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1)
and [`actions/setup-node` v7.0.0](https://github.com/actions/setup-node/tree/820762786026740c76f36085b0efc47a31fe5020)
(MIT) unchanged. This is the first viable existing adapter; a new runner, container framework or
dependency adds no missing capability. Add only a dedicated `openbot_attachment_test_ci` database
and the explicit attachment-suite command, preserving every existing integration-suite command.
The fixed database name satisfies the suite's destructive-fixture guard. The job owns its
disposable service; no application data, production credentials or deployment is involved.
No upstream source is copied or substantially adapted.

## Implementation and compatibility

- Extract the existing Message/Run SQL submission and pure row mappers from the broad store;
  reuse them without changing routing, cancellation or audit.
- Share one attachment-reference policy between interactive submission and automatic task
  create/resume/due execution. A lock-scoped validator never reacquires the file lock from a DB
  transaction. Keep the existing 50 schedules / 10 due batch / transaction timeout bounds.
- All persisted schedules, including paused schedules, retain references until deletion. Cleanup
  checks complete messages, Runs and schedules. Deleted/corrupt/missing files prohibit new Runs;
  an occurrence records `attachment_unavailable` and disables the schedule without exposing paths
  or file contents. Existing Runs retain their historical attachment access.
- Keep old persisted records, appearance and employee package formats readable. The new automatic
  outcome is additive; show a Chinese repair instruction. Append one migration extending the existing outcome CHECK constraint; never modify applied SQL.
  Existing schedules themselves are durable reference owners, so no reference table is added.
- Move public attachment DTOs/limits without changing HTTP names or values. Keep Server-specific
  signature validation and existing error compatibility. No dependency upgrade is necessary.

## Source incorporation

No upstream implementation copied or substantially adapted. Existing OpenBot code is moved;
the Apache-2.0/MIT/PostgreSQL notices already retained remain applicable. An adapter replacement
must preserve Server authority, fixed budgets and file-before-database lock ordering.

## Verification plan

- Real executeAgentRun with deterministic SDK model: processed PDF/Office/OCR/audio alone, plain
  text and binary input, correct observations, invalid tool names and revoked scope.
- Temporary PostgreSQL + real file storage: creation/resume validation, retention before first
  run and while paused, deletion release, soft deletion/corruption, competing due claimers,
  cleanup/creation races, membership removal and transaction rollback.
- CI's PostgreSQL job explicitly runs `task-attachment-references.integration.test.ts` with
  `OPENBOT_ATTACHMENT_TEST_DATABASE_URL` set to its dedicated loopback fixture; the ordinary
  environment-free test run is not evidence for that suite.
- Shared Web/Server descriptor and file limit tests; existing attachment API suites; actual Web
  and Desktop renderer checks; full npm run check. No paid models or real user data.

## Unresolved questions

None for this slice. Cross-process shared filesystem locking, calendar scheduling, new Providers
and product avatar redesign remain outside the approved scope.
