# Research: Preceding Bot answer cutoff retains PostgreSQL timestamptz microseconds

- Status: Accepted
- Date: 2026-09-23
- Owner: @yxflc11
- Related issue: OpenBot R3
- Acceptance journey: A Bot reply that lands after a later Owner task is queued but before that task's RUN_STARTED, including the same wall-clock millisecond with an earlier microsecond, appears in `initialContext` / `context` for the later task; replies after start, later independent human inputs, and out-of-tree replies stay excluded.
- Security boundary: Server-owned PostgresAgentStore context only. Models remain untrusted. No new privileges, network, or Client-writable timestamps. Fail closed when RUN_STARTED is missing.

## Search evidence

- Search date: 2026-09-23
- GitHub queries: `repo:drizzle-team/drizzle-orm timestamp withTimezone Date precision`; `repo:postgres/postgres timestamptz microsecond`; `ECMA-262 Date time values milliseconds`
- Standards and primary documentation queries: [PostgreSQL 17 datetime](https://www.postgresql.org/docs/17/datatype-datetime.html) (timestamptz stores microsecond precision); [ECMA-262 Date](https://tc39.es/ecma262/#sec-time-values-and-time-range) (millisecond time values); Drizzle `timestamp({ withTimezone: true })` default JS `Date` mapping
- Existing OpenBot issue, ADR, and reuse-ledger entries checked: `docs/OPEN_SOURCE_REUSE.md` PostgreSQL migration integrity / Postgres.js entries; `docs/research/TEMPLATE.md`; native Agent collaboration presentation research; `apps/server/src/postgres-agent-store.ts` context freeze comments

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Compare cutoffs after `Date` / `toISOString()` | ECMA-262 Date; Drizzle timestamp→Date | N/A | Existing code path | Loses sub-millisecond timestamptz; flake on PG 17.11 | Reject |
| Widen boundary by +1ms / sleep | n/a | n/a | Flaky | Changes product semantics; forbidden for R3 | Reject |
| SQL column/subquery `timestamptz` compare | PostgreSQL 17 timestamptz; drizzle-orm `sql` fragments | PostgreSQL License; Apache-2.0 Drizzle | Keep Drizzle query builder; no new dependency | Preserves microsecond ordering Server-side; fail-closed if RUN_STARTED missing | Select |
| Drizzle `mode: 'string'` schema migration | drizzle-orm timestamp mode | Apache-2.0 | Broad schema change | Out of R3 file scope | Reject for this slice |

## Reuse decision

- Selected option: local gap on top of existing Drizzle + PostgreSQL stack
- Selected upstream or standard: PostgreSQL 17 timestamptz microsecond storage; compare cutoffs in SQL without JS Date round-trip
- Why this is the first viable option: OpenBot already uses Drizzle/Postgres.js; the bug is OpenBot-specific cutoff marshalling, not a missing library
- Exact OpenBot-specific gap: `context`/`initialContext` loaded `RUN_STARTED.created_at` and source `created_at` into JS `Date`, then reused them in `lte` / `toISOString()::timestamptz`, truncating microseconds so a preceding Bot reply in the same millisecond could sort after the truncated start cutoff and drop from history
- Upgrade, replacement, or exit plan: remain on Drizzle `sql` subqueries; a future schema-wide `mode: 'string'` timestamps change is optional and out of scope
- Failure behavior when the upstream is missing, incompatible, or compromised: N/A (database column comparison); missing RUN_STARTED still throws `conflict`

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: n/a
- Required copyright or license notice location: n/a

## Verification plan

- Automated tests: extend `agent-collaboration.integration.test.ts` to pin Bot reply and RUN_STARTED to the same millisecond with reply micros earlier; assert `PRECEDING_ANSWER_AFTER_QUEUE` is present without sleep/+1ms
- Negative and fail-closed tests: retain existing exclusions for later independent human input, after-start Bot observation, delegated root freeze, 12-row window, and explicit reply references
- Platforms and devices: real disposable PostgreSQL 17.11 loopback (`OPENBOT_COLLAB_TEST_DATABASE_URL`)
- User-visible documentation and translations: research EN + zh-CN only for this slice
- Support level that the evidence permits: Server collaboration context ordering on PostgreSQL 17.11 as tested

## Unresolved questions

- None for this slice.
