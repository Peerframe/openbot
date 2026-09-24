# S7 synthetic migration qualification

[English](README.md) · [简体中文](README.zh-CN.md)

This experiment qualifies a minimal retained-data path for two historical SQL lineages. It is
preparation for S7, not a production migration utility or evidence that S7 is complete.

| History | Immutable source | Expected path |
| --- | --- | --- |
| Architecture, 27 migrations | `c33e03f1a14de739196113769c59fdaace9029e7` | Restore old data, then apply current migrations with the existing production startup guard. |
| Feature, 19 migrations | `9cc73c9e78451e572f57d142d6b9caf62ccb78e2` | Direct upgrade fails at index 17. A separate fixture-only transfer copies a bounded compatible record set into a freshly migrated target. |
| Qualified target, 34 migrations | `d2b3372dc4b5071276ba83a04c55136e58365c5a` | SQL bytes and journal must match `target-history.json`; changes require an explicit requalification. |

The two old histories share migrations 0000–0016. `histories/common` contains those original bytes;
`histories/feature` and `histories/architecture` contain their different suffixes. The history JSON
files record every SQL hash and timestamp. These snapshots were extracted from the commits above,
without rewriting SQL. `sources.mjs` verifies them, reproduces the existing
[`migration-lineage-baseline.json`](../../docs/migration-lineage-baseline.json), and verifies the
current target. A shallow fresh checkout is sufficient; historical Git objects are not required.

Each `fixtures/<history>/seed.json` is synthetic and contains one Bot, one channel, membership,
two linked messages, one completed legacy Run and one Markdown Artifact. Fixed UUIDs, timestamps,
file bytes, digests and profile revisions make preservation observable. The architecture fixture
also retains a direct-Bot channel. There are no provider credentials, active tasks or private data.

## Run from a fresh checkout

Prerequisites: the repository's supported Node/npm versions and a running Docker Engine that can
pull the pinned multi-platform PostgreSQL 17.11 image. No model account or existing database is
needed. Missing prerequisites fail the command; the database checks never silently skip.

```bash
npm ci
node experiments/s7-migration/sources.mjs
npm exec -- turbo run build --filter=@openbot/server
node --test experiments/s7-migration/cleanup.test.mjs
node experiments/s7-migration/qualify.mjs --report /tmp/s7-migration-summary.json
npm run check
```

The runner creates its own `openbot-s7-<UUID>` container with a temporary PostgreSQL data volume,
a loopback-only random port and fixture-only authentication. It accepts no database URL, source
directory or input archive. Every database and file is generated inside this invocation. Cleanup
closes clients, removes the owned container and deletes temporary files even after a normal error.
If the process is forcibly killed, remove only the container bearing that invocation's name and
`openbot.fixture=s7` label. Never remove unrelated containers or volumes.

The dedicated [CI workflow](../../.github/workflows/s7-migration.yml) runs the same command on
Ubuntu and uploads only the JSON summary. Dumps, object files and SQL row contents are temporary.
The checked-in `evidence/local-result.json` records the actual local run, not a hosted CI result.

## Backup and restore drill

The experiment has no Server or Worker, so there are no concurrent application writes. For each
history it performs these steps, then repeats them after migration/transfer:

1. Capture the full fixture database with PostgreSQL 17.11 `pg_dump --format=custom --no-owner
   --no-privileges`; retain the original Drizzle history inside that archive.
2. Copy the paired synthetic object directory while writes remain stopped. Record the dump hash,
   deterministic database snapshot hash and file hashes in the temporary recovery set.
3. Create a new database from `template0`. Reject a nonempty restore target or changed manifest/
   archive. Run `pg_restore --single-transaction --exit-on-error --no-owner --no-privileges`.
4. Copy the paired files to a new directory. Compare every database row and history row, check
   references, and read artifacts through the real `FileArtifactStorage` reader. Verify SHA-256
   and size against restored database metadata.
5. For a current-schema recovery, run guarded startup again and verify that identities and data
   remain unchanged. Remove the disposable environment only after the assertions finish.

Native restore into a deliberately conflicting disposable schema must fail and roll back every
new object. Missing artifacts and same-length byte corruption must also fail verification.
An archive catalog listing alone is never counted as a restore.

## Feature-history transfer boundary

The direct-upgrade failure is required evidence. The experiment does not overwrite the source
ledger or label its conflicting SQL as applied target migrations. The new target gets its own
ledger by running the current guarded migrator against an empty database.

The fixture transfer allows only `bots`, `channels`, `channel_bots`, `messages`, `runs` and
`artifacts`, at most four rows per table. Any other nonempty table, unknown source column,
model connection, model Run (including a null model selection), active Run or Worker reference
fails. It validates references before inserting all rows in one target transaction, rejects a
second transfer into the populated target, and compares source snapshots to prove retention.
This small allowlist is an experimental compatibility boundary, not a schema export format.

The legacy task IDs and file references are preserved in `runs` and `artifacts`. Migration 0027
explicitly leaves legacy records unclassified, so the checks require `work_tasks`, `work_runs`
and `work_artifacts` to stay empty. Mapping old tasks into the new work domain is still an
integration decision.

## Evidence and remaining gates

The summary records source/target commits, migration digests, runtime versions and individual
passing cases. Source-history failures cover hash, timestamp, missing-row and ahead-of-build
drift against a real PostgreSQL database, with unchanged-state assertions. Import failures cover
unmapped records, unsupported work and a message reference that SQL alone does not constrain.

This fixture does not cover complete user data, attachments, model ciphertext/keys, plugin state,
publisher keys, auth/audit recovery, active-task recovery, Temporal backup pairing, Desktop OS
secret storage, all platforms, live providers or a complete product journey. Those remain S7
integration gates. See the [research and decision record](../../docs/research/s7-migration-qualification.md)
and the broader [database recovery inventory](../../docs/DATABASE.md).

The additive model-receipt target was requalified on2026-09-24. See
[evidence](evidence/model-receipts-result.json); historical SQL/source fixtures remain unchanged.
