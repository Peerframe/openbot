# Research: S7 synthetic migration and restore qualification

- Status: Accepted for an isolated qualification experiment; production migration remains open.
- Date: 2026-09-24
- Owner: OpenBot maintainers
- Acceptance journey: reconstruct both committed SQL histories with minimal synthetic identity,
  task and file records, qualify their permitted path to the current schema, reject incompatible
  history, and restore paired database/file backups into empty disposable destinations.
- Security boundary: no existing database URL, private runtime directory, credentials, provider,
  Server or Worker is used. The runner owns an ephemeral PostgreSQL container and temporary files.
  It never repairs an applied journal or changes production schema/default selection.

## Search evidence

- Search date: 2026-09-24.
- GitHub queries: `postgres pg_dump pg_restore tests REL_17_11`,
  `drizzle readMigrationFiles hash journal postgres`, `pgloader PostgreSQL source releases`.
- Primary documentation: PostgreSQL 17 SQL dumps, pg_dump and pg_restore; PostgreSQL 17.11 release
  notes and pgsql-bugs archive; Drizzle PostgreSQL migrator source and migration discussions.
- Existing evidence: `docs/OPEN_SOURCE_REUSE.md` PostgreSQL migration integrity (reviewed),
  PostgreSQL/artifact backup (partial), `docs/DATABASE.md`, ADR-0022, and
  `docs/research/migration-lineage-audit.md`.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance, tests and boundary | Decision |
| --- | --- | --- | --- | --- |
| PostgreSQL native dump/restore | PostgreSQL 17.11, tag `REL_17_11`; existing `postgres:17.11-bookworm` image | PostgreSQL License; image MIT and bundled component notices | Reviewed [release](https://www.postgresql.org/docs/release/17.11/), [restore source](https://raw.githubusercontent.com/postgres/postgres/REL_17_11/src/bin/pg_dump/pg_restore.c), [license](https://github.com/postgres/postgres/blob/REL_17_11/COPYRIGHT), [bug archive](https://www.postgresql.org/list/pgsql-bugs/), [dump contract](https://www.postgresql.org/docs/17/app-pgdump.html), and [restore contract](https://www.postgresql.org/docs/17/app-pgrestore.html). Reviewed the pinned [TAP dump tests](https://raw.githubusercontent.com/postgres/postgres/REL_17_11/src/bin/pg_dump/t/002_pg_dump.pl), including custom-format compression/catalog cases and their explicit independent-database restore gap; the browser fetch failed initially, so the exact source was fetched directly before handoff. Upstream TAP tests were inspected, not run; this experiment exercises actual independent database restores. A database snapshot does not include external files. Restored SQL is executable, so only this runner's own synthetic archives are accepted. | First viable native standard tools; custom archive, empty destination, one restore transaction. |
| Existing Drizzle migration lifecycle | drizzle-orm 0.45.2 / `e7dfa14519f363229ccc3ead7b1b2f2051937efb`; Postgres.js 3.4.9; OpenBot `e176e90a9de3854f0bf745773b7996e7bd572c83` | Apache-2.0; Unlicense; MIT | Reviewed [dialect source](https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/drizzle-orm/src/pg-core/dialect.ts), local `packages/db/src/index.ts` and `index.test.ts`, the source-lineage test suite, and [migration status discussion](https://github.com/drizzle-team/drizzle-orm/discussions/5685). Timestamp high-water alone cannot distinguish the two histories. Existing exact-prefix guard is authoritative; historical bootstrap uses the dependency against a newly created empty fixture database only. | Reuse migration engine and guard; no replacement engine or history rewrite. |
| pgloader | v3.6.9 | PostgreSQL License | Reviewed [release tree](https://github.com/dimitri/pgloader/tree/v3.6.9), [releases](https://github.com/dimitri/pgloader/releases), source/test inventory, [issues](https://github.com/dimitri/pgloader/issues), and [license](https://github.com/dimitri/pgloader/blob/main/LICENSE). Upstream recommends native tools for PostgreSQL-to-PostgreSQL transfer. It does not supply OpenBot's semantic mapping or external-file pairing. | No dependency added; native tools already cover backup/restore. |

## Reuse decision

Use native PostgreSQL backup/restore plus the installed Drizzle/Postgres.js dependencies and
OpenBot's existing committed-history reader and runtime guard. The experiment-specific gap is
reconstructing the two immutable OpenBot histories, seeding linked synthetic records, checking
their preservation, and binding external bytes to restored metadata. The partial backup review
is completed only for this stopped, synthetic, single-host drill. Scheduling, encryption,
retention, off-host recovery, production settings/key recovery and product activation remain open.

The baseline records 17 identical migrations, then two conflicting timestamp/hash pairs:

| Source | Commit | Entries | Permitted qualification path |
| --- | --- | --- | --- |
| Architecture history | `c33e03f1a14de739196113769c59fdaace9029e7` | 27 | Restore and run the current guarded additive migrations; assert retained legacy records and references. |
| Feature history | `9cc73c9e78451e572f57d142d6b9caf62ccb78e2` | 19 | Direct startup must fail at index 17. A fixture-only, bounded transfer of compatible rows to a fresh target may demonstrate preservation; the original history stays with the source backup. |

The feature transfer is deliberately incomplete. Only explicitly covered tables/columns and
non-model completed legacy Runs qualify. Unknown nonempty tables or unsupported non-null columns
must fail before target inserts. Model connections, model-selection ciphertext, active work,
other runtime assets and converting legacy Runs to new `work_tasks` require separate decisions.
An empty `work_tasks` table after migration is expected: migration 0027 explicitly does not
reclassify old records. This experiment cannot establish a general feature-history upgrade.

## Source incorporation

No external upstream source is copied or substantially adapted. Original MIT OpenBot SQL bytes
from the two pinned commits are copied under `experiments/s7-migration/histories`, with a shared
0000–0016 prefix and exact per-file hashes. The runner calls PostgreSQL tools and imports existing
OpenBot helpers and dependencies. The snapshots remove any runtime dependency on old Git objects.
No new dependency, production schema, journal, Server or Runtime code is added.

## Verification plan

- Two minimal fixture descriptions with stable IDs, fixed timestamps and synthetic file bytes.
- Exact baseline re-comparison and matching committed SQL SHA-256 before historical bootstrap.
- Real PostgreSQL: guarded prefix upgrade, divergent-history rejection without mutation, bounded
  feature transfer, repeat startup, row/reference equality and independently hashed file reads.
- Native custom-format dump and full restore to empty databases, plus paired file copies.
- Negative cases: changed/missing/ahead migration history, unsupported feature data, broken file
  content or missing files, and restore failure without partial application.
- Dedicated CI job with a disposable pinned PostgreSQL container and a fresh checkout; no skips
  when prerequisites are missing. Record sanitized JSON evidence and run `npm run check`.
- Bilingual experiment runbook; support claims limited to the actual recorded execution.

## Results and integration dependencies

The actual local run on 2026-09-24 passed **40 cases** on a macOS arm64 host with Node v22.23.2
and Docker's Linux arm64 PostgreSQL 17.11 / Debian 17.11-1.pgdg12+2. The OCI image is pinned to
`sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`, already selected by
the Temporal deployment profile. See the [machine-readable result](../../experiments/s7-migration/evidence/local-result.json)
and [bilingual runbook](../../experiments/s7-migration/README.md).

- Architecture: real guarded 27-to-33 migration; legacy identity, message, task and artifact
  values/references retained; old and target database/file backups restored.
- Feature: direct migration rejected at index 17 without changes; the six-table synthetic transfer
  preserved original IDs/content/files in a fresh 33-migration target and left the source unchanged.
- Failures: hash/timestamp/missing/ahead ledger drift; unknown tables in public, another schema and
  the ledger schema; unknown column; model configuration and model/active Runs; orphan message;
  duplicate import; late insert rollback; damaged dump, nonempty restore destination, missing or
  same-size corrupted artifact, and native restore DDL rollback.
- Source verification: the sealed snapshots reproduce the committed baseline; an independent
  read-only review also compared all three manifests with their full Git commit objects.
- `npm run check` exited 0. Existing unchanged workspace typecheck/test/build results were reused
  from Turbo's shared worktree cache; new S7 cases ran against real disposable PostgreSQL.
  Focused source/lint/docs checks were rerun for the final experimental changes.
- The dedicated GitHub Actions workflow is prepared. Hosted Ubuntu CI has not been dispatched or
  observed in this task; the local result must not be presented as a hosted CI pass.

The first database runs exposed Drizzle 0.45.2's mutation of Postgres.js JSON serializers and the
Docker image's temporary socket-only bootstrap server. The adapter now binds JSON as text before
casting and waits for the final TCP server. These were fixture issues; no product code changed.
A separate review found that a public-only table inventory could overlook another schema; the
final runner rejects those tables and includes both external-schema and extra-ledger-table cases.

This preparation does not complete S7. A production transfer contract, model configuration/key
policy, legacy Task identity mapping,
full asset inventory, product journey, target CI execution and live-provider evaluation remain
integration dependencies. No real user-data migration, retirement, publication or default switch
is authorized by this experiment.


## Independent integration acceptance (2026-09-24)

Codex checked all three manifests against their immutable Git commits, including
SQL bytes, journal order and timestamps. The migration clone lacks the feature
commit's tree, so the failed lookup there was resolved by reading the original
shared repository object store. All 27 architecture, 19 feature and 33 target
entries match. Current mainline has no SQL changes beyond the pinned target.

Review of `ea75b92` found that a lost `docker run` response could leave an owned
container behind because cleanup required a successful CLI return. The original
implementer fixed only that boundary in `36ddc5d`: discovery uses this invocation's
UUID name and fixture label, inspection rechecks name/label/full immutable ID, and
removal uses that ID. Ambiguous or failed inspection refuses deletion; there is
no second create/run. Eight real-entrypoint tests use a simulated Docker CLI,
not a real daemon timeout. The final candidate was independently exercised:

- `node --test experiments/s7-migration/cleanup.test.mjs`: eight actual passes,
  no skips. Log: `/private/tmp/openbot-s7-cleanup-independent-20260924.log`.
- `node experiments/s7-migration/qualify.mjs --report
  /private/tmp/openbot-s7-independent-result-20260924.json`: 40 actual passes on
  Node 26.0.0 / macOS arm64 with digest-pinned PostgreSQL 17.11, including real
  `pg_dump`/`pg_restore` and paired file reads. Log:
  `/private/tmp/openbot-s7-independent-20260924.log`. Owned resources were cleaned
  and the process exited 0.

The candidate code was integrated unchanged; the independent evidence above is
reused because only documentation and CI wiring then changed. The dedicated CI
now runs the cleanup tests before the database qualification. Hosted CI has not
run. Acceptance is only for these synthetic histories and the bounded transfer;
it does not qualify full product migration, legacy-Run conversion, active work,
credentials, model configuration, Temporal pairing, default switching or release.


## Uncommitted correction-target requalification (2026-09-24)

The existing bounded qualification was rerun against the finalized working-tree target with
35 migrations, including additive `0034_work_corrections`. The parent is
`135df6d4a67ed7903673f3aa23b9e5c6ab75da26`; the new SQL and journal entry were **uncommitted**
at qualification time. Neither `target-history.json.commit` nor the existing runner's
`histories.target.commit` means that these target bytes are committed at the parent. The manifest
adds `commitRole`, `parentCommit` and `workingTree` provenance, and the local report wrapper
explicitly preserves this distinction without changing the runner.

| Qualified input | SHA-256 |
| --- | --- |
| `packages/db/migrations/0034_work_corrections.sql` | `74418c22fdbd0dd8e0e28ef5ceacfb64fbd47c34f85816bafe1b39eba0aece63` |
| Raw `packages/db/migrations/meta/_journal.json` | `a75feb5339e5b06bd96fa543e39d964d20922a2f13de5c9853b861cb14fff10c` |
| Ordered target migration digest from the existing runner | `3e6366aee8e8a8f0625b6adb996dce31018db07265d5e7f33f21d89aacda5d29` |
| `experiments/s7-migration/target-history.json` | `7235a8fe83d54bfffd7ca4fe9c882bf40ff7d837bc3df3cc6317593f5310fad2` |

The first 34 target migration entries retain their previously pinned SQL hashes. Both sealed
source histories, their manifests, the baseline and fixture bytes remain unchanged. The final
0034 SQL has a 262144-byte bound on the serialized correction-context JSON. Correction behavior
requires separate implementation tests; this S7 fixture supplies no such acceptance claim.

The final run completed at `2026-09-24T12:01:00.504Z`: **40 actual passes**, no skipped cases,
process exit 0, on Node v26.0.0 / macOS arm64 with the existing digest-pinned PostgreSQL 17.11
image and `pg_dump (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+2)`. It used only its own labeled,
temporary PostgreSQL container and synthetic databases/files. Normal final cleanup completed;
no existing or production database was used.

- Architecture: guarded 27-to-35 upgrade retained the bounded legacy rows, IDs, references and
  artifact bytes; original and target database/file recovery and repeat startup passed.
- Feature: direct upgrade still failed at index 17 without source mutation. The existing bounded
  six-table transfer to a fresh 35-migration target retained synthetic identity/content/files.
- All existing negative cases passed, including history drift, unsupported records, transfer
  rollback, damaged backups, nonempty restore targets, artifact corruption and native restore
  DDL rollback. Legacy data was not reclassified into the new work domain.
- `sources.mjs` passed before and after the final run; all 35 actual SQL hashes and the raw journal
  hash were also compared with the pin after completion. The migration-manifest check passed.
- Repository documentation checks, target JSON formatting and the scoped `git diff --check` passed.
- The unchanged cleanup boundary's eight passing cases and successful Server/DB build from the
  earlier run in this same task are reused. DB and Server compiled afresh; six unchanged build
  dependencies came from Turbo cache. No broad product check is claimed by this scoped run.

Final local evidence directory:
`/private/tmp/openbot-s7-corrections-final-20260924-umt7sngc`. It contains
`qualification.json` (result plus explicit uncommitted-target provenance),
`qualification.raw.json` (unchanged runner output), `qualification.log`, the exact
`target-history.snapshot.json`, and before/after source and migration-check logs. The raw report
SHA-256 is `6ab0bf2b3a419a4ffe85157fc5de0ce7cbba58ac9e1ee16d6db5b5596f71a1f5`.

A prior run before the JSON-bound correction also passed the same 40 migration cases. It is kept
separately in `/private/tmp/openbot-s7-corrections-20260924-i8ougvlc`, with explicit pre-fix
provenance in `qualification.pre-fix.json`; its SQL hash begins `ed845517`. That earlier result
is superseded for the current target and does not establish correction-content capacity. The
same directory retains `cleanup.log` and `build.log` used above.

Only the target pin, bilingual S7 runbook and this qualification record were updated here. The
qualification code, sealed histories, fixtures, SQL/journal and application/runtime sources were
not edited by this scoped task. This is still local synthetic qualification, not hosted CI,
correction behavior acceptance, a general divergent-history migration, active-work recovery,
model/key/plugin/attachment/Temporal recovery, a production migration, default switch, release
or overall S7 completion. No commit was created.


### Committed target binding

After the scoped handback, Codex committed the accepted correction slice as `aa84c5ff97270d050a4110ff5ac17b311dcfac10`.
The final target pin now names that commit; `qualificationInput` retains the earlier dirty-input
provenance. SQL0034 and raw journal hashes were compared against `git show` and are identical
to the final qualified snapshot above. Source manifests are rechecked without rerunning the
unchanged database qualification. This pin update is not a new product migration or S7 completion.

## Local product schema candidate, 2026-09-25

Requalify the retained sealed source histories against canonical40 through0039. Existing official
PostgreSQL17.11 dump/restore and guarded migration tools remain the first viable implementation;
no migration engine or source transfer policy changes. `target-history.json` identifies the current
working-tree parent separately from the uncommitted SQL/journal hashes, never claiming that the
parent commit contains those changes. Original source snapshots and journals stay byte-identical.
The existing40 historical lineage/restore checks remain a bounded fixture gate; complete product
keys/plugin/media/engine restoration is a separate acceptance check, not implied by this run.

All40 existing cases passed on2026-09-25 with canonical40; the source histories remained sealed.
The checked-in `experiments/s7-migration/evidence/python-product-result.json` retains the actual
case results and adds the manifest's explicit parent-role/working-tree hashes to prevent a false
commit provenance claim. The report generator now emits those optional provenance fields too;
no database/test logic changed after the passing run.


## Native Task scope schema requalification, 2026-09-25

Canonical 41 adds only `0040_native_task_scope` at timestamp `1790208000010` to the previous
40-entry target. The prior forty SQL hashes and timestamps are unchanged. Reuse the existing
reviewed PostgreSQL 17.11 native dump/restore and exact-prefix Drizzle guard; no new framework,
dependency, migration/transfer logic or upstream source copy. The official
[pg_restore transaction contract](https://www.postgresql.org/docs/17/app-pgrestore.html) was
rechecked; the accepted `REL_17_11` source review above remains applicable.

`sources.mjs` has no expected-history override: it reads its adjacent target manifest and validates
the complete canonical journal. The bounded requalification therefore used an isolated path
mirror with byte-identical runner/helpers, sealed historical fixtures, built DB migrator and
artifact reader. Only its target manifest changed. The current parent remains
`482bdc5bea56c5b1a996492701b6dbb012d5691e`; it is not claimed to contain these uncommitted SQL bytes.

| Exact qualification input | SHA-256 |
| --- | --- |
| `0040_native_task_scope.sql` | `8aaed72a5691a531cad058c7652da6df003773e671730f03c1c6fb209dca2d6e` |
| Raw canonical 41 journal | `4aa566b0dcb473dc82c2db0b994a99fc8224a83e507fe9bc80f6f4ff0612c148` |
| Native Task scope result | `83578c42476484bfebe43a3c09bb700f05f7ed361701def2c365f45ea37b5ffa` |

The original forty real PostgreSQL migration/restore cases passed, as did all eight startup
cleanup tests (simulated Docker cleanup failures). The main qualification process exited 0, with
v26.0.0 on darwin/arm64 and pg_dump (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+2). Sources and canonical migration checks passed before/after;
71 source/target SQL/journal files retained their exact hashes, and the fixture-label container
inventory was empty after the original cleanup path. The historical canonical 40 result remains
unchanged; [canonical 41 evidence](../../experiments/s7-migration/evidence/native-task-scope-result.json)
contains only safe runtime metadata, digests and case results.

The additive schema is qualified only against existing bounded synthetic legacy data. These cases
do not populate or test native Task scope/proposal/collaboration behavior, run a production
conversion, restore active Temporal state, change defaults, publish a release or complete S7.
The root integrator owns the repository-wide check and final product acceptance.

## Command authority target requalification — 2026-09-25

Canonical42 adds0041, two inactive command authority tables, with no history rewrite or backfill.
The unchanged runner passed all40 dual-lineage/restore cases; the8 owned-cleanup checks passed.
Exact SQL/journal bytes are pinned in target-history.json and the new
[actual result](../../experiments/s7-migration/evidence/command-authority-result.json).
The42-entry active paired restore also passed with45 Control tables/109 rows; the two inactive
command tables were empty, so this is not pending-command recovery evidence.

## Canonical43 command readiness requalification — 2026-09-25

The unchanged40-case dual-lineage/restore runner and8 cleanup tests passed with migration0042.
The [result](../../experiments/s7-migration/evidence/command-readiness-result.json) preserves the
actual SQL/journal hashes and working-tree parent. Only the target pin and additive SQL changed;
sealed historical fixtures and runner assertions are retained. The owned PostgreSQL resources
were removed. Newly inactive command tables are empty in this fixture, so no in-flight command
restoration, product execution or production conversion is claimed.
