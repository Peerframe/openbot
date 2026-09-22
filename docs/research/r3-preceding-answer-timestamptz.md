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
- Pinned stack already on the reuse ledger (no new dependency): [Drizzle ORM 0.45.2 `e7dfa145`](https://github.com/drizzle-team/drizzle-orm/tree/e7dfa14519f363229ccc3ead7b1b2f2051937efb); [Postgres.js 3.4.9](https://github.com/porsager/postgres/tree/v3.4.9); [PostgreSQL 17 source `ec3f6a6a`](https://github.com/postgres/postgres/tree/ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1); CI image pin [postgres:17.11-bookworm](https://github.com/docker-library/postgres/blob/master/17/bookworm/Dockerfile) as recorded under “PostgreSQL migration integrity” in `docs/OPEN_SOURCE_REUSE.md`
- Existing OpenBot issue, ADR, and reuse-ledger entries checked: `docs/OPEN_SOURCE_REUSE.md` PostgreSQL migration integrity / Postgres.js / Server-owned direct Bot conversations entries; `docs/research/TEMPLATE.md`; native Agent collaboration presentation research; `apps/server/src/postgres-agent-store.ts` context freeze comments

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Compare cutoffs after `Date` / `toISOString()` | ECMA-262 Date; Drizzle 0.45.2 `e7dfa145` timestamp→Date; Postgres.js 3.4.9 | N/A | Existing code path | Loses sub-millisecond timestamptz; flake on PG 17.11 | Reject |
| Widen boundary by +1ms / sleep | n/a | n/a | Flaky | Changes product semantics; forbidden for R3 | Reject |
| SQL column/subquery `timestamptz` compare | PostgreSQL 17 `ec3f6a6a` / runtime 17.11; drizzle-orm 0.45.2 `sql` fragments | PostgreSQL License; Apache-2.0 Drizzle | Keep Drizzle query builder; no new dependency | Preserves microsecond ordering Server-side; fail-closed if RUN_STARTED missing | Select |
| Drizzle `mode: 'string'` schema migration | drizzle-orm 0.45.2 timestamp mode | Apache-2.0 | Broad schema change | Out of R3 file scope | Reject for this slice |

## Reuse decision

- Selected option: local gap on top of existing Drizzle + PostgreSQL stack already pinned in `docs/OPEN_SOURCE_REUSE.md`
- Selected upstream or standard: PostgreSQL 17 timestamptz microsecond storage (`ec3f6a6a` / 17.11); compare cutoffs in SQL without JS Date round-trip; continue Drizzle ORM 0.45.2 + Postgres.js 3.4.9 without adding packages
- Why this is the first viable option: OpenBot already uses Drizzle/Postgres.js; the bug is OpenBot-specific cutoff marshalling, not a missing library
- Exact OpenBot-specific gap: `context`/`initialContext` loaded `RUN_STARTED.created_at` and source `created_at` into JS `Date`, then reused them in `lte` / `toISOString()::timestamptz`, truncating microseconds so a preceding Bot reply in the same millisecond could sort after the truncated start cutoff and drop from history. A regression that only rewrites answer/start to a past calendar day while leaving root/next/later on wall clock stops failing once “today” is after that day, because `answer <= inputBoundary` becomes true through the human-boundary branch.
- Upgrade, replacement, or exit plan: remain on Drizzle `sql` subqueries; a future schema-wide `mode: 'string'` timestamps change is optional and out of scope
- Failure behavior when the upstream is missing, incompatible, or compromised: N/A (database column comparison); missing RUN_STARTED still throws `conflict`

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: n/a
- Required copyright or license notice location: n/a

## Verification plan

- Automated tests: pin the full related timeline on a known axis — `root source < next input < later human < prior-tree Bot answer < RUN_STARTED` — with answer `.123100` and start `.123900` in the same millisecond; assert `PRECEDING_ANSWER_AFTER_QUEUE` is present without sleep/+1ms
- Negative and fail-closed tests: same scenario asserts exclusion of same-millisecond after-start Bot reply and independent later task-tree Bot reply after next’s input; retain delegated root freeze, 12-row window, and explicit reply references elsewhere in the file
- Before/after: temporarily restore the pre-fix `context` body in an isolated worktree and confirm the same fixed test fails; restore the SQL-cutoff implementation and confirm it passes
- Platforms and devices: real disposable PostgreSQL 17.11 loopback (`OPENBOT_COLLAB_TEST_DATABASE_URL`), independent empty database per revision
- User-visible documentation and translations: research EN + zh-CN only for this slice
- Support level that the evidence permits: Server collaboration context ordering on PostgreSQL 17.11 as tested against the pinned Drizzle/Postgres.js ledger versions

## Unresolved questions

- None for this slice.
