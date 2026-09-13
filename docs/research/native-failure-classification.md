# Research: Native failure classification for non-permission errors

- Status: Implemented
- Date: 2026-09-13
- Owner: @yxflc11
- Related issue: F02 scope_revoked misused as lost channel permission
- Acceptance journey: Owner-facing failure text for unknown wait_for_task targets, usage
  conflicts, and skill/memory changes no longer claims the Bot lost channel membership.
- Security boundary: Server remains fail-closed for true membership loss. No permission
  relaxation, retries, or budget changes. Catalogue messages stay free of upstream bodies.

## Search evidence

- Search date: 2026-09-13
- Existing OpenBot entries checked: [agent-execution-experience](agent-execution-experience.md),
  [native-agent-loop](native-agent-loop.md), `docs/NATIVE_AGENT.md`, OPEN_SOURCE_REUSE native Agent
  loop row.
- Code inspection: `nativeFailureMessages` / `NativeExecutionError` in `agent-observations.ts`;
  throw sites in `native-agent.ts`, `postgres-agent-store.ts`, `postgres-agent-skills.ts`,
  `postgres-agent-collaboration.ts`; Owner ZH mapping in `NativeRunControls.tsx`.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Extend existing `nativeFailureMessages` catalogue | Current OpenBot main (`0aafca2`) | Project | Already drives Run.errorCode, EN stored message, ZH UI map, and fail-closed paths | Fits Server-owned catalogue; mirrors `settings_changed` / `plugin_changed` | Select thin local classification |
| Reuse only `execution_failed` / `tool_unavailable` | Same | Project | Would stop the wrong permission string but collapse Owner guidance | Loses actionable distinction | Reject |
| New dependency for error taxonomy | n/a | n/a | No gap requiring an external taxonomy | Would add surface without closing authority | Reject |

## Reuse decision

- Selected option: local gap closed inside the existing failure catalogue.
- Selected upstream or standard: none; reuse OpenBot's `NativeExecutionError` pattern from the
  execution-experience review.
- Why this is the first viable option: the catalogue already separates settings/plugin changes from
  scope revocation; invalid targets and skill/memory drift were incorrectly aliased to
  `scope_revoked`.
- Exact OpenBot-specific gap: map wait_for_task unknown IDs and ineligible tool targets to
  `invalid_target`; usage optimistic-update misses to `conflict`; skill assignment/content drift to
  `skills_changed`; memory eligibility/revision drift to `memory_changed`; keep true
  `channel_bots` membership loss as `scope_revoked`.
- Upgrade, replacement, or exit plan: further catalogue entries may split conflict causes later
  without relaxing permission checks.
- Failure behavior when the upstream is missing, incompatible, or compromised: n/a (no upstream).

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: n/a
- Required copyright or license notice location: n/a

## Verification plan

- Automated tests: unit coverage distinguishing `invalid_target` / `conflict` / `skills_changed`
  from `scope_revoked`; UI ZH message assertions; integration expectation for memory sharing
  revocation uses `memory_changed`; `npm run check`.
