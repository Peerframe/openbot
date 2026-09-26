# Migration source and data compatibility

[English](MIGRATION_DATA_COMPATIBILITY.md) · [简体中文](MIGRATION_DATA_COMPATIBILITY.zh-CN.md)

The feature source at `9cc73c9e78451e572f57d142d6b9caf62ccb78e2` cannot directly upgrade its
19-migration database to the migration baseline `c33e03f1a14de739196113769c59fdaace9029e7`.
The first 17 SQL files match exactly. Indices 17 and 18 reuse timestamps for different changes:

| Index | Feature source | Migration source |
| --- | --- | --- |
| 17 | model_chat | request_throttle_buckets |
| 18 | model_services | automations |

The machine-readable [baseline report](migration-lineage-baseline.json) records full commits,
SHA-256 hashes and both suffixes. This is source evidence, not an inspection of the user's database.
The ordinary Server's hash/timestamp prefix guard must continue refusing incompatible histories.
Never overwrite historical SQL, forge migration records or reset a database to bypass this gate.

## Repeat the read-only check

With both source histories available in local checkouts:

```sh
npm run migration:compare -- --source-repo /path/to/feature-checkout --source-ref 9cc73c9e78451e572f57d142d6b9caf62ccb78e2 --target-repo . --target-ref c33e03f1a14de739196113769c59fdaace9029e7
```

The checker reads only committed Git tree/blob objects under the fixed migration directory. It
ignores staged/uncommitted files and refuses symlinked journals/SQL, invalid manifests and
non-commit references. It does not fetch, connect to a database, execute SQL or print SQL bodies.
Exit 0 means identical history or source-prefix only; 1 means divergent history/reverse direction;
2 means invalid input or read failure. Even 0 does not certify user-data or asset compatibility.
The current two baselines intentionally return 1. Run `npm run migrations:check` for its local fixtures.

## Preservation and later bridge requirements

Keep the migration branch's 0000–0026 history immutable. Integrate useful feature-source behavior
by target-owned forward changes. That does not make a feature-source database compatible: S7
must separately qualify a reviewed transfer/bridge using disposable synthetic databases from both
lineages, with recorded source history and row/asset provenance. Choose the transfer design after
S2's canonical schema and model-configuration responsibility are fixed; no bridge is implemented yet.

Preserve Bot/channel/message IDs, task outcomes and ancestry, reviewed skills and memory, schedules,
approval/audit records, attachments/objects, and each lineage's model configuration. Model ciphertext
cannot be copied blindly: the feature source uses a separate key file and PostgreSQL connection
records, while the migration baseline has encrypted model settings outside PostgreSQL. Credentials
must stay separately protected and must never enter exported source reports or model prompts.
Also preserve browser-profile binding and exclude login state from ordinary template exports.

The final transfer must stop competing writers, validate references/counts/digests and permission
semantics, produce a restorable paired backup, and define post-cutover rollback after new writes.
An old code checkout or old database snapshot alone is not a safe post-cutover rollback plan.
Unknown external effects remain unresolved until reconciled. This document authorizes no live
production change. See [stage plan](ARCHITECTURE_MIGRATION_PLAN.md) and
[research](research/migration-lineage-audit.md).
