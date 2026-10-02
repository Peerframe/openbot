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

## C18 cursor pagination (2026-10-02)

The existing Owner read policy and reviewed versions remain unchanged. Extend the same materialized
SQL window with at most101 ID/time candidates, at most100 selected bodies, and a strict
`(created_at,id COLLATE "C")` before boundary. The extra candidate determines hasMore without
transferring its body. SQL byte bounds and the final session recheck apply to every page. Reuse
PostgreSQL17 `ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1`, psycopg3.3.6 and Python3.12 stdlib;
no schema, migration, dependency or upstream code is added.

Compared offset pagination (positions shift after deletions), message-ID lookup cursors (deleted
anchors cannot be found), and a self-contained position cursor. Select the latter: version/channel,
full UTC microsecond timestamp and ID encoded with stdlib URL-safe base64. Bounds, exact keys,
unique JSON fields, calendar validation and channel binding are checked; it is a position, never
an authorization grant. A forged position cannot bypass the unchanged Owner/channel checks.
Clients treat it as opaque. No cursor database, signing service or private content is needed.

Primary evidence: PostgreSQL [row comparisons](https://www.postgresql.org/docs/17/functions-comparisons.html)
and [unique LIMIT ordering](https://www.postgresql.org/docs/17/queries-limit.html), Python3.12
[base64 validation](https://docs.python.org/3.12/library/base64.html). Reuse the source/license
review above; targeted query terms: PostgreSQL17 row constructor comparison keyset pagination,
Python3.12 b64decode validate. Real pinned PostgreSQL tests settle ordering and deletion behavior.

Default no-query behavior retains the latest100 chronological Messages, adding hasMore and an
optional nextCursor. A before page returns strictly older messages in chronological order.
Invalid/duplicate/unknown query fields return422; limit defaults100 with range1–100. Deleted
anchors remain usable; missing/deleted channels return404 only after authorization. Paging does
not promise one immutable snapshot across requests: later inserts/deletes are ordinary current
facts. Tests pin empty/exact/overfull/multiple pages, tied/sub-millisecond times, deleted anchors,
channel isolation, input refusal and session revocation. Frozen oracle Message content/order remain
compared; new metadata has its own real-database assertions.
