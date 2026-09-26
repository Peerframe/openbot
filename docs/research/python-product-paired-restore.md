# Completed product paired restoration qualification

2026-09-25. This is a synthetic acceptance probe, not a backup product or migration engine.
Reuse the repository's `docs/research/s7-migration-qualification.md` review of PostgreSQL
17.11 (`REL_17_11`, PostgreSQL License), native dump/restore source and TAP tests, and
`docs/OPEN_SOURCE_REUSE.md`'s PostgreSQL boundary. The reviewed existing image is
`postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
No dependency or upstream source is added. The existing S7 probe is inspected and its native
command options are reused; application persistence is read using the actual Python modules.

Rechecked primary contracts before implementation:
- [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html): custom archive,
  one database, executable trusted SQL on restore; external files and cluster roles are outside it.
- [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html): restore
  only our generated archive into our randomly named empty destination in one transaction.
- [SQL dump](https://www.postgresql.org/docs/17/backup-dump.html): successful restore alone
  does not verify application references or coordinate external directories.

The first viable option is the already pinned native tool plus a thin test driver. Stop the
actual product API/Worker after completed Task and original-history replay, then pair the SQL
archive with private artifacts, attachments, settings/key and plugin state/key directories.
Compare every public/drizzle table's complete ordered row representation, sequence state,
and every paired file hash/mode. Then exercise Task/Owner authentication, LocalWorkFiles,
OwnerFiles, ModelSettingsService and FilePluginStore on the restored copies. A disabled,
fixture-only plugin with a synthetic token and audit entry supplies nonempty encrypted data;
it is never installed through a fake network effect or executed. Missing/wrong key copies
must fail closed. No active Temporal database recovery, real-provider access, OS keychain,
global role/ACL restoration, cross-version migration or general import support is claimed.
