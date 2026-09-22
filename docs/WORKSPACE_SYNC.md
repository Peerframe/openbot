# Workspace snapshot contract

[English](WORKSPACE_SYNC.md) · [简体中文](WORKSPACE_SYNC.zh-CN.md)

An independent read-only client can use authenticated `GET /api/v1/workspace` or subscribe to
`GET /api/v1/workspace/snapshots`. Both retain Server authority. The reference client in
[`examples/workspace-reader`](../examples/workspace-reader/index.html) imports no React, Desktop,
database or Server implementation.

## What a snapshot means

Persisted channels, Bots, recent Runs, approvals, artifacts, progress and their counts come from
one PostgreSQL read-only repeatable-read transaction. Connected Nodes are a separate live sample
taken immediately afterwards; `counts.connectedNodes` equals that array's length. Node presence
and persisted task state are not one atomic distributed observation.

| Field | Scope |
| --- | --- |
| `channels`, `bots` | Current complete collections |
| `runs` | Latest 50 by creation time; not all active Runs |
| `approvals`, `artifacts` | Latest 100 each; not complete history |
| `progress` | Latest 200 persisted progress records in chronological order |
| `counts.channels`, `counts.bots` | Global totals in the same database snapshot |
| `counts.activeRuns` | Global count of queued, assigned, running, waiting_approval and blocked Runs |

Never calculate global active counts by counting the recent Run page or adding event deltas to a
possibly incomplete page. A completed Run outside that page still changes the global count.

## Official Web/Desktop client reconciliation

The shared `useWorkspaceState` hook now consumes the version-1 full snapshot stream after a
successful workspace GET. `counts.activeRuns` always comes from an authoritative GET or complete
frame. Legacy Run events and successful task/approval responses still project entities immediately,
but never add or subtract from that global count. Recent records cannot establish an off-page
Run's prior membership, and the authoritative read may already include the received event.

There is no revision comparable across GET, full frames and legacy/mutation responses. The official
client therefore closes and invalidates its snapshot subscription **before every immediate entity
projection and every GET start**. It journals projections arriving during that GET and applies them
over its response. Any intervening projection requires one subsequent fresh read; no snapshot
subscription opens while that follow-up is pending. Only a successful read without pending
invalidation opens a fresh snapshot epoch. Late frames from any closed epoch, old GET completions,
and old legacy connection callbacks cannot replace the current state. A mutation promise settling
late establishes a new projection barrier too.

All immediate entity projections request a coalesced authoritative reread. Event-driven reads start
at most once per second, with one current request and one pending invalidation. Journal replay does
not itself invalidate. Explicit refresh and workspace reconnect can abort and replace the current
GET. A finite burst settles, but **sustained legacy traffic can keep the snapshot stream closed and
continue one coalesced GET per second**. This migration does not claim fewer GET requests.

If a GET fails, the prior data and immediate projections remain visible with the existing error UI.
No automatic GET retry or stream reopening follows; a later entity event, explicit refresh or legacy
workspace reconnect can retry. A snapshot-only disconnect instead keeps data and uses one two-second
reconnect timer. Opening headers is insufficient for “synced”: a valid complete frame must arrive.
Thirty-five seconds without a newer valid frame closes and replaces the connection. Incompatible
version/envelope/collection shape, oversized frames or a stream identity change stop that
subscription with a fixed error; explicit refresh can retry. A live stream never clears a separate
mutation/GET error. The workspace connection indicator reflects both full and legacy workspace
streams; the channel retains its own independent connection state and token/progress delivery.

Unmount clears timers, closes the subscription, invalidates epochs and aborts GET without waiting
for a stalled read. Owner/Server changes remount the authenticated workspace. Profile notifications
remain on the legacy stream. Current ContextRail metrics still describe the loaded recent records;
they are not relabeled as global totals. Counts may lag immediate projections until reconciliation.

Deterministic tests use the actual shared hook, authenticated workspace and controlled EventSource
transport without credentials or paid models. See [ordering and lifecycle research](research/official-workspace-snapshot-stream.md)
and the earlier [global-count research](research/workspace-authoritative-counts.md).

## Subscription and recovery

Each `workspace.snapshot` SSE event contains `{type, version: 1, streamId, sequence, snapshot}`.
`snapshot` has exactly the existing GET response shape. Replace the whole previous view. Within
one connection, ignore duplicate or decreasing sequences. Gaps are safe because every frame is
complete. This is connection-local ordering, not a database revision or optimistic-write token.

The first frame of every connection is a fresh read. Reconnect resets sequence to 1 and changes
`streamId`. The Server ignores `Last-Event-ID`; it does not retain/replay a durable event log.
On a disconnect, keep the last view visibly stale until a fresh frame arrives. An unknown version
must stop projection and show an incompatibility error. A 401 requires login; a 429 means stream
capacity has been reached. Native EventSource does not expose HTTP status, so the reference client
shows a stale connection while retrying; callers needing precise diagnostics can check the GET.
The reference reader also treats 35 seconds without a fresh snapshot as stale and replaces the
connection after two seconds. This covers proxies that leave a dead upstream connection open;
late frames from a replaced connection cannot update the view.

Transient model tokens and legacy entity events are separate streams. A snapshot does not contain
every token, prove an external action succeeded, or make a cancelled task's external effects vanish.

## Resource and compatibility limits

The optional snapshot route permits 16 concurrent streams per Server process. It coalesces change
notifications into at most one read per second per stream and refreshes at least every 15 seconds
when reads/writes complete normally. The periodic refresh also covers mutations that have no hub
notification. It allows one read/write at a time, closes writes stalled for five seconds, rejects
frames over 2 MiB and reconnects after five minutes to recheck authentication. Each SQL statement
has a five-second timeout. Read/output failure closes the stream without exposing raw errors.

One Server-wide reader permits at most one actual database read and 32 waiting callers. Each caller
has a ten-second deadline and can cancel immediately, including during pool acquisition. A
Postgres.js transaction waiting for a connection cannot itself be cancelled; if it outlives that
deadline, its single slot remains occupied and new reads fail until it settles. No background
queries accumulate. Callers arriving after a read starts wait for the next fresh read. GET returns
a generic 503 on read unavailability; subscription failures close the stream for resynchronization.

This is a single-Server contract. Legacy GET and event consumers remain compatible. Existing Web
entity projections remain immediate; global active-count reconciliation is described above.
Desktop's existing `/api/v1/*` proxy now owns three independent upstream stream slots: legacy
workspace, workspace snapshots and the selected channel. Replacing one aborts only that slot;
main-frame navigation, renderer termination, window close, Server/profile clear and application quit
abort all three synchronously. Node tests exercise the installed window bindings and connection
controller using real AbortSignals, including upstream headers that have not settled. These are
bridge fixtures, not installed Electron or remote-Server certification. Renderer EventSource close
alone is not relied upon to propagate cancellation through Electron's reconstructed proxy response;
the main-process registry bounds and disposes upstream connections. Large-workspace pagination,
a durable revision log and multi-Server distribution require separate contracts. Do not interpret
a stream sequence as any of those.

## Run and verify the reference client

After `npm ci`, start a local Server on port 3001 using the contributor setup. Run `npm run dev:reader`
and open `http://127.0.0.1:5173`. Use the local Owner password. The example uses the existing cookie
login and same-origin Vite proxy, keeps the password out of storage, and renders values as text.
Port 5173 must be free; this example replaces the development Web entry for the duration of the test.
It submits no tasks and performs no mutations after sign-in. No model key or Worker is needed.

`npm run test:workspace` runs HTTP/stream and independent-consumer regressions. `npm run db:verify`
also runs `scripts/verify-workspace-snapshot.mjs` against the explicit disposable `_test` database.
That test commits a concurrent channel between collection and count reads, checks an active Run
outside the 50 recent records, and checks a subsequent snapshot sees the committed mutation.

See [ADR-0046](decisions/0046-workspace-snapshot-stream.md) and the
[pinned research](research/workspace-snapshot-stream.md).
