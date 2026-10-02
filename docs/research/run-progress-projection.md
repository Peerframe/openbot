# Persisted run progress projection (C13)

- Status: Accepted for implementation
- Date: 2026-10-02
- Trigger: additive public Owner read contract; no new dependency, writer, migration or authority.

Reuse the PostgreSQL17 source pin `ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1`
(PostgreSQL License), psycopg3.3.6 (LGPL-3.0), existing workspace repeatable-read transaction
and Server-bound runtime progress in [runtime ports](runtime-execution-ports.md).
Targeted searches: GitHub postgres/postgres REL_17_STABLE window.sql row_number; PostgreSQL17
window functions count FILTER and row_number before filtering. Reviewed official
[window functions](https://www.postgresql.org/docs/17/functions-window.html),
[table expressions](https://www.postgresql.org/docs/17/queries-table-expressions.html), and
[window regression source](https://github.com/postgres/postgres/blob/ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1/src/test/regress/sql/window.sql).

| Candidate | Fit / total cost | Decision |
| --- | --- | --- |
| PostgreSQL aggregate/window query over existing events | Exact full-run count and stable ordinal selection; existing snapshot/locks/test fixture | Selected thin read projection |
| Client count over latest 200 events | Loses early steps and undercounts busy/long histories | Rejected |
| New progress ledger or inferred model plan | Second writer/history, migration and unsupported future totals | Rejected |

Current product steps reuse Work actions and their admitted/resolved events, including verified
applied counts. Historical unmapped Run steps use public progress checkpoints. Neither is a model
thought or an inferred plan. The relation excludes all action/request/receipt bodies. The existing dynamic runtime has no promised future plan or per-checkpoint finish facts:
return explicit nulls. Never read free-form event messages; allowlist phase names and use fixed
descriptions. Latest status comes from runs_work_projection, so approval waits and terminal
failures supersede stale progress text. Actual lifecycle events supply run timestamps.
A single repeatable-read Owner transaction prevents counts/indices from crossing commits.
Only SQL integers, bounded stage fragments and selected fixed-size checkpoints cross the driver;
existing statement deadline bounds scans. No third-party source copied or substantially adapted.
