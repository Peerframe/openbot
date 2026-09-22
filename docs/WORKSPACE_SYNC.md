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
optimistic projections are unchanged. Desktop's generic `/api/v1/*` proxy can forward this route,
but its event-stream lifecycle manager has no snapshot replacement/cleanup slot yet, and the
official renderer does not subscribe to it. Add and verify that lifecycle before integrating the
stream into Desktop. Large-workspace pagination, a durable revision log and multi-Server
distribution require separate contracts. Do not interpret a stream sequence as any of those.

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
