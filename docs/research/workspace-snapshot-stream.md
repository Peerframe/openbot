# Research: consistent workspace snapshots for independent clients

- Status: Accepted for implementation
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Acceptance journey: an authenticated read-only client displays global counts and recent records,
  reconnects, and replaces its view without importing React's entity-merge heuristics.
- Security boundary: Server remains authoritative; subscriptions have the existing Owner gate,
  bounded lifetimes/resources, and no write or replay authority.

## Search evidence

Reviewed the existing ordered-workspace and PostgreSQL entries in `OPEN_SOURCE_REUSE.md`,
`workspace-state-refactor.md`, `app.ts`, `postgres-store.ts`, and Web ordering regressions at
`ebce995`. GitHub searches on 2026-09-22: `postgres postgres snapshot isolation tests`,
`kubernetes watch resourceVersion expired`, `repo:drizzle-team/drizzle-orm is:issue is:open
transaction isolation`, and `repo:honojs/hono is:issue is:open SSE abort`.

Primary contracts: [PostgreSQL 17 isolation](https://www.postgresql.org/docs/17/transaction-iso.html),
[Drizzle transactions](https://orm.drizzle.team/docs/transactions),
[HTML SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html), and
[Kubernetes list/watch](https://kubernetes.io/docs/reference/using-api/api-concepts/).
Kubernetes issue [137089](https://github.com/kubernetes/kubernetes/issues/137089) illustrates why
expired cursors need explicit recovery. Hono issues [1770](https://github.com/honojs/hono/issues/1770)
and [3309](https://github.com/honojs/hono/issues/3309) motivate explicit cancellation tests rather
than assuming an RPC client owns the connection. Drizzle issues 952, 543 and 966 concern transaction
ownership; this implementation uses the public callback transaction and no ambient transaction.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance/tests and fit | Decision |
| --- | --- | --- | --- | --- |
| Existing Drizzle/Postgres.js + PostgreSQL repeatable read | Drizzle 0.45.2, `273c78071d4841b497f5144734b38294df7ec64b`; Postgres.js 3.4.9; PostgreSQL 17 | Apache-2.0; Unlicense; PostgreSQL License | Inspected tagged `postgres-js/session.ts`, integration test setup, installed types and official transaction contract; callback passes config before queries on the same connection | Reuse a read-only repeatable-read transaction for every persisted workspace field and count |
| Existing Hono SSE + HTML EventSource | Hono 4.13.7, tag object `deef01f2a2cf432f3761b10c1a4fbfcdcb7f8374` | MIT; WHATWG terms | Inspected tagged `helper/streaming/sse.ts`, installed `utils/stream.js`, current OpenBot stream tests and open issues; public abort hook, backpressure and native browser reconnect fit the existing deployment | Thin adapter, no new dependency |
| Kubernetes resourceVersion/list/watch | API documentation accessed 2026-09-22 | Apache-2.0 docs | Maintained public contract and expired-cursor issue reviewed; requires a durable, ordered revision tied to writes | Do not claim or emulate durable replay with an in-memory event counter |

## Reuse decision

Use PostgreSQL's existing snapshot isolation and standard SSE. Keep `GET /api/v1/workspace`
compatible, but make its persisted read coherent. Add an opt-in full-snapshot subscription whose
sequence is scoped to one connection. A new connection always replaces state with a fresh snapshot;
`Last-Event-ID` never requests replay. Coalesce invalidations, serialize reads and periodically
refresh for mutations not represented by current hubs. Retain legacy token/progress event streams.

The exact local gap is assembling OpenBot's existing query projections inside one transaction and
connecting its existing change signals to bounded full snapshots. Neither a client cache nor a
message bus creates database consistency. Nodes remain a separately sampled in-process view;
their count is computed from that exact array. Global active Run counts are not inferred from the
50 most recent Runs. No global revision, multi-Server ordering or external-action replay is added.

Failure behavior: read failure closes the subscription without serializing the raw database error;
the client marks its retained view stale and reconnects for a complete snapshot. Bound active
subscriptions, update rate, payload bytes, database statement duration and stalled writes. A
future durable cursor API can replace the transport while retaining the snapshot semantics.

## Source incorporation

No upstream source copied or substantially adapted. Existing dependency notices remain unchanged.

## Verification plan

HTTP authentication and authoritative-read regression; synthetic PostgreSQL concurrency test
showing counts and rows share one snapshot, including active Runs outside the recent page; stream
initial delivery, coalescing, duplicate/out-of-order consumer frames, abort during reads, reconnect,
bounded failure and cleanup. Run focused suites and `npm run check`. Document the public contract
and standalone reference client in English and Chinese. Evidence establishes a single-Server
snapshot contract, not platform certification or durable event replay.

## Unresolved questions

Durable revision history, multi-Server distribution, efficient large-workspace pagination and
migrating existing optimistic Web projections remain separate follow-ups.

## Integration findings

Review identified that Postgres.js transaction pool acquisition is not abortable. The adapter now
bounds one underlying read and 32 callers, removes cancelled callers immediately, times out callers
after ten seconds, and refuses new reads while an expired underlying read still owns its slot.
Callers arriving after a query starts wait for the next read. No unbounded abandoned SQL is created.

Actual browser testing through the reference Vite proxy reproduced a silent upstream disconnect
without an EventSource error. Reuse the existing Web subscriber's 35-second activity watchdog
pattern: mark stale, close the old source, reconnect after two seconds, and ignore late old-source
frames. The independent example implements that small lifecycle contract without React imports.
