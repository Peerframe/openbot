# Research: committed migration lineage audit

- Status: Accepted for a read-only source audit; no database migration authorized by this tool.
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: compare two immutable source commits and detect incompatible SQL histories
  before attempting an upgrade; never inspect private database or working-tree files.
- Security boundary: Git object reads only; fixed migration subtree; bounded subprocess output;
  explicit local repository paths and full commit IDs; no shell, hooks, network, database or writes.

## Search evidence

Searched GitHub and official Git/Drizzle documentation for `git ls-tree cat-file committed
migration history`, `drizzle readMigrationFiles hash` and existing migration plan validation.
Reviewed the current reuse ledger's PostgreSQL/backup boundary and `docs/DATABASE.md`.

| Candidate | Exact release or commit | License | Maintenance/tests/fit | Decision |
| --- | --- | --- | --- | --- |
| Git object plumbing | Git v2.54.0; installed Apple Git 2.54.0 (157) | GPL-2.0; subprocess only | Reviewed [ls-tree source](https://github.com/git/git/blob/v2.54.0/builtin/ls-tree.c), [object reader](https://git-scm.com/docs/git-cat-file), [tree mode/path contract](https://git-scm.com/docs/git-ls-tree), [license](https://github.com/git/git/blob/v2.54.0/COPYING), [issue entry](https://github.com/git/git/issues). Git's GitHub issue page is not its primary bug tracker. Existing CLI is maintained; local real-repository fixtures will verify mode/path behavior. Some remote test-file URLs could not be fetched; no claim to have run upstream tests | Reuse installed CLI, no Git implementation/library |
| Existing OpenBot manifest validator | c33e03f1a14de739196113769c59fdaace9029e7 | MIT | Source/tests in scripts/check-migrations.mjs and scripts/check-migrations.test.mjs; already rejects sequence/timestamp/path-set drift | Reuse directly |
| Drizzle migration metadata | drizzle-orm 0.45.2 | Apache-2.0 | Reviewed [pinned migrator](https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/drizzle-orm/src/migrator.ts), installed source, existing packages/db/src/index.test.ts and [migration docs](https://orm.drizzle.team/docs/migrations). SHA-256 hashes original SQL text; guarded OpenBot startup requires an exact timestamp/hash prefix | Preserve hash convention, do not invoke migrator |
| Drizzle CLI schema diff/generate | existing drizzle-kit 0.31.10 | MIT | Existing authoring policy already rejects generation that rewrites shared migration history; schema equivalence does not establish applied-history equivalence | Not suitable for lineage certification |

## Reuse decision

Use the first viable standard/dependency primitives: Git immutable tree/blob reads, Node SHA-256
and the existing manifest validator. The narrow local gap is comparison/reporting of two valid
OpenBot journals across separate source checkouts. Compare original SQL bytes and timestamps;
report tag drift conservatively. Only a source exact prefix of target passes the source-history
gate; even then this does not establish data, object, key, API or runtime compatibility.

Require full commit object IDs, reject symbolic links for journals/SQL, validate manifests before
loading tagged files, and print hashes/metadata rather than SQL content. Do not resolve paths from
SQL or run Git filters. Missing objects or malformed input fail; no install/fetch/repair occurs.
Exit 0 means source-history-prefix only, 1 means incompatible direction/divergence, 2 means invalid
input/read failure. The ordinary runtime database history guard remains unchanged.

## Source incorporation

No external source copied or substantially adapted. Reuse existing MIT repository validator;
call Git as an installed executable. No dependency or runtime authority expansion.

## Verification plan

Use actual disposable Git repositories: shared prefix, changed SQL at same timestamp, longer source,
malformed journal, symlinked SQL, untracked/modified SQL and a staged but uncommitted journal.
Verify the CLI exit classification, output hashes and unchanged working-tree status. Then compare
the two actual pinned source commits. Wire fixtures into migrations:check and run npm run check.
No production database, data migration, browser or paid-model validation is claimed.

## Initial finding before implementation

The two sources share exactly the first 17 SQL files (0000–0016). Source 9cc73c9 has 19 migrations;
target c33e03f has 27. Index 17 has the same timestamp but source 0017_model_chat and target
0017_request_throttle_buckets differ; index 18 similarly collides between model_services and
automations. Existing guarded startup must refuse this as a direct database upgrade. Do not edit
historical hashes or mark target migrations applied. A later reviewed data transfer/bridge must
preserve model configuration and runtime data explicitly.
