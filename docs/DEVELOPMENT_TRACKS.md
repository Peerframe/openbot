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

| Track | Module entry | Current work package | Acceptance |
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

## Next packages and dependencies

| Package | Next concrete outcome | Dependency / boundary |
| --- | --- | --- |
| R2 — Runtime ports | One execution unit with explicit model/tool/storage/audit ports and an isolated test entry | R1 preserves behavior first; do not move scheduler, credentials or approvals into a permissive runtime package |
| C2 — Shared client fixtures | Approval wait, tool fault, cancellation, partial output, artifacts and reconnect in the official Web/Desktop view | C1; preserve accepted UI; read-only snapshot route needs explicit Desktop proxy review before exposure |
| D2 — Fresh contributor journey | Extend existing startup smoke with login, optional Node enrollment and retained identity restart | Reuse current smoke and synthetic fixtures; no private `.env` or personal accounts |
| P2 — Account lifecycle | One reviewed OAuth connector supports login, expiry, refresh and revocation with bounded diagnostics | MCP authorization research and explicit provider test account; no credential passthrough or silent scope expansion |
| B1 — Controlled browser | One complete observe/prepare/approve/commit/receipt/stop journey | Existing capability-lease decision, resource exclusivity and one reference Provider; unrelated markets or native platforms are not prerequisites |
| F1 — Files and code | Synthetic input → verified report or tested patch with attributable artifacts | R1 and reviewed file boundaries; reuse existing attachment and artifact mechanisms |
| S1 — Durable work | Restart/recovery/approval receipt and unknown-write failure injection | Server-owned state; unknown external effects require reconciliation, never blind replay |
| L1 — Verifiable learning | A reviewed correction produces a versioned method with evidence and rollback | R1 keeps learning optional; preserve Hermes attribution and separate checkpoints, memory, traces and skills |
| M1 — Useful collaboration | Evidence-bearing delegation with one accountable parent, shared budget and resource exclusion | Stable task/action contracts; parallel Bot names do not imply credential isolation |
| O1 — Operations and compatibility | Retained-data migration, paired database/files/keys restore and explicit release responsibility | Existing migration/backup research; test controlled fixtures before claiming upgrade or restoration support |

These are remaining work, not delivered features. Start each package with a bounded acceptance
journey and its existing reuse-ledger entry. Inspect source/releases/tests/issues/license before
changing behavior, as required by `AGENTS.md`. Permission, storage and external-action contracts
remain fail closed. Native mobile clients, enterprise multi-tenant permissions, all-platform
computer control, extension commerce, ownership transfer and the office plugin are not first-wave
deliverables; they remain visible in the product roadmap rather than being implicitly promised.

## Contributor handoff

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
  Server: sign-in and full counts rendered; a stopped upstream became visibly stale.
- Independent review covered Runtime changes, MCP production packaging boundaries and snapshot
  cancellation/freshness. The final cancellation regression does not need to resolve a stalled
  read before the subscriber can exit.

CI now runs the same headless journey in its existing disposable database job and includes snapshot
verification in `db:verify`; impact reporting keeps the full gate unchanged. Remote hosted CI, native
installation, real paid model quality and external OAuth accounts have not been verified by this
first wave. No release was published. Follow-up packages above remain open.
