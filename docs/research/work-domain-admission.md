# Research: work-domain admission and action outcomes

- Status: implementation qualification, not a selected dispatcher
- Date: 2026-09-23
- Owner: OpenBot integrator
- Acceptance journey: authenticated Task creation independently of a chat, immutable proposed
  Action, exact approval, bounded shared reservation, uncertain effect and verified reconciliation.
- Security boundary: only the trusted Python control service writes domain facts; engines schedule,
  Runtime proposes and external executors report evidence. No external tool is enabled by this slice.

## Search evidence and reuse

Reviewed PostgreSQL 17.11 [row locking](https://www.postgresql.org/docs/17/explicit-locking.html)
and [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html), existing
OwnerTransactions/session revocation, task admission/lifecycle research and the reuse ledger.
Inspected the pinned PostgreSQL fixture, psycopg 3.3.6, existing authority transactions and real
concurrency tests. Existing tools are retained; no new library or copied upstream implementation.
PostgreSQL is under the PostgreSQL license; psycopg is LGPL-3.0 under its existing dependency terms.

Pinned DBOS 3.0.0 and Temporal SDK 1.33.0 fault probes establish that the engine's completion does
not establish an external outcome. Their workflow histories cannot replace application authority.
DBOS documents transaction-coupled enqueue; Temporal requires a separate reliable admission bridge.
No dispatch bridge is selected/implemented here, and no parallel retry scheduler is added.

## Domain decision

Use additive work-domain tables alongside legacy chat-coupled Runs. Legacy Runs require a Channel
and cannot directly represent a Task independent of chat. They remain transitional compatibility
records, not silently reclassified as user Tasks. New tables are Python-control-owned; old routes
never query their rows. The eventual legacy migration needs explicit provenance and retirement.

A Task and its first Run are created atomically under an Owner idempotency key; the admission row
is also the durable handoff obligation for a future engine bridge. A submitted Task is queued until
that bridge actually admits execution. Its public projection must not claim that it is running.
The same immutable key with different content is a conflict, never a new task or overwritten intent.

Lock order is session (Owner commands), then Task, then Run/Action. All domain writers serialize
through the Task row, so independent Runs cannot over-reserve the same Task budget. Snapshot holds
a shared Task lock across projection reads. A revision and append-only event commit with each fact.
No user timestamps or JavaScript Date rounding determine authority or expiration.

Proposed Action payloads are immutable, bounded canonical JSON with a digest. Approval binds that
digest and authority generation, and expires using database time. Admission rechecks the current
generation and reserves an explicit token ceiling. Replaying admission never yields a second
permission to dispatch. An admitted Action with no recorded receipt is unresolved, not failed.

Cancellation/revocation stop new admission and invalidate pending approval; already-admitted work
retains its reservation until evidence resolves it. A receipt is accepted by a trusted resolver,
not by a model or Owner-supplied claim of success. Applied/not-applied observations need a bounded
reference to adapter-verified evidence. True reported usage may exceed a reservation: retain the
truth and block new spending rather than rolling back the receipt to conceal overuse.

## Verification and scope

Use the existing disposable PG17.11 integration fixture for real session, row-lock, idempotency,
concurrent reservation, approval binding/expiry, cancellation and unknown-outcome tests. Wire tests
into the existing Python-control integration command/CI. Missing schema fails closed.
No real model, external account or user database is used. A domain reservation is not a price bill.
No process isolation, effect-side fencing or whole-product acceptance follows from this slice.

## Remaining integration gates

The selected engine must own replay; admission-to-enqueue needs crash recovery. Runtime checkpoints
need the separately measured SDK continuation contract. Execution leases/fencing, real adapter
verification, artifact publication, public API journey and production persistence remain required.
These methods must not be wired to arbitrary model/worker output as a trusted result resolver.
