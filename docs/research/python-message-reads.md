# Research: bounded Python channel-message reads

- Date: 2026-09-23
- Status: Implemented; independent local acceptance.
- Baseline: 6b6dd9a (conversation transactions accepted).

Reuse OpenAPI 3.1, Pydantic 2.13.5 and Psycopg 3.3.6 from the complete
[control-read review](python-control-read-slice.md), and PostgreSQL 17.11 from the
[identity transaction review](python-identity-transactions.md). The same exact releases, tests,
platform restrictions and dependency licenses apply. No new dependency or upstream source copying.
Existing OPEN_SOURCE_REUSE entries cover this thin compatibility adapter; a second ORM, message
store or migration engine would duplicate existing authority and is not selected.

Inspected domain Message, postgres-task-records.ts toMessage, postgres-store.ts listMessages and
the GET route at this baseline. Existing behavior requires a channel, selects its newest 100
messages and returns them chronologically; null optional IDs are omitted. It does not define order
when timestamps tie. Preserve the bounded window and add id as a deterministic secondary order.
Do not claim tie-order parity with the old unspecified query. Invalid stored author types fail
closed, as other Python projections do, rather than returning unchecked values or repairing data.

Reviewed PostgreSQL 17 [LIMIT ordering](https://www.postgresql.org/docs/17/queries-limit.html),
[CTE evaluation](https://www.postgresql.org/docs/17/queries-with.html),
[string byte lengths](https://www.postgresql.org/docs/17/functions-string.html) and
[17.11 release fixes](https://www.postgresql.org/docs/17/release-17-11.html).
GitHub/source searches included `postgres/postgres REL_17_11 limit.sql with.sql`; the web fetcher
could not fetch those two regression files, so no new claim of reviewing their contents is made.
Reuse the already recorded PostgreSQL source/license review and validate this query against the
pinned real PostgreSQL fixture rather than assuming optimizer behavior from unavailable files.

Extend the existing read-only transaction and its final session recheck. Authorize before channel
existence becomes observable. Use one snapshot for channel existence and its selected message
window. Bound the selected text bytes at the database boundary and the resulting public JSON at
4 MiB; over-limit content is an error, never silently shortened or omitted. No writes, parsing of
message instructions, model invocation, reply dispatch, attachment loading or run creation.

Acceptance: actual TS/Python equality for chronological Unicode messages with all optional IDs,
empty and missing channels, latest-100 isolation across channels, deterministic ties, revoked and
expired sessions, malformed projection values and oversize content failing without mutation.
Current PostgreSQL CHECK constraints already reject invalid authors; test corrupt author mappings
at the projection boundary without dropping a database constraint. Existing real
loopback entry must serve the message fixture. Message submission remains atomic with S2b tasks.

Local evidence: 288 package cases (including 12 reviewed worker projection cases), 29 combined
PostgreSQL/real HTTP cases, and 81 retained input comparisons. The paired oracle covers the latest
100 of 105 messages with Unicode, three author types and optional references, plus an empty channel.
No TS tie-order equivalence is claimed. Hosted CI and production selection remain pending.
