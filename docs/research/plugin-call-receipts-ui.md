# Research: Owner task call receipt inspection

- Status: Accepted for implementation
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Related issue: S1a Owner receipt UI
- Acceptance journey: inspect an existing Run, distinguish unknown external outcomes from received
  tool responses, and read the exact call/approval timestamps without dispatching another call.
- Security boundary: Server-owned read-only receipt API; no client approval, replay, reconciliation
  write, parameters, secrets or remote response bodies. Run completion does not settle tool effects.

## Search evidence

- GitHub searches: `TanStack/query refetchInterval abort signal`, `react/react useEffect cleanup
  race condition`; inspected the pinned source, tests, release and issue links below on 2026-09-23.
- Official references: [React effects](https://react.dev/reference/react/useEffect) and
  [DOM AbortController](https://dom.spec.whatwg.org/#interface-abortcontroller). Cleanup must both
  cancel work and ignore obsolete results. The existing native HTML details/summary pattern follows
  the previously reviewed `desktop-contextual-inspector.md`; no new disclosure widget is needed.
- Existing ledger entries: MCP lifecycle/shared plugin contracts, Web component tests, ordered
  workspace state, contextual inspector, and React 19.3 version coherence. Reuse
  `workspace-state-refactor.md`, `react-19.3-version-coherence.md` and
  `durable-plugin-call-receipts.md`. Inspect the authoritative protocol and Owner routes at OpenBot
  `a27b327`; the existing `pluginRequest`, RunInspector and closed demo adapter remain the seams.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing React plus DOM/HTML APIs | React 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb`; DOM standard read 2026-09-23 | MIT; WHATWG terms | Reviewed [Strict Effects tests](https://github.com/react/react/blob/1d34f91dfde6bba84d08b683aaba164c7194dacb/packages/react-reconciler/src/__tests__/StrictEffectsMode-test.js), prior pinned hook/license review, [release](https://github.com/react/react/releases/tag/v19.3.0) and [cleanup-order issue 30765](https://github.com/react/react/issues/30765) (closed). Do not depend on parent/child cleanup order. | Already pinned in Web/Desktop. Effect-local abort/timer ownership supports an isolated read-only panel. | Selected standard + existing dependency adapter. |
| TanStack Query | `release-2026-09-22-1338` / `8884f1a4d9ee53cb3cdba26ca28f870500ede3f7` | MIT | Inspected [query observer](https://github.com/TanStack/query/blob/8884f1a4d9ee53cb3cdba26ca28f870500ede3f7/packages/query-core/src/queryObserver.ts), [interval/unsubscribe tests](https://github.com/TanStack/query/blob/8884f1a4d9ee53cb3cdba26ca28f870500ede3f7/packages/query-core/src/__tests__/queryObserver.test.tsx), release and license; [discussion 6364](https://github.com/TanStack/query/discussions/6364) illustrates interval/invalidation differences. | Provides cache/observers but no OpenBot receipt semantics; introducing a parallel cache for one mounted panel adds ownership integration. | Not needed after the existing standard adapter is viable; no dependency change. |

## Reuse decision

- Parse the shared strict receipt list schema (at most 256), reject other Run IDs and duplicate call
  IDs, and preserve Server order. Compose a ten-second request deadline with caller cancellation.
- One in-flight read, followed by a five-second delay, at most 24 automatic reads per opening or
  explicit read refresh. Include terminal Runs: cancelled/failed/completed is not receipt evidence.
  Stop on error; retain prior receipts with fixed Chinese guidance. A refresh only repeats the GET.
  Cleanup cancels the timer/request; keyed Run identity also hides obsolete results before effects.
- Unknown/active records precede collapsed settled records. Bounded scroll areas and native
  disclosure prevent 256 records from expanding the inspector. Render names as escaped text.
- State the exact boundary: `response_received` is a tool response, not independent verification of
  external state. Unknown outcomes require checking the original service before a new task. Existing
  explicitly triggered new-task submission remains unchanged; no call retry is introduced.
- Empty receipts remain invisible, including in the closed synthetic demo/fixture adapter. Its
  allowlisted read-only empty response is not a simulated durable Server ledger.
- Extend the same closed fixture with a `plugin-receipts` scenario: unknown and received samples
  plus an explicit read-failure toggle. It uses the real getter and inspector; its memory records
  grant no authority and never claim crash recovery or resolve the unknown outcome.
- Upgrade/exit: consume later Server receipt fields only after reviewing the shared contract; a
  wider client cache migration should replace this effect rather than adding competing observers.

## Source incorporation

No upstream source copied or substantially adapted. Existing React, Zod and OpenBot adapters are
reused without upgrades; existing dependency notices remain applicable.

## Verification plan

- Schema/bounds/scope/timeout/abort API tests; mounted real component tests for all labels, approval
  facts, terminal-Run polling, finite read budget, one request at a time, stale Run isolation,
  unmount/StrictMode, data retention on error and explicit read refresh without mutation.
- Real RunInspector browser rendering with synthetic unknown/received/error data at desktop and
  narrow widths; disclosure and readable call IDs/timestamps. Check console errors and no mutation.
- Preserve six closed client fixture scenarios. Focused tests, Web/Desktop typechecks and full
  `npm run check`. Product documentation is integrated by the main S1a track.
- This validates shared client rendering and read lifecycle, not a new external-effect guarantee,
  native Desktop runtime session or a real third-party tool execution.

## Unresolved questions

Provider-specific outcome reconciliation and ledger administration remain later Server work.

## Recorded validation

- 2026-09-23: actual Chrome through CUA at the isolated
  `http://127.0.0.1:5191/client-fixtures.html?scenario=plugin-receipts` preview. Desktop 1470×835 and
  narrow 390×844 showed unknown-outcome guidance before task controls, readable IDs and UTC
  timestamps, collapsed received-response disclosure, fixed read errors and explicit read refresh.
  DOM and screenshots confirmed content, page identity and no framework overlay. Narrow document
  width and scroll width both measured 390; no horizontal overflow. Console error/warning list was
  empty. Closing/reopening and switching each of the original six scenarios produced the actual
  inspector without receipt errors or empty receipt sections. No external tool call was made.
- Focused API/component/adapter checks and Web/Desktop typechecks passed. Full `npm run check`
  passed with existing environment-dependent skips. The first sandbox run stopped because existing
  process-cleanup tests could not invoke `/bin/ps`; the normal-permission rerun passed.
- Regular Web and Desktop output contains none of the closed fixture entry/control identifiers.
  No screenshots, temporary QA harness or private data are included in this commit.
