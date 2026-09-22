# ADR-0046: coherent snapshots and explicit resynchronization

- Status: Accepted
- Date: 2026-09-22

## Context

Workspace entities and counts currently come from independent database snapshots. A recent Run
page cannot establish the global active count. New clients should not copy Web-specific replay
heuristics to obtain an authoritative read-only view.

## Upstream review

See [pinned review, licenses, source, issues and limits](../research/workspace-snapshot-stream.md).

## Reuse decision

Reuse Drizzle 0.45.2, Postgres.js 3.4.9, PostgreSQL repeatable read and Hono 4.13.7 SSE. The small
adapter assembles existing projections; no cache framework, queue or event store is introduced.

## Source incorporation

No copied or substantially adapted upstream source. Existing dependency notices are retained.

## Verification plan

Test HTTP ownership, transaction consistency, recent-page/global-count distinction, serialized
stream snapshots, cancellation, resource bounds and consumer reconnection. Keep a framework-free
reference client and bilingual contract. Run the repository check and disposable PostgreSQL test.

## Decision

`GET /api/v1/workspace` retains its shape and reads persisted fields in one read-only repeatable-read
transaction. Node presence is sampled independently from the registry; its count matches that array.
The new `/api/v1/workspace/snapshots` SSE route emits complete `workspace.snapshot` frames with
version 1, a connection id and monotonically increasing connection-local sequence. The snapshot
replaces the prior view; it is never an incremental delta. Reconnect means a new complete snapshot,
including when `Last-Event-ID` is supplied. A connection-local sequence is not a database revision.

## Consequences

Independent clients can ignore transient token and entity events. Periodic reconciliation covers
the existing hubs' incomplete mutation coverage. Full snapshots cost more bandwidth and queries
than deltas, so streams, rate, bytes, query time and write duration are bounded. Existing clients
and Desktop consumers continue to use their current routes. The generic Desktop proxy already
forwards `/api/v1/*`, including snapshots; its lifecycle manager still needs reviewed replacement
and cleanup handling before the official renderer adopts this stream. Multi-Server ordering is not claimed.
