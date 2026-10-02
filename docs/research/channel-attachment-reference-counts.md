# C19: bounded channel attachment reference counts

2026-10-03; baseline `cbf1700bf596f8f06f202005123e6d92cf7d59a1`.
Reuse [channel attachments](channel-attachments.md), [Python message reads](python-message-reads.md)
and the current OwnerTransactions policy. PostgreSQL 17.11 / REL_17_11, psycopg 3.3.6 (LGPL),
Python 3.12 stdlib; PostgreSQL license. No dependency, migration or durable reference registry.

Reviewed primary [substring matching](https://www.postgresql.org/docs/17/functions-string.html),
[LIMIT](https://www.postgresql.org/docs/17/queries-limit.html), and the existing GitHub PostgreSQL
[source/test review](python-identity-transactions.md). The maintained current implementation and
migration `0036_work_sources` establish unique Run-to-Work mapping. Existing parser source
`task_store.attachment_ids` and channel collaboration inheritance are the authority for markers.

Compare a new reference table/index (new persistent dual-write boundary), fetching message bodies
into Python (unnecessary content disclosure), and bounded SQL existence counting. Select SQL:
count retained records containing the exact case-insensitive canonical marker, repeated occurrences
once. Counts for messages and frozen channel Run instructions use a single SQL snapshot. A mapped
Work Task is not added again; native Task file scope is distinct. No generated regex or message
content crosses the database boundary. Up to 1,024 files and 10,000 references per category/file;
query fetches at most 10,001 matches per category/file and refuses overflow. Existing statement and
transaction deadlines bound scanning even on a large unindexed channel; timeout means unavailable,
never zero. This read is not cleanup authorization or a record of actual model use.

The file lock precedes Owner transaction, as on submit/delete. Authorization runs before channel
lookup and after projection. Source copied or substantially adapted: no. No additional upstream
license notices are required. English/Chinese API documents define the additive response field.

## Current handoff

Checkout `/private/tmp/openbot-c19-references`, branch `codex/c19-attachment-reference-count`.
Only channel list projection changes, no Web or C9/C11 work. Executed: 4 real PostgreSQL/HTTP cases passed, zero skips (`test_attachment_references.py` plus
`test_attachment_families_keep_distinct_delete_lock_and_header_semantics`). Full `npm run check`
passed (18 build tasks successful, 12 cached). Docs gate: 12 passed, 563 Markdown files before the
translation was added; recheck follows. Initial synthetic child lacked its delegation fields, then
a foreign-channel test name collided; fixtures were corrected before the passing run. Initial full
check used a shared dependency link that lacked workspace nested dependencies; the independent
locked install passed. New tests are included in `scripts/test-python-control.mjs` for actual hosted
SQL execution, not just the base suite's skipped database collection. PR: [#161](https://github.com/Peerframe/openbot/pull/161); hosted validate pending.
Final fixture teardown also removes the foreign-channel records; affected four cases reran and
passed, zero skips. Final docs gate includes the translation: 12 passed, 564 Markdown files.
Acceptance: real PostgreSQL/HTTP exact counts, duplicate marker, case, unreferenced file, same-ID
foreign channel exclusion, terminal/delegated/mapped task identity, recycled file, Owner/refused
scope and overflow with no partial content. No paid model. No automatic merge or release.
