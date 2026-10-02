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
PR: [#161](https://github.com/Peerframe/openbot/pull/161). Implementation/test revision `f86e28f`:
[hosted validate passed](https://github.com/Peerframe/openbot/actions/runs/37042098568/job/110954806783).
This evidence-only update reuses that run. Only channel list projection changes; no Web or C9/C11.

Executed: five real PostgreSQL/HTTP cases passed, zero skips: `test_attachment_references.py`,
`test_attachment_families_keep_distinct_delete_lock_and_header_semantics`, and
`test_real_owner_workspace_and_attachment_task_lifecycle`. Acceptance covers exact counts,
duplicate/case markers, unreferenced files, same-ID foreign channel exclusion, terminal/delegated/
mapped task identity, recycled files, Owner/refused scope, final authority recheck, bounded overflow
without partial content, and upload/reference/delete/restore. The existing uploaded-item equality
assertion includes additive zero referenceCount. New tests are in `scripts/test-python-control.mjs`
for the actual hosted SQL lane, not only the base suite's skipped database collection.

Full `npm run check` passed (18 build tasks successful, 12 cached). Final docs gate passed: 12 tests,
564 Markdown files. The implementation full-check evidence is reused for the later test/record-only
updates. Initial synthetic child delegation fields and foreign-channel uniqueness/teardown were
corrected before the final passing run. Initial shared dependency link lacked nested workspace
versions; an independent locked install passed. No paid model, real data, automatic merge or release.
