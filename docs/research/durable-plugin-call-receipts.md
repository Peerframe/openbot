# Research: durable MCP call receipts and uncertain external outcomes

- Status: Accepted for implementation
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Related issue: S1a durable work
- Acceptance journey: an Owner can inspect an exact approved call after a Server process crash;
  a local MCP tool writes once and drops its response, recovery reports `outcome_unknown` and never
  replays the call. Approval delivery and external-effect evidence are separate.
- Security boundary: single Server owns grants, approval, dispatch admission and encrypted receipts.
  A received tool response is untrusted provider evidence, not independent proof of an external write.

## Search evidence

- Search dates: 2026-09-22–23. GitHub queries: `modelcontextprotocol/typescript-sdk StreamableHTTP
  reconnect tools call timeout side effects retry`; `npm/write-file-atomic rename fsync directory`.
- Read MCP 2025-11-25 [cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation),
  [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and
  [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Cancellation can
  arrive too late or be ignored; a disconnect does not establish absence of side effects. SSE
  message redelivery is not permission to repeat a `tools/call` POST.
- Inspected SDK 1.30.0 at `2d889f2b329e46680ec9bdd565de4616c497825a`: `src/shared/protocol.ts`,
  installed client/transport, `test/client/streamableHttp.test.ts` and MIT LICENSE. Tests include
  no reconnection after a response/close and `maxRetries: 0`; the protocol cancels pending response
  promises without proving whether the server executed the request. Reviewed
  [issue 2098](https://github.com/modelcontextprotocol/typescript-sdk/issues/2098), which reports
  server-side success with client timeout. Do not apply v2/main semantics to the pinned v1 client.
- Inspected write-file-atomic 8.0.0 [source](https://github.com/npm/write-file-atomic/blob/v8.0.0/lib/index.js),
  `test/basic.js`, `test/concurrency.js`, `test/integration.js`, release tree and ISC LICENSE.
  It fsyncs the temporary file then renames, serializes same-path writes and propagates failure.
  [Issue 64](https://github.com/npm/write-file-atomic/issues/64) distinguishes atomic rename from
  directory durability. This slice proves process-crash recovery, not machine power-loss durability.
- Existing reuse entries: MCP lifecycle/shared plugin contracts, third-party MCP integration and
  atomic sensitive files. Checked `third-party-mcp-plugins.md`, `plugin-flow-refactor.md`, S1 track,
  `plugin-service.ts`, encrypted `FilePluginStore`, Server startup and existing approval tests at
  `86223c6236651f260a73b3515f5d38fd11616d1b`.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| MCP and official SDK | 2025-11-25; SDK 1.30.0 / `2d889f2b329e46680ec9bdd565de4616c497825a` | Specification terms; MIT | Released client cancellation/HTTP lifecycle tests; active issue 2098 reviewed | Existing transport, no POST retry; cannot provide OpenBot Owner approval or cross-process receipts | Reuse unchanged |
| Atomic encrypted Server store | write-file-atomic 8.0.0 plus OpenBot `86223c6` | ISC; MIT | File fsync/rename/failure/concurrency upstream tests plus existing OpenBot ACL/encryption tests | Existing single-Server credential storage boundary, no new dependency | Extend with bounded metadata ledger |
| MCP experimental task storage | SDK 1.30.0, same pin | MIT | SDK task handlers and terminal-state checks | Requires cooperating task-capable remote servers and stores task results; does not recover arbitrary existing tools or Owner decisions | Not this receipt contract |
| New workflow engine or another receipt database | Not selected | Not applicable | No additional candidate needed for the selected viable adapter | Would expand scheduling/persistence and still require the same uncertain-effect boundary | Keep current storage adapter |

## Reuse decision

- Selected option: open standard + existing dependencies + thin Server adapter. No new dependency.
- Exact gap: current audit merges all failures, retains only 500 events and exposes no historical
  call lookup. Pending decisions exist only in memory. Add a separate bounded metadata ledger,
  preserving unknown outcomes and active calls when pruning older settled receipts. If the ledger
  contains only protected records at capacity, admission fails before connection or dispatch.
- Store only local identifiers, reviewed plugin revision, names, mode, timestamps, decision and
  execution state. No parameters, result bodies, endpoint, token or raw failure text. Original
  approval arguments remain ephemeral; restart cannot reconstruct/reuse an approval to dispatch.
- Recovery converts a persisted dispatch intent lacking a durable response to `outcome_unknown`.
  Preparing/waiting calls become `not_dispatched`; unresolved approval becomes `interrupted`.
  Existing decisions remain queryable. Even the intent-committed/before-wire crash window is unknown.
- A late response after cancellation cannot mutate terminal Run state or trigger replay. Failed
  receipt persistence after dispatch leaves a durable dispatch intent for recovery. Corrupt/missing
  keys fail closed. Existing legacy files load with an empty ledger; old 500-event audit is not
  enough evidence to fabricate recovered call results.
- Owner-only read APIs expose bounded receipt schemas by call or Run. Decision POST stays single
  consumption. There is no retry, replay, reconciliation-write or automatic resume endpoint.
- Upgrade/exit: retain independent call identity and SDK-independent state. Future provider-specific
  reconciliation must prove external state separately and must not reinterpret a transport receipt
  as proof. Multi-Server scheduling and Worker capability leases remain separate.

## Source incorporation

- Source copied or substantially adapted: no upstream source. Extend existing OpenBot MIT code;
  normal dependency license notices stay intact in `THIRD_PARTY_NOTICES.md` and installed packages.

## Verification plan

- Unit/service tests: dispatch and terminal write failures, approval duplicate/expired/rejected
  decisions, capacity admission, audit rollover, old encrypted state, repeated recovery, cancelled
  late results, secret-free projection and authenticated lookup routes.
- A child process uses the production FilePluginStore, PluginService and MCP transport against a
  real loopback SDK server. Kill the child without cleanup after the remote counter increments
  while its response is withheld; restart from the same store and prove unknown outcome + one
  remote write. Also kill after approval commit before dispatch. No product test flags/hooks.
- Run focused suites, Server/protocol typechecks and `npm run check`. Maintain PLUGINS English and
  Chinese. Fixtures use only synthetic data and local endpoints, no personal configuration or fees.
- Evidence permits one Server process restart on the tested platform; not exactly-once external
  effects, power-loss recovery, remote reconciliation, distributed ownership or device control.

## Unresolved questions

- Unknown receipt resolution/retention administration requires a later reviewed Owner workflow;
  this slice preserves unknown records and fails closed at capacity instead of silently deleting.
