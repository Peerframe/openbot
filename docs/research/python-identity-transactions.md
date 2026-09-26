# Research: Python Bot/channel creation transactions

- Date: 2026-09-23
- Status: Implemented; nineteen combined local PostgreSQL/HTTP cases passed. Hosted Linux CI pending.
- Scope: two explicitly selected Owner-only identity creation endpoints. No task execution,
  direct-conversation creation, realtime transport, migration, deletion or production selection.

## Reviewed sources and reuse

The existing adapter review is [S2a-2](python-owner-auth.md), with Psycopg 3.3.6 (LGPL-3.0-only),
PostgreSQL 17.11 (PostgreSQL License), FastAPI 0.141.1/Starlette 1.6.0, and no new dependencies.
Inspected OpenBot `990a1b5` createBot/createChannel transactions, routes, DTOs, immutable SQL
0000/0001/0011/0016, and run/evolution event payloads. Input compatibility is a separate bounded
[Pydantic/Zod adapter](python-identity-inputs.md), with a real TypeScript differential oracle.

On 2026-09-23 searched official PostgreSQL 17 locking docs and Psycopg transaction/JSON docs;
reviewed pinned upstream [JSON adapter](https://github.com/psycopg/psycopg/blob/3.3.6/psycopg/psycopg/types/json.py)
and [JSON tests](https://github.com/psycopg/psycopg/blob/3.3.6/tests/types/test_json.py), plus
[PostgreSQL isolation tests](https://github.com/postgres/postgres/blob/REL_17_11/src/test/isolation/specs/lock-update-delete.spec).
The GitHub web fetch missed cache; raw.githubusercontent.com returned these exact tagged files.
Reuse released Jsonb adaptation and parameterized queries, not custom escaping or an ORM/migrator.
The auth review already records Psycopg transaction source/tests, releases, issues and platform fit.
A narrow GitHub open-issue search `repo:postgres/postgres is:open "FOR SHARE"` returned zero;
PostgreSQL uses mailing-list bug reporting, so this is not a comprehensive bug audit.

[PostgreSQL's row-lock contract](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)
distinguishes SHARE (blocks ordinary UPDATE, including revocation) from KEY SHARE (does not).
Use SHARE for the authorized session row across the complete creation transaction. Recheck expiry
using clock_timestamp immediately before completion. An earlier committed revocation rejects the
write; a later logout waits until the accepted transaction ends. No process-local lock suffices.
Use sorted KEY SHARE locks for selected Bot rows, preserving membership existence through insertion.
Existing unique/FK/check constraints remain the final authority. No independent schema definition.

No upstream source copied or substantially adapted. Existing MIT OpenBot business semantics are
reimplemented as a narrow adapter. Installed licenses remain intact. A new general-purpose event
bus, idempotency framework, user system or repository abstraction is unnecessary for this slice.

## Frozen behavior and limits

- Explicit `identity` reference mode enables auth plus POST /bots and /channels; default stays
  read-only. Configured exact origins, Owner cookies, bounded JSON and schema history remain gates.
- Authenticate before reporting input validation; the write transaction independently revalidates
  and locks the session. Models/Runtime never receive this database interface or Owner credentials.
- Bot insertion, initial manual evolution event and BOT_CREATED event commit together; create only
  idle status, selected declared profile and appearance, never tool grants or settings credentials.
- Channel insertion, validated member joins and CHANNEL_CREATED/BOT_JOINED_CHANNEL events commit
  together. Preserve normalized input order in the creation response; read order stays documented.
- Preserve 201/envelopes, unique-name 409 and missing Bot 422. Generic storage failures are 503
  without automatic replay; failed transactions must not leave partial identity/events.
- Existing transient profile notifications are not provided yet; no complete client parity claim.
  This reference is a deliberately selected writer for its fixture, not a production dual-write.

## Required acceptance

Real synthetic PostgreSQL: both creations, Unicode/appearance/default profile, exact stored event
payloads, member order, concurrent duplicate names, missing Bot with no residue, forced audit failure
rolling back identity, session revoked before and while waiting on a transaction lock, and no write
for expired/unauthenticated requests. Compare Python-created DTOs through the actual TS read API.
Verify exact mode startup and real HTTP creation, route/schema selection, origin/body limits and
sanitized errors. Retain previous read/auth checks, bilingual docs and full npm check.

Shared HTTP body admission reuses Starlette's request stream and Python 3.12 json decoding. A
single bounded helper serves login and creation, rejecting non-standard NaN/Infinity constants
(which Python otherwise accepts) to match JSON.parse. It does not parse or authenticate credentials;
each route retains its own authorization and typed payload policy.

Local acceptance includes exact stored initial evolution/run events, TS readback of Python-created
identity, one winner for simultaneous Bot names, missing member rejection, audit-trigger failure
rolling back Bot/channel creation, revoked/expired sessions, revocation committed while the writer
waits for its session row lock, expiry while blocked on audit, and real identity-mode HTTP startup.
The unchanged 0022 migration scopes ordinary channel uniqueness separately from direct chats;
the duplicate fixture targets an ordinary channel rather than incorrectly treating all names alike.

Final local acceptance: 253 package cases, 81 real Zod/Python differential inputs, and nineteen
owned PostgreSQL/HTTP cases. Package-only runs explicitly skip the latter nineteen.
