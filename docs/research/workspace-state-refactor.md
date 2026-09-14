# Research: ordered workspace snapshots and realtime projections

- Status: Accepted for implementation
- Date: 2026-09-14
- Owner: OpenBot contributors
- Related issue: User-approved architecture and flow review of `3a02750e8851298a1b27246fd1ac4925f319fdc1`
- Acceptance journey: After reconnecting or changing channel membership, the authenticated workspace keeps the latest server projection when older workspace requests complete out of order.
- Security boundary: The Server remains authoritative for membership, authorization, approvals and routing. This change orders already-authorized responses in one mounted UI; it adds no optimistic authority, persistence or side effects.

## Search evidence

Searches on 2026-09-14 covered `facebook/react useEffect cleanup race`, `react/react is:open useEffect cleanup`, the pinned React release, hook source, Strict Effects tests, and license. Existing ledger entries for Web component tests, Desktop channel drafts/send continuity, channel-first contextual inspector, and Desktop unified toolbar/history were checked, together with `desktop-conversation-continuity.md` and `desktop-navigation-continuity.md`.

- [React useEffect](https://react.dev/reference/react/useEffect) describes ignoring stale results during effect cleanup and the development setup/cleanup cycle; [Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects) covers aborting or ignoring fetch results.
- [React 19.2.8 release](https://github.com/react/react/releases/tag/v19.2.8), exact commit [`1dd4ecbdabf826f527fc9a58c05ea70375b7d170`](https://github.com/react/react/commit/1dd4ecbdabf826f527fc9a58c05ea70375b7d170), matches the existing dependency. The release is maintained and includes a React Server Components decode-performance patch; this client change does not require a dependency upgrade.
- Pinned [ReactHooks.js](https://github.com/react/react/blob/v19.2.8/packages/react/src/ReactHooks.js) exposes dispatcher-backed state, ref and effect APIs; [StrictEffectsMode-test.js](https://github.com/react/react/blob/v19.2.8/packages/react-reconciler/src/__tests__/StrictEffectsMode-test.js) exercises cleanup and remount behavior. These are lifecycle primitives, not an application-level ordering contract for GET and SSE.
- [Issue 24455](https://github.com/react/react/issues/24455) discusses cleanup for fetch races; [issue 24502](https://github.com/react/react/issues/24502) classifies StrictMode's repeated development effects as expected. The open-issue search also surfaced [cleanup-order issue 30765](https://github.com/react/react/issues/30765); the implementation must not depend on parent/child cleanup order. Search results are not an exhaustive clearance of React's open issues.
- [Fetch standard](https://fetch.spec.whatwg.org/) supplies cancellation. Cancellation alone cannot prevent a resolved or cancellation-insensitive request from committing; a local generation check is still required.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing React hooks plus Fetch cancellation | React 19.2.8, `1dd4ecbdabf826f527fc9a58c05ea70375b7d170`; Fetch living standard accessed 2026-09-14 | [MIT](https://github.com/react/react/blob/v19.2.8/LICENSE); browser standard | Maintained release, public hook source and Strict Effects tests inspected | Already deployed in Web/Desktop; refs can own request lifetime without modifying server authority | Reuse public APIs through a narrow workspace hook |
| Existing OpenBot run/node merge helpers | Repository base `3a02750e8851298a1b27246fd1ac4925f319fdc1` | Repository license | Existing timestamp/status ordering tests | Preserves current run monotonicity and node projection semantics | Reuse; do not replace with a second cache library |

## Reuse decision

- Selected option: existing dependency and standard, with a thin OpenBot adapter. No new package, framework, fork or copied state engine.
- Exact local gap: requests have a total local generation, while server events and mutation results invalidate affected entities in an outstanding GET. A request-scoped journal replays those projections over that request's snapshot before commit. Latest projections for the same entity replace older entries; replay preserves unrelated entities recovered after a disconnect. No event-triggered retry loop is needed.
- Start a newer GET by aborting and invalidating the older one. Abort and invalidate on effect cleanup, including StrictMode. Ignore both stale successes and stale failures.
- Clear the journal on completion, replacement or cleanup. Keep journal state private to the pending request and keyed by entity rather than accumulating duplicate event history.
- Apply returned channels immediately after successful membership/create/direct-conversation mutations. Preserve current server responses and existing API/SSE contracts.
- Replacement plan: keep the hook behind existing domain types. A future upstream cache may replace its transport ownership only if it preserves event replay, deletion, counts and cleanup tests. A future server event revision could simplify ordering further.
- Failure behavior: current data remains visible on a failed reconciliation; the existing error UI reports the current request failure. An old request cannot replace data or the current error state.

## Source incorporation

- Source copied or substantially adapted: no. Public React and Fetch patterns are used, with OpenBot-specific domain projections.
- Required notices: existing dependency MIT notices remain unchanged; no new source notices are required.

## Verification plan

- Render the real `AuthenticatedWorkspace` with its API client and controllable HTTP/EventSource fixtures. Reproduce the reverse-response failure before changing implementation.
- Cover reverse GET completion, channel SSE during a pending GET, immediate join/remove responses even if reconciliation fails, reconnect recovery of unrelated missed data, stale failure suppression, and StrictMode/unmount cancellation. Exercise visible membership labels and controls rather than private hook state.
- Run targeted existing navigation/member tests and Web TypeScript checks. The main task runs the repository check and actual browser/Desktop acceptance; JSDOM proves component/transport ordering, not layout, real network reconnection, or native application behavior.
- Remove only the two unreferenced public pixel-bot assets and dead selector branches identified by the fixed-SHA reference audit. Preserve active shared CSS branches, current modular avatars and persisted `appearance` compatibility. Verify reference absence and production output in the main task.
- This document and its Chinese translation change together.

## Unresolved questions

- Channel payloads have no global server revision. This patch guarantees a newer local GET supersedes an older GET and events received during a GET survive its commit; it does not invent a total ordering across independent server connections or clients. Server-provided revisions would be needed for that wider guarantee.

## Implementation verification

- The real authenticated component test first reproduced five failures on the baseline: reverse GET completion, channel events overwritten by a pending GET, delayed join/remove response projection, and a cancelled StrictMode request committing later.
- After implementation, nine component/transport scenarios pass. They also cover real client reconnect callbacks, stale failures, node removal and recovery, and approval/run replay. A replay regression found during development is covered: a completed run clears occupancy even when coalescing skipped its intermediate assignment.
- Targeted verification: 25 tests passed across `App.workspace-state.test.tsx`, `App.navigation.test.tsx`, `ChannelMembersMenu.test.tsx`, `ChannelWorkspace.integration.test.tsx`, and `run-state.test.ts`. Web TypeScript checking and changed-source Biome error checks passed with Node 26.0.0. Existing stylesheet specificity warnings remain outside this cleanup.
- Confirmed no remaining references to the removed asset names or deleted selector families within `apps/web/src` and `apps/web/public`. The two removed public assets totaled 118,728 bytes (PNG 117,797; SVG 931).
- The coordinating task owns full repository checks, production asset verification and actual Web/Desktop QA; these local tests do not claim those results.
