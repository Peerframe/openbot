# Retained upgrade fixture

This synthetic fixture pins the historical prefix through `0018_automations` from `2cc32d0`.
`manifest.json` records each SQL hash and timestamp plus the seed digest. The harness uses the
released Drizzle migrator to populate the old schema, then the production guarded migrator for
the current upgrade. It compares every old column in 15 populated tables, including timestamps,
appearance/configuration, portable Employee data, import receipts and each old automation outcome.

Run `npm run test:upgrade` with `OPENBOT_UPGRADE_TEST_DATABASE_URL` pointing at a new empty loopback
database named `openbot_upgrade_test_*`. The database is retained for inspection. A populated
database is refused without clearing it. Missing fixtures and unsafe targets fail explicitly.
The suite uses neither `.env` nor a personal model account. CI creates its own separate database.

Additive migrations should pass this fixture unchanged. If fixture coverage itself changes, review
the synthetic seed and deliberately update only its digest. Never update historical SQL hashes to
hide a rewritten applied migration. Keep the prefix old enough to exercise pending migrations.
The seed's artifact is metadata only; this suite does not establish file/key backup or restore.

See [database guide](../../../docs/DATABASE.md) and [research](../../../docs/research/retained-data-upgrade.md).
