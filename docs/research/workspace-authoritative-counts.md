# Research: authoritative workspace active-run counts

- Status: Accepted before implementation
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Related issue: development track C3
- Acceptance journey: the official shared workspace hook reconciles a completed or updated Run outside the recent 50 records against the Server's global active count, without losing immediate entity updates or starting an unbounded refresh loop.
- Security boundary: authenticated GET remains the authority; no new endpoint, write, credential, native bridge or UI accounting claim is introduced. Failed reads retain existing data and report the existing error state.

## Search evidence

- Existing ledger entries checked: ordered workspace state, C1 coherent snapshots, Web interaction tests and React runtime coherence. Read `workspace-state-refactor.md`, `workspace-snapshot-stream.md`, `react-19.3-version-coherence.md`, the actual shared hook/API, channel read callbacks, C1 GET reader and workspace component regressions at `86223c6`.
- Search date: 2026-09-22. GitHub queries: `facebook/react 19.3.0`, `repo:TanStack/query invalidateQueries cancelRefetch`, and upstream Query discussion [7180](https://github.com/TanStack/query/discussions/7180) on invalidations received during an outstanding read. Its maintainer response and current API reference explain why simply skipping a refetch while busy can lose a later invalidation.
- Primary sources: [React effect cleanup and fetching](https://react.dev/reference/react/useEffect), [Fetch cancellation](https://fetch.spec.whatwg.org/#abort-fetch), [QueryClient invalidation/refetch API](https://tanstack.com/query/latest/docs/reference/QueryClient).
- Rechecked package declaration, lockfile and installed package: React and React DOM **19.3.0**, not the older 19.2.8 reviewed by the original hook ADR. The separate runtime-coherence review remains applicable. GitHub API source inspection covered pinned React `ReactHooks.js`, `StrictEffectsMode-test.js` and the existing MIT/release review.
- Compared the maintained [TanStack Query release `release-2026-09-22-1338`](https://github.com/TanStack/query/releases/tag/release-2026-09-22-1338), commit `8884f1a4d9ee53cb3cdba26ca28f870500ede3f7`: `queryClient.ts`, `queryClient.test.tsx` invalidation/cancellation coverage and MIT license. No source was copied and no dependency is added.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| React hooks and browser Fetch/timer primitives | React / React DOM 19.3.0, `1d34f91dfde6bba84d08b683aaba164c7194dacb`; Fetch standard accessed 2026-09-22 | MIT; WHATWG terms | Current pinned runtime; effect lifecycle source and Strict Effects tests reviewed | Existing browser/Electron renderer, request cleanup and stable callbacks | Reuse standard and existing dependency |
| Existing ordered workspace hook and coherent GET | OpenBot `86223c6` | MIT | Actual component tests already exercise stale response suppression, journal replay, mutation responses and reconnect | Keeps present authorization, domain shape and Desktop proxy route | Extend the narrow scheduling seam |
| TanStack Query | release above / `8884f1a4d9ee53cb3cdba26ca28f870500ede3f7` | MIT | Maintained release; invalidation implementation and cancellation tests inspected; discussion 7180 identifies the in-flight invalidation hazard | Default cancel-or-skip policies still need an application coalescing policy, plus replacement of existing entity journal integration | Do not migrate the workspace cache for this bounded fix |

## Reuse decision

The exact gap is global accounting: the 50 recent Runs cannot determine whether an absent Run was already included in the Server's count. Local event arithmetic can double-count an active off-page Run or fail to subtract a completed one. Only `counts.activeRuns` changes ownership; existing entity, node occupancy, approval and recent-page projections remain immediate.

Reuse the hook's generation, abort controller, request-scoped entity journal and `GET /api/v1/workspace`. Run projections invalidate the count instead of modifying it. A dirty bit and one timer coalesce event bursts; event-driven read starts are separated by at least one second, with one current read and at most one queued follow-up. Invalidation during a successful outstanding read is not consumed by that older read: schedule one fresh read after it settles. Replaying its entity journal cannot alter the global count or invalidate another read.

Explicit refresh/reconnect retains the current abort-and-replace semantics, subsuming any queued invalidation. Generation checks still reject abort-insensitive late completions. Failure reports the existing error and stops automatic follow-up; a later event, explicit refresh or reconnect can retry. No polling interval is added, and no self-generated projection drives a loop. Timer and pending read are cleared on unmount/StrictMode cleanup.

No duplicate cache is introduced: repeated events in a burst coalesce into the same dirty bit. A repeated external event after a settled read may request another bounded authoritative read; it never adjusts the count. This avoids suppressing recovery after a previous failure based on a permanently remembered event version.

The current ContextRail intentionally labels its metrics as loaded recent records and does not render the global count. Keep that UI unchanged; verify the shared hook's public snapshot through a rendered test consumer, and retain the real authenticated component tests for projection/connection regressions. C2's isolated component adapter does not replace this hook-level acceptance.

Exit: a future full-snapshot stream consumer may replace GET scheduling once authoritative replacement versus immediate mutation responses is specified. This change adds no durable revision, total cross-stream ordering, snapshot stream migration or Desktop lifecycle expansion.

## Source incorporation

- Source copied or substantially adapted: no.
- Reuse existing OpenBot hooks/helpers and public React/Fetch APIs. Existing MIT dependency notices remain unchanged.

## Verification plan

- Reproduce off-page active update and completion against the baseline using the real hook; then cover duplicate bursts, a Server count that already includes an event, invalidation during a slow GET, one queued follow-up, rate/concurrency bounds, failure retention without retry loops, manual refresh supersession and unmount cancellation.
- Retain `App.workspace-state.test.tsx` reconnect, entity journal, approval/occupancy and StrictMode coverage, plus nearby channel/navigation/run-state tests.
- Web typecheck, focused Biome, documentation/research checks and `npm run check` on this branch. No real model, private account or live Server needed for deterministic checks.
- Update `WORKSPACE_SYNC.md` and its Chinese translation for the official client policy. No new layout/native platform claim is made.

## Unresolved questions

Full snapshot stream adoption, Desktop stream-slot coverage and mutations without legacy event notifications remain separate follow-ups. Global counts may lag immediate entity projections until the bounded GET completes; they remain the last authoritative observation rather than an estimated count.

## Verification evidence

- Baseline execution failed 8 of the 10 new hook cases. An active off-page event changed the authoritative count from 7 to 8; repeating that event 200 times changed it to 207. Off-page completion never scheduled reconciliation. These are observed hook-state failures; the recent-record UI did not claim to render that global value.
- After the fix, 36 focused tests across six files passed: 10 new rendered real-hook cases, one new real `AuthenticatedWorkspace` case receiving duplicate channel/workspace events, and all 25 existing ordering/navigation/channel/run-state regressions. The failure-retention test uses a record newer than the 50-page boundary so its visibility assertion matches the existing page contract.
- Web typecheck, changed-file Biome and `git diff --check` passed. Full `npm run check` passed on the dedicated branch: Web 63 files / 368 tests, Desktop 38 files / 359 passed and one existing skip, Server 547 passed and 75 existing environment-dependent skips; other workspace checks/builds passed or reused matching Turbo cache. These skips do not establish live database or native OS conformance.
- Full check output: `/private/tmp/openbot-client-counts-check.log` outside the repository. Documentation checks cover the English/Chinese contract and research. Existing Vite config-extension/chunk-size and JSDOM `<search>` warnings remain unrelated to this patch.
- No UI layout, native IPC or live Server/model flow was changed or claimed as newly tested. Full snapshot stream migration and missing-event recovery remain separate from this bounded legacy-event reconciliation.
