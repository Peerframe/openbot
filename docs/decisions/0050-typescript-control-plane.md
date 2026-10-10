# ADR-0050: Move the control plane to TypeScript by route group

- Status: Accepted — Owner approved P0–P5 execution on 2026-10-06
- Date: 2026-10-06
- Owner: @yxflc11
- Input: [PR #192](https://github.com/Peerframe/openbot/pull/192), plan at
  [`d6d383ee137f501248f8d2431d5d9f2c7bd0acee`](https://github.com/Peerframe/openbot/blob/d6d383ee137f501248f8d2431d5d9f2c7bd0acee/docs/research/typescript-control-plane-plan.md)
- Evidence: [P0 dependency review and baseline](../research/typescript-control-plane-p0.md)
- Acceptance: unchanged Web/Desktop journeys and public contracts against one TS entry; preserved
  data and authority; Python removed from product installation and mandatory setup/CI.

## Context and alternatives

The Owner prioritizes one language, simpler installation, then measured startup/memory gains.
Language changes cannot accelerate provider, PostgreSQL or Temporal service latency. The active
product is Python; the retired `apps/server` and frozen TS oracle cannot be reactivated as a product
shortcut. Existing uncommitted work belongs to its current authors and is outside this ADR.

The plan reopens the language choice in [ADR-0046](0046-temporal-as-recovery-owner.md) and
the architecture migration record. It preserves Temporal as the
sole recovery owner and the Server as the sole authority. Approval changes the *target direction*;
the current Python implementation remains active until each replacement passes its gate.

| Option | First usable result | Integration and operations | Maintenance and fit |
| --- | --- | --- | --- |
| Keep Python | Existing product works immediately | Least change and lowest migration risk | Retains two core toolchains and Python distribution; fails the requested language target |
| Rewrite and switch once | Parity arrives only after the whole port | All behavior, data and recovery risks accumulate at one switch | One final language, but poor incremental delivery and rollback |
| Replace route groups behind one entry | Contracts, then a working entry forwarding to Python | Temporary two-service packaging, per-group transactions and rollback qualification | Meets the target with usable checkpoints; recommended |
| Permanent TS/Python split | Some TS routes can land early | Permanent interprocess contracts and two runtimes | Does not deliver Python retirement; reject as the final architecture |

## Decision

Use a new `apps/server-ts`, with **Fastify 5.12.5** for the Node HTTP lifecycle, existing
**Zod 4.6.2** in `packages/protocol` for public contracts, and existing **Postgres.js 3.4.9 +
Drizzle 0.45.2** for persistence. The plan's node-postgres suggestion is a candidate, not a reason
to replace a working driver during a language migration. Reviewed alternatives, exact versions,
licenses, sources and unresolved qualifications are in the P0 evidence.

Use **OpenAI 7.28.0**, **@anthropic-ai/sdk 0.131.0**, and **Temporal TS SDK 1.24.0** as the reviewed
transport/recovery targets. These are approved target pins, not installed dependencies or proven product
integrations. Install them only in their applicable approved phase, with a lockfile, notices,
advisory check and affected acceptance. Review a changed pin at that time if necessary.

### P1: one contract definition, no behavior change

`packages/protocol` owns all public requests, responses, errors and events, including retained
Node/Worker wire contracts. Inventory the actual product route registrations, Web/Desktop/Node
consumers, SSE, WebSocket and binary/upload/download surfaces; the frozen oracle is supplemental
compatibility input. At P0 only retained wire schemas were TS-authoritative and Work HTTP types
were generated from Python. P1 now moves Work/native Task, core identity/auth/workspace/read and
model/storage/attachment/artifact, lifecycle/approval/audit, Employee/automation/Node/plugin, browser and
portability HTTP schemas and generation to TS (121 default actual operations, including the integrated C9 appearance route); domain identity/session/message/Run/model/Employee/Node/portable types
derive from those validators; Web plugin HTTP types use strict shared schemas with an explicit
optional-result projection. Browser HTTP has a strict session type and an explicit additive Web projection.
Configured publisher HTTP now has a separate real ephemeral-keyring contract suite; actual Web/Desktop
settings PUT and Owner attachment composition pass against real Python using Node Fetch. The inventory
records reviewed consumer source digests and registrar/composition boundaries. A separate synthetic-provider
composition now qualifies OpenAI Chat/Anthropic discovery and explicit SDK probe HTTP, with bounded receipts.
Native Work decisions and reconciliation are qualified against real HTTP/SQL publication fixtures.
Existing TS types alone do not establish complete contract coverage.

The P1 gate covers all actual default public registrations, reviewed consumers, current Node/Worker
wire definitions and separately configured publisher/provider HTTP variants. Current product mode
already supplies all registrars; optional Temporal/browser/command composition changes execution of
these existing surfaces. Preserve default-disabled or unavailable behavior rather than inventing a
product fallback to obtain a successful test. Trusted browser execution, native tool execution and
legacy-call execution without a current Run guard remain execution qualifications for the affected
P3/P4 group. Mixed-entry streaming/saturation/reverse switching is P2; installed/native packaging is
P2/P5. These boundaries retain their gates and do not keep P1 open for a Task engine rewrite.

Use strict Zod validators and generated JSON Schema/OpenAPI/API documentation. JSON Schema cannot
represent every transform/refinement: keep explicit named adapters/fixtures for trim, Unicode,
missing/null, safe integers and byte ceilings, rather than silently changing Python validation.
Retain Python projections until their TS replacement has complete coverage; remove obsolete
generation paths only when consumers pass. Shared packages must not import applications.

Create `packages/contract-tests` as a black-box, configurable-base-URL suite. Run the same cases
against Python, direct TS groups and the mixed entry using separate disposable databases seeded
from the same fixture. Include status/error/header/cookie semantics, concurrency, audit and
rollback, streaming reconnect/abort, WebSocket bounds, authorization failures and unknown fields.
Reject unexpected omissions; dynamic IDs/timestamps may be normalized only by declared rules.
Passing schema snapshots or the old oracle is insufficient.

### P2: bounded forwarding with one authority per operation

The TS entry forwards unported method/path groups to one fixed private Python upstream. Forward
the original public Origin and credential semantics. Preserve Set-Cookie, status, errors, event
IDs, SSE backpressure/abort, upload/download bytes and Worker WebSocket lifecycle. There is no
arbitrary target URL, open redirect, credential logging or generic renderer proxy.

Initially Python still authenticates and authorizes its routes. P2 can verify existing sessions
for entry-owned routes, but must not replace Python's decisions with a trusted user header,
issue a second session format, or duplicate audit. Reject forged forwarding/identity headers;
only explicitly configured infrastructure can supply proxy metadata. Upstream loss gives a
bounded failure; it does not enable another implementation or automatically retry a mutation.

A route ownership manifest includes HTTP, event projections, background schedules and related
write-side entry points. Exactly one implementation owns each operation. Sharing PostgreSQL does
not coordinate duplicate timers, dispatchers, purges or workflow starters. Migrations remain in
`packages/db`, run through one guarded migrator; schema history, IDs, encryption/key formats,
session revocation, revision/CAS and lock order stay compatible. Use additive, backward-compatible
migrations during coexistence; do not dual-write, copy databases or destructively roll back data.

### P3: switch and retire groups incrementally

Sequence: small settings/reads → identity/security → product groups → model transports. Authorizing
effects and approvals retain their current Server transactions even when their settings move early.
C28 is already under change in this checkout; consume its accepted, validated retirement instead
of implementing or porting it again.

Every switch needs identical public behavior, negative cases, real PostgreSQL transaction/audit
evidence, affected Desktop journeys and a rehearsed reverse switch against the *newer* data.
Keep the previous runnable release and compatible migrations during the rollback window. Only then
delete the now-unreachable Python group in the active source. "Delete on switch" must not make
rollback point at code that no longer exists. A reverse switch never restores stale facts or
replays unknown writes. Transfer background ownership before opening the new group for writes.

Before each HTTP group switch, run `npm run ui:acceptance -- --entry ts` against the exact
candidate with its current Web and TS builds. Require `PASS 12/12`, with no unexpected API
responses or page errors, and retain the output directory's receipt and screenshots with the
candidate revision. This is the [accepted local whole-interface gate](../research/ui-acceptance-automation.md),
in addition to the transaction, authority, Desktop and reverse-switch gates above. If
`503 GET /api/v1/workspace` recurs, use the report's step and the paired TS/Python process logs
to distinguish an upstream response from a forwarding failure before accepting the candidate.

New features land with the group owner. A feature written directly in TS ahead of the group's move
requires explicit route ownership and the same gates; proximity to a migration grants no authority.

### P4: Work, the harness and Temporal

Move workflows/Activities, runtime supervision and **`packages/harness`** as well as
`apps/server-python`. Official provider SDKs replace transports, not Pydantic AI's bounded strategy,
message/media serialization, deferred approvals, tool correlation, correction adoption or
control-owned admission/fencing. Preserve those contracts in a narrow TS strategy composed by trusted
ports. Do not introduce a second Agent/retry loop or one indefinite retryable Activity.

Use separate versioned TS workflow types/task queues for new work; keep Python workers and their
required dependencies available to finish old histories. A new queue does not migrate histories
or convert payloads. Existing signals, cancellations, approvals, timers, child workflows and
Continue-As-New chains remain reachable on their owning worker. Fence start/dispatch ownership and
stop old admission before declaring the drain complete.

Default to **draining** all open Python executions, verified with Temporal and control facts,
including the chains that can create another run. Reusing a Python history in TS is an exception
requiring exported-history replay for that exact type/version, payload/error/failure compatibility,
Activity names/results, and restart/recovery qualification. Passing TS SDK sample replay tests
does not establish cross-language replay. Terminal engine history is never authority to repeat
an unknown effect or to publish an Artifact.

Preserve root budgets, approvals, source revision, worker claims, cancellation/revocation,
lookup-only reconciliation and transactional publication. Exercise real public HTTP → Temporal →
runtime → isolated executor → reconnect/download, with process death and lost responses at the
existing admission/effect/publication boundaries; synthetic provider fixtures avoid paid calls.

### P5: retirement and repository

During coexistence add `apps/server-ts` and `packages/contract-tests`; introduce `packages/work`
only in P4. Keep the DB, protocol, domain, Web/Desktop, Node/Worker hosts and providers in their
current roles. In P5 rename the verified TS service to `apps/server`.

Remove Python control, the Python harness and runtime wheels, obsolete
`packages/python-node-runtime`, locks, launchers and packaging closures after consumers migrate.
Retain its document/OCR libraries and existing migration behavior in the new TS closure.
Inventory Python in probes, experiments, generators, developer commands and required CI as well;
port or retire each dependency with retained replacement evidence. Historical test input may remain
as inert provenance, but cannot leave Python necessary for mandatory setup/checks.

Removing CPython is required. The Owner approved retaining standalone Node on2026-10-10:
Electron44.3.0's utility Node24.20 did not enforce the required permission boundaries in the real
probe, while standalone Node24.21 refused both forbidden file reads and child execution.
Temporal, parser helpers and native loading continue using that reviewed Node distribution.
Package-only-current-platform Temporal core-bridge is a post-P5 size optimization. PostgreSQL and
Temporal deployment simplification remains out of scope.

## Gates and approval boundary

| Phase | Exit evidence before starting the next |
| --- | --- |
| P0 | Review this ADR, dependency evidence and baseline limitations; record the Owner's decision |
| P1 | Complete route/consumer inventory; shared contracts pass on current Python with unchanged behavior |
| P2 | Mixed-entry contracts and Desktop journeys pass; forwarding latency/memory measured; private upstream and reverse switch qualified |
| P3, each group | Positive/negative/concurrency/audit tests, exact-candidate TS UI `PASS 12/12`, security review for identity, accepted forward/reverse switch and single background owner |
| P4 | Real recovery and replay suites, supported runtime packaging, all Python histories/chains drained; no stale authority or unreachable operator path |
| P5 | Fresh product install/setup and required CI need no Python; final bundle/startup/RSS compared with the same P0 scope; approved platform packaging passes |

The Owner approved the ADR, Desktop restart measurement and continued P0–P5 implementation on
2026-10-06. Phase gates still apply; do not request the same approval again for routine execution.
This authorizes implementation and qualified retirement, not paid calls, unrelated production
mutations or a release. Update active repository/local rules when ownership actually lands; preserve
dated upgrade records rather than rewriting them as if this migration already happened.

## Consequences and remaining evidence

Temporary packaging gets larger in P2–P4. Each coexistence release must retain its own baseline and
supported scope; savings are final P5 evidence. Current measurements use the actual installed
macOS arm64 alpha bundle, not the dirty working tree. They cover native PostgreSQL/API/login startup
and a reference distribution archive/image. A subsequent authorized restart observed the real
rendered window and connected workspace; its separate timing includes automation overhead. These
measurements do not qualify active Temporal memory or Windows/Intel Mac. See the P0 evidence.

No upstream source is copied or substantially adapted by this ADR. Existing license notices remain;
new production dependency notices belong to the phase that installs them.


## P5 dependency and runtime qualification (2026-10-10)

The direct Server serves the built Web client through `@fastify/static` **10.1.6**, MIT,
[npm source commit `b38a463df891157215b81fbecdb80ed828299f86`](https://github.com/fastify/fastify-static/tree/b38a463df891157215b81fbecdb80ed828299f86).
The [released plugin](https://github.com/fastify/fastify-static/releases/tag/v10.1.6) supports the
retained Fastify 5 API. This pin includes the case-insensitive route/`allowedPath` fix in
[10.1.4 / GHSA-r799-r9gc-m956](https://github.com/fastify/fastify-static/security/advisories/GHSA-r799-r9gc-m956).
Using the maintained Fastify plugin removes the private proxy and avoids a second static-file
implementation; it preserves the existing request lifecycle and streaming limits. The Server
additionally refuses hidden files, escaping symlinks and API fallback. The downloaded package's
LICENSE stays in the runtime closure. Source copied or substantially adapted: **no**.

Electron **44.3.0**, embedded Node **24.20.0**, ABI **149**, was exercised on macOS arm64.
Koffi loading, Temporal native loading, threads, VM and workflow bundling passed the local probe.
That does not establish a complete Worker lifecycle. The necessary restricted-parser gate failed:
`utilityProcess.fork` accepted `execArgv` but its child did not enable `process.permission`; reads
outside the allowed fixture directory and child spawning both succeeded. The exact same probe on
standalone Node **24.21.0** denied both operations. Run
`node scripts/qualify-electron-permissions.ts` with that standalone Node to reproduce the comparison;
it creates only disposable files and a separate Electron profile. Its `qualified: false` result is
an observed blocker, not a waived permission boundary. The relevant primary APIs are
[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) and
[Node permissions](https://nodejs.org/docs/latest-v24.x/api/permissions.html).

The Owner approved retaining standalone Node on 2026-10-10 after this permission failure.
The default TS package retains Node 24.21.0 and its restricted parser child. This resolves the
packaging target decision; it does not waive the remaining migration or installation gates.

Post-P5 size optimization: package only the current platform's `@temporalio/core-bridge` native
release. Keep the reviewed version and license, verify the loader's platform selection and repeat
native Worker lifecycle/recovery qualification before removing other platform binaries.
The existing installed app, profiles and rollback sets stay untouched until separate installation
approval. Python retirement remains required by this ADR; approved implementation and qualified
retirement are distinct from acceptance of the remaining standalone-Node packaging deviation.

### Retained decisions after Python source retirement

P5 preserves the established [Owner session](../research/python-owner-auth.md),
[identity input](../research/python-identity-inputs.md), [identity transaction](../research/python-identity-transactions.md),
[profile](../research/python-profile-details.md), [conversation](../research/python-conversations.md),
[message read](../research/python-message-reads.md), [read projection](../research/python-control-read-slice.md)
and [schema compatibility](../research/python-schema-compatibility.md) contracts through TS control
cohorts, frozen compatibility outputs and real HTTP/SQL consumers. These records explain the
semantics retained by the migration; their old setup commands are historical.

The new Work path retains the [task authority](../research/python-task-authority.md),
[model service](../research/python-model-services.md), [admission](../research/work-domain-admission.md),
[artifact publication](../research/work-artifact-publication.md) and
[lookup-only reconciliation](../research/work-reconciliation-commands.md) decisions.
The [former supervisor](../research/python-control-runtime-supervision.md),
[runtime activation](../research/python-runtime-activation.md) and
[headless acceptance](../research/headless-runtime-acceptance.md) records document the retired
process/wheel implementation; TS Work recovery, Linux native execution and packaged lifecycle checks
replace those mechanisms without introducing a second authority or retrying unknown effects.
