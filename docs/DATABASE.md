# Database operations

[English](DATABASE.md) · [简体中文](DATABASE.zh-CN.md)

OpenBot keeps channels, employees, Runs, approvals, audit records, sessions, and artifact metadata
in PostgreSQL. Object bytes, plugin state and encrypted model settings live outside the database.
A usable recovery set includes the database and the persistent files and keys listed below.

Migration `0015_employee_memory_lifecycle.sql` adds optimistic revisions to Employee memories and
a content-free lifecycle audit. Deleting a memory removes its title and content row while the audit
retains only the Employee id, memory id, action, revision, changed field names, actor, and time.
Backups therefore contain private memory text and must receive the same protection as credentials.

Migration `0017_request_throttle_buckets.sql` adds short-lived pseudonymous login and Node
enrollment abuse-control buckets. It stores a scope, a domain-separated client-address digest,
bounded counters, and timestamps—not a raw IP, password, enrollment token, or Node credential.

## Migration contract

- Never edit an applied migration. Add a new numbered SQL file and journal entry.
- `npm run migrations:check` verifies the repository journal and SQL file set.
- Server startup takes a PostgreSQL advisory lock, checks that database history is an exact prefix
  of the repository, applies pending Drizzle migrations, and verifies the complete result.
- Hash, timestamp, missing-entry, or ahead-of-build drift stops startup. Do not repair the Drizzle
  table by hand to bypass the check.
- `npm run db:verify` intentionally runs only against a database whose name ends in `_test`. It
  exercises concurrent and repeated migration startup.

For important data, investigate drift against the deployed release and restore a verified backup.
For a disposable local database, recreate it only after confirming that no data is needed.

## Author a migration

OpenBot uses reviewed, hand-written SQL and an append-only journal. Automatic
`npm run generate --workspace @openbot/db` fails with guidance: the retained historical snapshot
is not a baseline for schema-diff generation. Do not call Drizzle generate/push/up to repair it.

From the repository root, print a read-only plan:

```bash
npm run migration:plan --workspace @openbot/db -- --name describe_change
```

The command validates the existing manifest and prints a proposed filename, comment-only SQL
template and journal entry. It does not write files, inspect a database, or infer DDL. Without
arguments (or with `--help`) it prints usage.

1. Rebase onto the current target branch before planning. The next unique four-digit prefix must
   equal the new journal entry's zero-based `idx`; the helper calculates both from current history.
2. Author the required SQL at the proposed path. Review existing-data handling, constraints,
   transaction/locking behavior and recovery; use `--> statement-breakpoint` between statements.
   Update `packages/db/src/schema.ts` to describe the resulting structure. Keep SQL-only constraints.
3. Append the printed entry to `migrations/meta/_journal.json`. Its `when` is
   `max(current time in milliseconds, previous when + 1)`, including when historical entries are
   ahead of the clock. Never renumber, retimestamp or edit already-applied entries/SQL/snapshots.
4. Run `npm run migrations:check`. If another migration merges first, rebase and recalculate your
   unpublished filename/entry together. The printed number is a preview, not a reservation.
5. Verify the change in disposable PostgreSQL databases both from empty history and from the
   previous release, including repeat startup and application-specific constraints. Use the
   Server's guarded `createDatabase(...).migrate()` path; direct Drizzle CLI migration does not add
   OpenBot's history checks. Finish with `npm run check`.

Manifest checks validate numbering/file correspondence and monotonic time, not SQL correctness.
The Server still verifies hashes and exact applied prefixes before and after migration.

## Backup boundary

Quiesce Server writes before capturing a complete recovery set. PostgreSQL `pg_dump` gives a
consistent database snapshot, but it cannot coordinate with artifact files being written in a
different volume. Inventory actual configured paths before stopping the service:

| Asset | Location and required contents |
| --- | --- |
| PostgreSQL | Logical dump of the configured database; preserve the matching PostgreSQL major version and OpenBot build identity |
| Objects and plugins | Entire `OPENBOT_OBJECT_STORE_PATH`, including reports, attachment bytes/metadata/derived text and `plugins/state.json` |
| Model directory mode | Entire `OPENBOT_MODEL_DIRECTORY`, including `encryption.key` and `settings.json`; losing the key makes retained ciphertext unreadable |
| Legacy model mode | `OPENBOT_MODEL_SETTINGS_PATH` and its exact `OPENBOT_MODEL_ENCRYPTION_KEY` from the protected service configuration; do not put the key in a public manifest |
| Optional Employee publisher | Entire `OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH` plus the separately configured `OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE`, when enabled |
| Service configuration | Protected configuration needed to reconnect, including Owner/database credentials and any configured external keys; preserve restrictive access and restoration instructions |

Source dev commands run inside their workspaces: the example `./data/objects` and `./data/model`
resolve under `apps/server`. Compose uses its named object/model volumes; see
[persistent container model settings](SERVER_CONTAINER.md#persistent-model-settings). Use actual
absolute paths when operating outside those entry points.

Desktop-managed local Server uses a different layout under the Electron user-data directory at
`openbot/local-server`: `postgres`, `objects`, `model-settings.json` and the OS-encrypted
`bootstrap.json` that contains its model/database/Owner keys. Preserve the complete stopped data
root and the original OS account's secret-storage access. Copying `bootstrap.json` alone does not
make it decryptable on another machine/account; this runbook does not establish cross-host Desktop
credential recovery. Remote Desktop clients do not contain the remote Server's recovery assets.

1. Stop the OpenBot Server while leaving PostgreSQL running.
2. Create a PostgreSQL custom-format archive with `pg_dump --format=custom --no-owner
   --no-privileges`.
3. Snapshot all applicable persistent files and secrets from the inventory while Server remains
   stopped. Preserve permissions and bind the model ciphertext to its original key.
4. Record the OpenBot release, PostgreSQL major version, migration count, asset inventory,
   checksums and capture time. The manifest names assets; it must not contain secret values.
5. Encrypt the recovery set and copy it off the Server host. Never commit it to Git.
6. Restart Server and confirm health.

`pg_restore --list backup.dump` proves that PostgreSQL can read the archive catalog. It does not
prove that the backup is restorable or that paired files, settings and keys are complete.

## Restore drill

Restore rehearsals must use an isolated database and persistent-file copies, never live targets.
Keep Worker Hosts disconnected and block outbound model/plugin/provider requests in the rehearsal
environment: restored settings and schedules may be enabled. A restore check requires no paid calls.

1. Create an empty database whose name ends in `_test`.
2. Restore with `pg_restore --single-transaction --exit-on-error --no-owner --no-privileges`.
3. Restore all applicable objects, model settings/key and optional publisher/configuration copies
   into new private paths. Point a non-production OpenBot build only at those paths and the restored
   database. Verify retained model settings can be decrypted before starting normal work.
4. Run `npm run db:verify`, then inspect representative channels, employees, Runs, approvals, audit
   entries, downloaded artifacts, attachment integrity and retained plugin/model settings. A model
   settings read must not issue inference; separately decide whether any configured connection may
   resume after recovery.
5. Record the duration and result before deleting the isolated environment.

For production recovery, restore into a new empty database and persistent-file directories, verify it, then
switch the deployment. Do not restore over a running OpenBot database.

## Reverting application changes

An applied migration remains part of the build's migration history even when application behavior
is reverted. Keep the additive `0026_automation_attachment_outcome` SQL and journal entry when
reverting the task-flow refactor; its expanded CHECK accepts all previous outcome values. The
migration is a separate prerequisite commit so the task behavior can be reverted independently.
Do not delete applied migration rows or amend historical SQL to force an older build to start.
The startup guard intentionally rejects a database ahead of the build. If a later schema reversal
is necessary, use a reviewed forward migration with an explicit existing-data policy.

## Current limits

- OpenBot does not yet schedule, encrypt, upload, retain, or prune backups.
- There is no point-in-time recovery or WAL archiving workflow.
- The local object store has no transactional snapshot protocol with PostgreSQL.
- Backup credentials and storage-provider integrations are intentionally not part of Employee
  packages or Worker Hosts.

These gaps remain M6 work. Contributions should start with an upstream review and prove a complete
database-plus-files-and-keys restore, not only successful archive creation.
