# Research: Paired database, objects and keys restore acceptance

- Status: Accepted for the synthetic Server directory-mode drill
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Acceptance journey: create retained rows, report and attachment bytes, encrypted model settings
  and plugin state; stop all fixture writers; export with native PostgreSQL tools; restore into a
  new database and private file tree; read through production Server adapters and Owner routes.
- Security boundary: only a newly owned, labelled Docker fixture and synthetic temporary files.
  No user-supplied archive, database URL, source directory, provider credential or live service.
  No schedulers, Workers or inference runners are started. All model metadata calls are synthetic.

## Search evidence

Search date: 2026-09-22. Queries included `site.github.com/postgres/postgres REL_17_11 pg_dump
002_pg_dump.pl`, `site.postgresql.org docs 17 pg_dump pg_restore single-transaction backup sql dump`,
`site.postgresql.org message-id pg_restore single-transaction 2026`, and the pgBackRest open issue
list filtered for restore. Checked the existing backup/restore Partial entry in
`OPEN_SOURCE_REUSE.md`, `DATABASE.md`, retained-data-upgrade research, production file stores and
the owned Docker fixture in `smoke-dev-fixture.mjs` at OpenBot `86223c6`.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL native tools | 17.11 / `083ac033419f690758508e08c1736089384bbee8` | PostgreSQL License | [Release](https://www.postgresql.org/docs/17/release-17-11.html), [custom archive tests](https://github.com/postgres/postgres/blob/083ac033419f690758508e08c1736089384bbee8/src/bin/pg_dump/t/002_pg_dump.pl), [archiver source](https://github.com/postgres/postgres/blob/083ac033419f690758508e08c1736089384bbee8/src/bin/pg_dump/pg_backup_archiver.c), [license](https://github.com/postgres/postgres/blob/083ac033419f690758508e08c1736089384bbee8/COPYRIGHT). PostgreSQL uses its bug mailing lists, not GitHub issues; the scoped search did not establish a new blocking defect. | Reuse the already pinned PostgreSQL 17.11 container, custom-format dump and single-transaction restore. Does not capture files outside PostgreSQL. | Selected first viable released implementation. |
| pgBackRest | 2.59.1 / `8c8f3ee63e310f0b3ea10b55ed3b96b4cc9296da` | MIT | [Release](https://github.com/pgbackrest/pgbackrest/releases/tag/release/2.59.1), [restore source](https://github.com/pgbackrest/pgbackrest/blob/8c8f3ee63e310f0b3ea10b55ed3b96b4cc9296da/src/command/restore/restore.c), [restore tests](https://github.com/pgbackrest/pgbackrest/blob/8c8f3ee63e310f0b3ea10b55ed3b96b4cc9296da/test/src/module/command/restoreTest.c), [license](https://github.com/pgbackrest/pgbackrest/blob/8c8f3ee63e310f0b3ea10b55ed3b96b4cc9296da/LICENSE). Reviewed open reports [#2844](https://github.com/pgbackrest/pgbackrest/issues/2844) (standby after PITR) and [#2835](https://github.com/pgbackrest/pgbackrest/issues/2835) (SFTP archive check failure); neither is independent evidence that every deployment is affected. | Maintained physical cluster/WAL backup system with remote repository lifecycle. Its restore manifest describes PostgreSQL data; it does not bind OpenBot object/model/plugin directories. | Defer for operational PITR/off-host work; it does not remove this application-level drill gap. |

## Reuse decision

Reuse `pg_dump --format=custom` and `pg_restore --single-transaction --exit-on-error --no-owner
--no-privileges` as subprocesses inside the owned fixture. [PostgreSQL's dump
documentation](https://www.postgresql.org/docs/17/app-pgdump.html) describes a consistent database
snapshot, but only for one database. [Restore documentation](https://www.postgresql.org/docs/17/app-pgrestore.html)
defines transactional restore and error handling. Source inspection confirms the transaction is
opened before restore objects and failures exit rather than committing a partial transaction.

The OpenBot-specific gap is the pairing of separately stored bytes and keys with authoritative
database rows, and proving those relationships through the actual application readers. A bounded
test-only manifest records relative paths, sizes and SHA-256 digests; it is not an authentication
format, backup product or replacement for archive encryption. Reject missing/extra/changed files,
links and a pre-existing destination. Never extract an arbitrary archive or run arbitrary dumped
SQL supplied by a user: PostgreSQL restore can execute code from its source database.

Reuse the existing owned Docker lifecycle and pinned image digest
`sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
Only add native dump/restore operations for this container and newly created fixture databases.
Docker/image/tool failure is a required failure, never a skip. No new dependency is needed.

## Source incorporation

No upstream source copied or substantially adapted. Existing npm dependencies and PostgreSQL
executables retain their own license notices. The test fixture composition is OpenBot-specific.

## Verification plan

- Real native custom archive restored into a different empty database; compare retained business
  rows and migration history, then run the production migration guard again.
- Read a report and an attachment through authenticated production routes; verify attachment
  derived text and model/plugin ciphertext using fresh store instances with restored keys.
- Verify unauthenticated reads fail and no outbound model/plugin/Worker work starts.
- Deliberately omit keys, substitute the wrong keys, corrupt same-length bytes, omit files, add
  files and truncate the database archive. Each must fail its integrity/decryption/restore gate.
- Run offline manifest boundary tests plus the required Docker drill; inspect final cleanup.
- Update English/Chinese database guidance. Evidence covers this POSIX synthetic Server profile,
  not Desktop OS-bound secrets, legacy external-key mode, optional publisher keyrings, full host
  configuration, arbitrary old backups, PITR, power-loss durability or production RTO/RPO.

## Unresolved questions

Backup scheduling, encryption, off-host storage, retention/pruning, optional publisher and Desktop
recovery profiles require their own reviewed implementation and acceptance. Application writers
are quiesced for this drill; no cross-store live snapshot protocol is introduced.

## Integration evidence and reviewed corrections — 2026-09-23

The real drill passed on the pinned image: 25 tables, eight paired files and 27 migrations.
Independent review caught the historical upgrade fixture's metadata-only artifact; this drill now
replaces that stub before capture and downloads every fixture artifact through Owner routes.
Five offline boundary tests and ten shared fixture/lifecycle tests passed. Real SIGTERM injection
after ciphertext creation and during a `pg_sleep(120)` SQL wait both exited nonzero with no owned
container or private tree remaining. On abort, one shared cleanup promise stops only the owned
container (including the migration adapter's separate connection) and closes fixture pools.

A first interrupt attempt exposed PostgreSQL startup error `57P03`. The image's temporary
initialization server accepts Unix sockets before final startup. Reviewed the actual
`/usr/local/bin/docker-entrypoint.sh` from the pinned image (SHA-256
`9c440299ae04a0a79d55b8bf03307036d890a40979d2fb698073c9050d4b20a5`) and the
[official entrypoint source](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh):
`docker_temp_server_start` explicitly sets empty `listen_addresses`. The shared fixture now checks
`pg_isready -h 127.0.0.1`, waiting for the final TCP service. The source in the fixed image, rather
than the moving discovery link, is the reviewed implementation. No entrypoint code is copied.

The manifest is private test evidence, not a signed recovery format. The interrupt tests do not
establish cleanup after SIGKILL, host failure or an unavailable Docker daemon; those conditions
cannot run the driver's cleanup handler. No production data or external provider was used.

After S1a integration the fixture also retains an approved `outcome_unknown` MCP receipt and
compares the complete decrypted plugin state after restore. Shared native Docker tool invocations
use `SIGKILL` for their command deadline/abort, so an unresponsive local CLI cannot ignore a graceful
timeout indefinitely; fixture ownership checks and final cleanup still govern the remote container.
