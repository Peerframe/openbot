# Research: retained-data migration regression

- Status: Accepted for implementation
- Date: 2026-09-22
- Acceptance: populate a pinned historical migration prefix with synthetic Employee, appearance,
  import receipt, memory, skill and automation rows; upgrade through the production guarded
  migrator concurrently and repeatedly; prove retained values and constraints.
- Boundary: an explicitly supplied empty loopback `openbot_upgrade_test_*` database only. Never
  drop existing schemas or reuse personal configuration. Missing fixtures fail before connection.

## Evidence and candidates

Reviewed the migration-integrity and partial backup/restore entries in `OPEN_SOURCE_REUSE.md`,
`DATABASE.md`, `developer-workflow-refactor.md`, the guarded `packages/db/src/index.ts`, and all
historical SQL. This package is the retained-data part of O1; paired files/keys restore is separate.

GitHub searches: `drizzle-orm postgres migrator 0.45.2 migration hash created_at`, retained data
migration tests, and concurrent migration high-water behavior. Primary documentation searches:
Drizzle migrations and PostgreSQL 17 database creation/backup transaction boundaries.

| Candidate | Pin/license | Evidence and decision |
| --- | --- | --- |
| Existing Drizzle ORM | 0.45.2 / `273c78071d4841b497f5144734b38294df7ec64b`; Apache-2.0 | [Release](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.2), [adapter](https://github.com/drizzle-team/drizzle-orm/blob/273c78071d4841b497f5144734b38294df7ec64b/drizzle-orm/src/postgres-js/migrator.ts), [dialect](https://github.com/drizzle-team/drizzle-orm/blob/273c78071d4841b497f5144734b38294df7ec64b/drizzle-orm/src/pg-core/dialect.ts), [integration tests](https://github.com/drizzle-team/drizzle-orm/blob/273c78071d4841b497f5144734b38294df7ec64b/integration-tests/tests/pg/postgres-js.test.ts) and LICENSE inspected. Select the released migrator for the old prefix and OpenBot's existing guarded migrator for upgrade. No second migration engine. |
| Existing PostgreSQL/Postgres.js | PostgreSQL 17.11; PostgreSQL License. Postgres.js 3.4.9; Unlicense | Use real PostgreSQL through the existing driver. SQL constraints, transaction rollback and advisory locks need a real database. No embedded substitute or production dependency is justified. |
| Native archive restore | PostgreSQL 17 [SQL dump](https://www.postgresql.org/docs/17/backup-dump.html) and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) | Correct choice for future paired recovery, but a database archive cannot assert OpenBot's old-row semantics or cover external encrypted files by itself. Deferred to the next O1 package. |

[Issue #5769](https://github.com/drizzle-team/drizzle-orm/issues/5769) describes pending migrations
skipped by a high-water timestamp. The pinned dialect confirms timestamp-based selection; this is
why the production exact-prefix guard must be exercised and never bypassed for the final upgrade.
[Current Drizzle documentation](https://orm.drizzle.team/docs/migrations) also covers newer formats;
the test deliberately uses the installed 0.45.2 journal and its exact hashes.

## Reuse decision

Use upstream migration parsing/application and PostgreSQL constraints first. The local gap is a
repository-owned synthetic historical fixture, immutable prefix identity, preserved-column
comparison, required environment mapping and negative probes. No upstream source is copied or
substantially adapted; no dependency or production schema/API change is planned. Existing license
notices remain unchanged. Additive future migrations must pass this same fixture; do not update old
hashes to make a changed historical migration pass.

## Verification

- Offline tests reject absent/corrupt fixtures, changed journal/hash, unsafe targets and an invalid
  fixture override. Database checks are required when explicitly invoked; never silently skipped.
- A real empty PostgreSQL database is populated at migration `0018_automations`, then upgraded by
  two independent production migrators and restarted repeatedly.
- Compare every pre-existing column of every fixture row, including timestamps/JSON. Verify
  fail-closed new memory/skill defaults, old uniqueness/FK/check constraints, and the added
  automation outcome with a rolled-back transaction.
- Fail a deliberately drifted history without mutations, restore it, and verify a complete history.
  An older-prefix build must refuse an ahead database; reverting application behavior keeps the
  current migration history. This is not a claim that an arbitrary old binary can run on new data.
- Wire an explicit separate database in CI and document the command in English and Chinese.

## Remaining work

Paired database/files/keys restore, OS-specific application upgrade and release ownership are not
established by this database-only synthetic regression.
