# Official workspace snapshot stream

- Status: Implemented and verified
- Date: 2026-09-23
- Owner: OpenBot contributors
- Acceptance journey: the official shared Web/Desktop client receives complete workspace replacements without an old stream frame overwriting a just-projected change; reconnect and window/profile disposal remain bounded.
- Security boundary: Server remains authoritative. Browser subscription and Desktop cleanup neither grant authority nor cancel a Run. Preserve Owner cookies, proxy header filtering and the existing profile/channel event streams.

## Search evidence

Reviewed the reuse ledger's workspace snapshot, official workspace reconciliation and Desktop event-stream lifecycle entries, `workspace-snapshot-stream.md`, `workspace-authoritative-counts.md`, `desktop-stream-lifecycle.md`, the reference reader and Server implementation at OpenBot `418d0e6` before implementation.

GitHub searches: `repo:electron/electron protocol.handle cancel stream`, `repo:electron/electron EventSource stream`, and the existing React effect-cleanup / TanStack query invalidation research. Inspected Electron 44.3.0 release, `lib/browser/api/protocol.ts`, the abort cases in `spec/api-protocol-spec.ts`, MIT license, closed issue [47097](https://github.com/electron/electron/issues/47097), and a limited current open-issue search (not an exhaustive upstream audit). The issue alone does not establish current platform support. The released Request construction still omits a renderer cancellation signal; raw response-stream abort tests do not establish cancellation of OpenBot's reconstructed, header-filtered proxy response.

Official sources: [WHATWG Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html), [Electron protocol](https://www.electronjs.org/docs/latest/api/protocol), [Electron net](https://www.electronjs.org/docs/latest/api/net), [React useEffect](https://react.dev/reference/react/useEffect). EventSource close aborts its fetch, but cannot supply a database revision shared with another request. React cleanup owns subscriptions; Electron main must retain its explicit upstream cancellation registry.

## Candidate comparison

| Candidate | Exact reviewed version | Maintenance, license and fit | Decision |
| --- | --- | --- | --- |
| Native EventSource / AbortController and existing OpenBot reader | WHATWG living standard reviewed 2026-09-23; OpenBot `418d0e6` | Standard browser transport; existing version-1 bounded full-frame reader and Server tests; MIT repository | First viable option: thin adapter |
| Electron | 44.3.0, release tag object `a5d1c52118831d762385f34c1b3ffbcc4d99de58`, commit `07e460719c75b2ec5ee4893f7d2192ef31c7b8c2` | Current pinned dependency; maintained release and abort tests; MIT. Explicit main-process lifecycle still needed | Extend existing registry with one independent snapshot slot |
| React | 19.3.0, `1d34f91dfde6bba84d08b683aaba164c7194dacb` | Existing pinned dependency and prior effect/StrictMode review; MIT | Keep effect-owned cleanup and callback generations |
| TanStack Query | Reviewed in prior count research at `8884f1a4d9ee53cb3cdba26ca28f870500ede3f7` | MIT; maintained invalidation/observer tests; cache coordination cannot infer cross-stream ordering | No new dependency; not necessary for this boundary |

## Reuse decision

Use the existing optional `/workspace/snapshots` contract, without changing Server/protocol. Its sequence is connection-local, not a global revision. Keep legacy workspace profile notifications and the channel stream independently subscribed.

The exact local gap is ordering full replacements against GET and immediate projections. Close/invalidate the snapshot epoch synchronously on every immediate entity projection and every GET start. Preserve immediate projections and the pending-GET journal. Coalesce authoritative reconciliation through the existing one-second scheduler. Only a clean successful GET (no later invalidation awaiting reconciliation) starts a new snapshot epoch. Reject callbacks from disposed epochs, including frames after a later mutation promise settles. A failed GET retains data and error, stops automatic reconciliation, and waits for a new event or explicit refresh. Pending journals never reopen a stream.

Within one epoch validate version, frame size, stream identity and increasing sequence. Use one EventSource, one reconnect timer, and a silence watchdog. Transport errors retain data; incompatible frames stop that subscription. A live snapshot does not clear a read/mutation error. The UI reports the worse of legacy workspace and snapshot connection state. Desktop has separate workspace, snapshot and channel upstream slots, all synchronously aborted by existing profile/application cleanup and testable window lifecycle bindings; cleanup never waits for a stalled upstream reader.

This conservative migration does **not** reduce GET traffic: sustained immediate events can keep the snapshot stream closed and require a coalesced GET at most once per second (explicit user refresh is separate). A globally comparable durable revision would be a later Server contract change, not invented here.

## Source incorporation

No third-party source copied or substantially adapted. Reuse existing MIT OpenBot reader/lifecycle patterns in the production adapter. No dependency, lockfile, credential policy or private Electron implementation change. Existing repository LICENSE applies.

## Verification plan

- Fake-clock transport tests: duplicate/decreasing frames, reconnect epoch, invalid/oversized payload, silence watchdog, cleanup and callbacks after close.
- Actual hook/App tests with controlled GET and both event streams: immediate projection before/during/after GET, late mutation result, coalesced follow-up, retained errors, profile notifications, abort/unmount and StrictMode ownership.
- Real AbortSignal Desktop proxy tests: all three slots, replacement, window close/navigation/renderer termination and profile clear, including stalled upstream responses.
- Web/Desktop typechecks and full repository check; seven existing isolated shared-component fixtures in a real browser, including narrow viewport.
- Update WORKSPACE_SYNC in English and Chinese. Browser and deterministic bridge fixtures do not certify installed Electron, remote Servers or native operating-system support.

## Unresolved questions

A durable cross-request revision and resumable delta protocol remain out of scope. They would be required to safely remove reconciliation reads during active legacy traffic.

## Verification evidence

The production hook/App tests exercised GET replacement, pending journals, delayed mutation
responses, independent legacy/channel/full streams, duplicate frames, disconnect recovery,
incompatible frames, caller-error preservation, StrictMode and unmount. Desktop fixtures used
real AbortSignals and the same window bindings installed by `main.ts`, including stalled headers,
closed-window late callbacks and the real connection controller's Server switch. No Server or
protocol behavior changed.

Real Chrome QA used the isolated fixture build at `http://127.0.0.1:5192/client-fixtures.html`,
1470 × 835 and 390 × 844. Approval accept and narrow-screen rejection, tool failure details,
cancellation followed by late output, partial output, artifact download action, offline completion
followed by recovered final-message content, and unknown/received/error receipt UI all passed.
The narrow document width was 390 pixels; console errors/warnings were empty, and no framework
overlay or blank screen appeared. Preview and browser tab were closed and viewport reset.
These seven fixtures exercise existing shared components; the new full-workspace stream ordering
is verified by the controlled-transport hook/App tests, not by claiming those fixtures connect to
a live Server. No installed Electron, remote Server, paid inference or native platform test was run.

Final `npm run check` passed: Web 415 tests; Desktop 365 passed with one existing skipped
test; Server 562 passed with 75 existing skipped integration tests. Web/Desktop typechecks and
builds passed. Documentation/research checks passed after this evidence was added.
