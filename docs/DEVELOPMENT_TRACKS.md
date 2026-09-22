# Independent development tracks

[English](DEVELOPMENT_TRACKS.md) · [简体中文](DEVELOPMENT_TRACKS.zh-CN.md)

This is the active execution map for the 2026-09-22 direction: a headless, independently testable
Agent service, shared official clients, and independently maintainable extensions. Keep the
monorepo and existing stack. The Server owns identity, authorization, approvals, audit and durable
task state. A module boundary does not confer authority or replace a sandbox.

Baseline: `ebce995` on `main`. The older checkout at `9cc73c9` is not the implementation baseline.
This document supersedes the sequencing of the historical eight-hour execution plan; it does not
claim the entire product roadmap is complete or renumber its historical milestones.

## Track ownership and integration

| Track | Module entry | Foundation package | Acceptance |
| --- | --- | --- | --- |
| R — Runtime and headless delivery | Server native-agent, PostgresAgentStore | R1: deterministic Server journey and continuation/optional-learning regressions | Authenticated task completes with retrievable report; failures/cancel/late response/client disconnect are verified without Web, Electron or paid inference |
| C — Client and state contracts | ControlPlaneStore, workspace API, domain, reference reader | C1: coherent snapshots and explicit resynchronization | One DB snapshot for persisted fields/counts; independent read-only client handles duplicate/older frames and reconnect; page limits are explicit |
| P — Extension compatibility | Server plugins, independent MCP starter | P1: shared compatibility preflight and useful failure reasons | Discovery rejects unsupported requirements before grants; standalone success/schema/auth/timeout cases run without OpenBot workspace imports |
| D — Contributor validation | scripts, existing CI, contributor docs | D1: conservative impact report in shadow mode | Official Turbo dependency graph reused; unsafe/unknown/failure widens to full; no existing required check is skipped |

Each package has a separate branch/worktree and a responsible implementation task. Maintain code,
focused regressions, pinned research and English/Chinese module documentation together. Review
shared wire/storage/security changes before parallel clients depend on them. The integrating task
owns shared manifests, the reuse ledger, full checks and cross-track regressions. Maintainer review
and publication responsibility is not assigned to fictional module owners.

For new implementation packages, use the existing Grok Bot collaborators; Codex owns bounded
review, integration and acceptance. Do not duplicate the same implementation with Codex agents.
Grok Bots share a machine: give every package a distinct Git worktree and test database, use an
explicit working directory and push a verified commit to a named branch. A branch name alone
does not isolate a checkout. Deliver a commit/patch, actual checks and remaining limits; retain
Draft PRs until integration review. Token savings have not been measured.

## First-wave completion ledger

| Package | State | Evidence entry |
| --- | --- | --- |
| R1 | Complete; integrated locally | `npm run test:runtime`: 90 tests; [Native Agent](NATIVE_AGENT.md) |
| C1 | Complete; integrated locally | [Contract](WORKSPACE_SYNC.md), [research](research/workspace-snapshot-stream.md), HTTP/stream/reader tests and real PostgreSQL interleaving test |
| P1 | Complete; integrated locally | [MCP author contract](PLUGINS.md); 13 independent scenarios, fixed diagnostic UI and Server regressions |
| D1 | Complete; integrated locally | [Shadow report](CI_IMPACT.md), real Turbo fixtures and CI contract tests |

Final integration must run `npm run check`, the fresh headless journey and the explicit disposable
database verification. Simulated model tests establish orchestration behavior, not real-model
quality. Local evidence does not establish hosted CI or native-platform support. Change the ledger
only after the named gate succeeds.

## Second-wave implementation and focused evidence

These packages use independent branches based on `2cc32d0`. The shared integration branch is
`codex/collaborative-development`; the original checkout remains untouched.

| Package | Branch | State and acceptance entry |
| --- | --- | --- |
| R2 — Runtime ports | `codex/track-runtime-ports` | Complete; integrated and full checks passed locally. `npm run test:runtime:unit`: 22 direct execution-unit tests; `npm run test:runtime`: 112 tests. Server-local explicit authority/model/tool/storage/audit ports; no public runtime package or crash checkpoint claim. |
| C2 — Shared client fixtures | `codex/track-client-fixtures` | Complete; integrated and full checks passed locally. Six official-component scenarios, actual browser at 1440px/390px, synthetic Blob delivery and reconnect refetch. [Client fixtures](CLIENT_FIXTURES.md). |
| D2 — Fresh contributor journey | `codex/track-contributor-journey` | Complete; integrated and full checks passed locally. Real Owner login, Node enrollment, consumed-token refusal, retained session/identity restart and interruption cleanup. [Contributor journey](CONTRIBUTOR_JOURNEY.md). |
| O1a — Retained-data upgrade | `codex/track-retained-upgrade` | Complete; integrated and full checks passed locally. `npm run test:upgrade`: pinned old prefix, 15 populated tables, concurrent/repeated production migration, old-column equality, constraint/default/drift checks. [Database guide](DATABASE.md#retained-data-upgrade-regression). |

Run cold-start smoke before other commands create build output. Client fixtures and runtime-unit
checks need no database; headless acceptance owns a disposable container; upgrade acceptance
requires an explicitly supplied empty loopback database. These are separate acceptance journeys.

## Next packages and dependencies

The third wave below is integrated. C4, B1b, F1a and Grok's D3 are integrated locally; their
combined checks passed. Grok's R3 revision is also integrated; D4 remains in implementation.
P2 has a reviewed research handoff; no OAuth feature or real provider is enabled.

| Package | Next concrete outcome | Dependency / boundary |
| --- | --- | --- |
| D4 — Starter DOM regressions | Implement the four focused dialog/tab regression cards | Grok Builder; depends on D3 [Draft PR #85](https://github.com/Peerframe/openbot/pull/85), own worktree; jsdom is not real-browser accessibility evidence. |
| P2 — Account lifecycle | One reviewed OAuth connector supports login, expiry, refresh and revocation with bounded diagnostics | MCP authorization research and explicit provider test account; no credential passthrough or silent scope expansion |
| F1b — Tested code delivery | Synthetic input produces a tested patch with attributable artifacts | F1a records report inputs, not verified findings or tested code. Define the code execution boundary and reuse existing file/Worker mechanisms before implementation. |
| S1b — Reviewed reconciliation and retention | Owner can record reviewed external evidence and manage receipt capacity | S1a preserves unknown outcomes; a received response or task cancellation does not prove external completion or rollback. Never replay an uncertain write. |
| L1 — Verifiable learning | A reviewed correction produces a versioned method with evidence and rollback | R1 keeps learning optional; preserve Hermes attribution and separate checkpoints, memory, traces and skills |
| M1 — Useful collaboration | Evidence-bearing delegation with one accountable parent, shared budget and resource exclusion | Stable task/action contracts; parallel Bot names do not imply credential isolation |
| O1 — Remaining operations and compatibility | Operational backup adapters, remaining recovery profiles and explicit release responsibility | O1a covers retained upgrades; O1b covers a synthetic POSIX Server directory-mode paired restore. Publisher, legacy and Desktop secret profiles, archive encryption, off-host retention and PITR remain open. |

These are remaining work, not delivered features. Start each package with a bounded acceptance
journey and its existing reuse-ledger entry. Inspect source/releases/tests/issues/license before
changing behavior, as required by `AGENTS.md`. Permission, storage and external-action contracts
remain fail closed. Native mobile clients, enterprise multi-tenant permissions, all-platform
computer control, extension commerce, ownership transfer and the office plugin are not first-wave
deliverables; they remain visible in the product roadmap rather than being implicitly promised.

## Contributor handoff

S1a now has a separate bounded receipt ledger; its 500-entry audit and ephemeral approval
arguments are not recovery checkpoints. Unknown receipts are protected from history eviction,
and 256 protected records refuse new calls. B1a exercises the existing reviewed browser click
through the official runner. Neither completes its parent track. B1b adds real Owner Worker
cancellation, interrupted approval invalidation, Run-before-approval lock ordering, late-result
rejection and retained Node cleanup occupancy. It still does not acknowledge remote rollback.
The capability-lease ADR remains proposed and does not establish cross-process exclusivity.

A ready package states the observable result, non-goals, module entry, prerequisites, focused
command, failing scenario and review routing. An open architecture question is not a starter task.
Use repository tests and synthetic data instead of private chat transcripts. Keep four distinct
cost categories when evidence is collected: development AI, product inference, execution/CI and
maintainer time. Do not claim savings from unmeasured timings or a shadow report alone.

## Integration evidence — 2026-09-22

- `npm run check` passed locally after combining all four tracks (including Server/Web/Desktop
  typechecks, tests and builds). Existing environment-dependent skipped suites remain explicit.
- `npm run test:runtime` passed 90 tests using a newly created and automatically removed PostgreSQL
  container, the real Owner API and deterministic model responses.
- `npm run test:workspace` passed 64 Server/stream/reader tests; the final standalone consumer
  additionally passes three Node scenarios including a silent-proxy timeout.
- `npm run db:verify` passed against the task's separate synthetic database, including migration
  validation and forced concurrent mutation between workspace collection and count reads.
- Actual browser verification used the standalone Vite entry, a synthetic Owner and the built
  Server: sign-in and full counts rendered; a stopped upstream became visibly stale, then
  recovered automatically after Server restart without another login.
- Independent review covered Runtime changes, MCP production packaging boundaries and snapshot
  cancellation/freshness. The final cancellation regression does not need to resolve a stalled
  read before the subscriber can exit.

CI now runs the same headless journey in its existing disposable database job and includes snapshot
verification in `db:verify`; impact reporting keeps the full gate unchanged. Remote hosted CI, native
installation, real paid model quality and external OAuth accounts have not been verified by this
first wave. No release was published. Follow-up packages above remain open.

## Second-wave integration evidence

- Full `npm run check` passed after merging R2, C2, D2 and O1a. The isolated client build is also
  included in CI; normal production Web/Desktop entry points exclude the fixture bundle.
- The integrated `npm run test:runtime` passed all 112 deterministic and real PostgreSQL tests.
- Old-data upgrade passed on PostgreSQL 17.11: 15 populated tables and 27 applied migrations.
  Nonempty databases, function-only databases and non-system schemas are rejected without
  applying migrations. Missing requested fixtures fail before connection.
- Independent review found no blocking Runtime authorization/cancellation regression or retained-
  upgrade lifecycle issue. Actual client browser evidence covers six scenarios at desktop/narrow
  sizes, no real API traffic and no console/page errors. The preview uses build + reload, not HMR.
- CI wiring adds the Node restart journey to the existing pre-build smoke and a separate retained-
  upgrade database. Existing required checks remain in place. Hosted CI/native installation and
  real paid-model behavior have not been established by these local checks.
- Final cold-checkout acceptance exposed a Darwin zombie process-group `EPERM` race. The corrected
  helper verifies bounded process identity/state, preserves real permission failures and retries
  failed cleanup. Ten helper regressions passed. A newly exported integrated checkout then passed
  the full login/enrollment/restart journey; no owned processes, ports, containers or private fixture
  directories remained. This supersedes the failed cold-run attempt.

## Third-wave completion and integration evidence — 2026-09-23

| Package | Result | Acceptance and limits |
| --- | --- | --- |
| C3 — Authoritative counts | Complete; integrated locally | Global active counts are refreshed from the Server, independent of the recent 50-Run list. Duplicate/off-page events and concurrent streams cannot accumulate false increments. Focused hook/App regressions cover bounded coalescing, errors and cleanup. |
| S1a — Durable call receipts | Complete; integrated locally | A separate encrypted 256-record ledger retains approval/dispatch/response facts. Real process-kill tests verify pre-dispatch zero calls and lost-response one-call uncertainty across two restarts, with no replay. Owner task details expose these facts with bounded reads. Unknown outcomes remain protected; reconciliation and capacity management are S1b. |
| B1a — Docker browser lifecycle | Complete; integrated locally | `npm run test:provider:docker -- --output <new-report.json>` passes 15 required checks with zero failures or skips. Uses production Server/Node/Provider and actual PostgreSQL with a synthetic computer HTTP surface. This is hermetic evidence, not real-browser or native platform certification. |
| O1b — Paired restore | Complete for the synthetic POSIX Server directory profile | `npm run test:restore` passes: 25 tables, eight files, 27 migrations; actual Owner downloads, decryption, retained unknown receipt, missing/wrong keys, altered files and transactional rollback on a truncated dump. Other recovery profiles and operational backups remain open. |

- Final integrated `npm run check` passed: Server 562 tests (75 environment-dependent skips),
  Web 394, Desktop 359 (one existing skip), Node 51 (three existing skips), 31 test tasks and
  18 build tasks. The separate real PostgreSQL headless journey passed all 112 tests.
- The browser driver passes 12 focused fixture/process regressions. Review found that stopping
  only the immediate child could leave a live grandchild. The driver now shares the existing
  POSIX process-group cleanup with contributor smoke; deadline, abort, parent-first exit,
  inherited pipes and unrelated-process preservation are covered.
- A fresh export of integrated `173e95f`, after only `npm ci --ignore-scripts`, passed the complete
  Owner login, one-time Node enrollment and retained Server/Node restart journey. It had no prior
  build output or private configuration. Owned containers/processes/files and the export were
  removed after acceptance. The original `9cc73c9` checkout and its untracked files remain intact.
- The seventh client fixture, `plugin-receipts`, passes actual desktop/narrow browser checks;
  old six scenarios remain usable. Integrated build/preview renders the unknown-result warning
  before new-task submission, with settled receipts collapsed. Production bundles exclude fixtures.
- CI adds required restore and Docker conformance commands to the existing database job and
  retains the conformance report. Hosted execution has not been observed. No release, real paid
  model run, external OAuth account or additional native installation is claimed.

## Fourth-wave integration and Grok handoff — 2026-09-23

| Package | Result | Evidence and limits |
| --- | --- | --- |
| C4 | Integrated locally | Official Web/Desktop consumes snapshots with mutation/GET barriers, old-frame rejection and independent Desktop stream slots. Seven actual browser fixtures passed, including 390px layout. Sustained legacy events can still trigger one coalesced GET per second. |
| B1b | Integrated locally | Owner Worker cancellation invalidates pending approvals and rejects late results. A real member-removal/approval deadlock was fixed using compatible channel row locks. The package passed 13 PostgreSQL transaction tests and 18 conformance checks; cancellation is not remote rollback. |
| F1a | Integrated locally | Report appendix and artifact metadata record original/text SHA-256, cumulative UTF-16 read ranges and extraction truncation. Six focused evidence tests and a real Owner upload → corrected continuation → downloaded report journey pass. This does not verify conclusions or deliver tested patches. |
| D3 | Grok delivery integrated locally | [Draft PR #85](https://github.com/Peerframe/openbot/pull/85), source `7b9b930`: four small DOM regression cards and reclassified larger tooling tasks. Listed implementation work remains open until D4 passes. |
| R3 | Grok revision integrated locally | [Draft PR #86](https://github.com/Peerframe/openbot/pull/86), sources `2ceb806` / `6815464`: SQL retains PostgreSQL microseconds. Fixed timeline reproduces old-code failure; preceding answers are included while later human/task-tree/after-start input remains excluded. |
| P2 research | Integrated; implementation open | [OAuth lifecycle](research/mcp-oauth-account-lifecycle.md) defines strict discovery, refresh/disconnect races, no replay and a synthetic acceptance journey. No new dependency or external account. |

Combined `npm run check` passed at `6ff3f48`: Server 574 tests (89 environment-dependent skips),
Web 421, Desktop 365 (one existing skip), Node 52 (three existing skips), 31 test tasks and
18 build tasks. This ordinary gate does not execute the skipped database suites. F1a's separate
runtime run passed its seven headless scenarios but failed the existing preceding-answer context
case (112 passed, one failed). After integrating R3, `npm run test:runtime` passed all 113 tests
on a new PostgreSQL fixture, and the final `npm run check` passed. The integrated Worker suite
also passed 13 database transaction tests and 18 required conformance checks with zero failures
or skips; owned resources were removed. D4 and the remaining parent tracks are still open.

Review of Grok's first R3 patch found a fixed reply/start timestamp mixed with clock-dependent
source timestamps. The revision fixes the full timeline and demonstrates old-code failure/new-code
success. Integration places the independent-tree negative reply before start so that only its
input boundary, not the start cutoff, excludes it.
Grok's shared checkout also allowed one Bot's branch switch to affect another Bot's push; an
empty D4 remote branch was mistakenly pushed and removed. No `main` merge occurred. Subsequent
Grok work requires separate worktrees and explicit commit-to-branch pushes. Codex does not
duplicate D4 or R3 implementation; it reviews and runs integration checks.
