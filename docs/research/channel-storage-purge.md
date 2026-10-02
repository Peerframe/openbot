# C21: permanent channel attachment deletion and measured storage

English · [简体中文](channel-storage-purge.zh-CN.md)

2026-10-03; depends on C19 PR #161, revision `85c2f7d` (not merged when work began).
Reuse [C19](channel-attachment-reference-counts.md), [channel attachments](channel-attachments.md),
[identity tombstones](../decisions/0047-identity-lifecycle-and-read-state.md), and existing OwnerTransactions/audit.
PostgreSQL 17.11 / REL_17_11 (PostgreSQL license), psycopg 3.3.6 (LGPL), Python 3.12 stdlib
(PSF); existing source pins/reviews remain unchanged. No dependency or upstream source copying.

Primary evidence: [PostgreSQL locks](https://www.postgresql.org/docs/17/explicit-locking.html),
[PostgreSQL LOCK source](https://github.com/postgres/postgres/blob/REL_17_11/src/backend/commands/lockcmds.c),
[Python descriptor-relative rename/fsync](https://docs.python.org/3.12/library/os.html),
[CPython filesystem implementation](https://github.com/python/cpython/blob/v3.12.12/Modules/posixmodule.c),
[volatile snapshot visibility](https://www.postgresql.org/docs/17/xfunc-volatility.html),
[trigger authority](https://www.postgresql.org/docs/17/plpgsql-trigger.html),
and [RFC 9110 410](https://www.rfc-editor.org/rfc/rfc9110.html#name-410-gone).

Compare moving blobs into PostgreSQL (large storage migration), introducing a storage/queue service
(new operational boundary), and the current private file store with a bounded rename journal and
small SQL deletion/idempotency receipts. Choose the existing store. Renames remain on the same
filesystem; an owned no-follow journal records intended files before staging. Commit deletion
receipts and per-file audit with the final reference check. On rollback/unknown commit, authoritative
SQL lookup decides restore versus physical cleanup; unavailable SQL leaves staging unresolved.
Every file-lock acquisition recovers pending journals, so an already-running second Server cannot
skip recovery. Minimal purged markers expose 410 only in the original channel and are projections
of committed receipts, never another file record. Original bytes/metadata/derived text are removed.

Cross-process flock covers normal reference admission. The final C19 recount additionally holds
SHARE table locks on messages/runs through commit, preventing concurrent INSERT/UPDATE phantoms
from other writers. Initial counts alone never authorize deletion; a newly committed reference
causes single-delete 409 or batch retention. Lock/statement/transaction deadlines stay bounded.
The coarse final locks may briefly delay unrelated channel writes; fail closed on contention.
A narrow SECURITY INVOKER/VOLATILE trigger on message content and Run instruction refuses
references to committed same-channel purge receipts, including a writer released after the purge
lock. The final locks alone would only postpone such a late write; the trigger closes that gap.
Its fresh statement snapshots are required, not STABLE visibility. No duplicate reference registry
or changed model authority; the existing receipt PK indexes UUID lookups. No source copied.

Cleanup requires a bounded requestKey; a committed SQL receipt returns the identical response on
retry, without another audit or touching files recycled later. Automatic cleanup is Server lifecycle
maintenance, independent of models/Temporal admissions, default off. A durable settings row gates
30-day age, daily due claim, per-run audit and multi-process exclusion under the same file lock.
The due claim and started audit commit before staging; a terminal audit is appended with the same
operation ID. Interrupted runs remain visible, and unknown commit replies require terminal lookup.
No unknown reference result can authorize any deletion in a pass.

Usage measures logical bytes in the configured managed object root and the configured PostgreSQL
database, with bounded no-follow traversal. Counts do not estimate remote Worker browser profiles;
unknown categories are null. Trash and top-channel file counts refer to channel attachments; Owner
native task attachment storage remains a separate measured category and is not purged by C21.

## Current handoff

Checkout `/private/tmp/openbot-c21-storage`, branch `codex/c21-storage-purge`, implementation
`8209bf9`, based on C19 `6dd5d32` after its main refresh. PR [#164](https://github.com/Peerframe/openbot/pull/164)
is stacked on [#161](https://github.com/Peerframe/openbot/pull/161); merge the dependency first.
No Web changes, paid models, automatic merge, release or production-data mutation.

Contracts: `DELETE .../attachments/:id/purge`, `POST .../attachments/cleanup` with UUID requestKey,
Owner `GET /api/v1/storage`, `GET/PUT /api/v1/settings/storage` with expectedRevision and null/30
policy. The [English API](../API.md#c21-permanent-channel-trash-deletion-and-measured-storage) and
[Chinese API](../API.zh-CN.md#c21频道回收站永久删除与实测存储空间) cover responses, limits, 409/410,
idempotency, measured-byte scope and audit. Migration 0050 adds minimal receipts/policy/late-reference
guards; whole-channel tombstone cleanup retains its existing contract.

Executed on owned PostgreSQL 17.11: focused `test_storage_purge.py`, `test_attachment_references.py`
and `test_identity_lifecycle.py`: **26 passed, zero skips**, including all 15 C21 cases. Coverage:
Owner/Origin/trash refusal; message and task references committed during deletion; waiting SQL
writers and case-insensitive INSERT/UPDATE refusal; final Owner revocation rollback; same-key clear
retry without new effects; 100 retained/20 channel bounds; unavailable SQL lookup and lost commit
recovery; original whole-channel cleanup; default-off/31-day versus 29-day/ref-safe automatic purge;
real maintenance start/stop; failed whole-pass rollback; measured storage and unknown/link refusal.

`npm run test:control:python`: **1,031 passed, two skips**. The base interpreter skips the two
Temporal activity/effect modules (`temporalio` absent); the hosted Worker lane executes them.
No C21 skip. `npm run check` passed after the C19 refresh: 18 build tasks successful, 17 cached;
focused SQL tests execute real transactions and synthetic filesystem effects, never paid providers.
Initial check lacked sandbox loopback permission; authorized local execution passed. Initial SQL
suite found one obsolete channel-content lock-order assertion; the corrected file-before-Owner
order is required to recover staging before reads, and the final full SQL suite passed.

The first hosted run passed validate but found stale migration consumers: the S7 current-target
pin and product container preflight still expected 50 migrations. Update only the current pin and
preflight to 51; sealed historical SQL stays unchanged. The final pin/preflight `npm run check`
passed again (18 successful build tasks, all cached). Real S7 requalification passed 40 restore/
migration cases plus eight cleanup cases; [content-free report](../../experiments/s7-migration/evidence/channel-storage-result.json).

The unpublished 0050 journal timestamp was corrected from a future value to actual authoring
time (later than 0049). SQL bytes are unchanged. The final committed migration source is
`38c10b39ffa91ab4746da6d35ddf77505106ac33`; focused PostgreSQL/HTTP **26/26** and retained-history **40/40**
were re-executed successfully against its exact journal pin. No applied production history changed.

Hosted results and immutable run/job links are maintained in the PR's Verification section and
[current-head checks](https://github.com/Peerframe/openbot/pull/164/checks). Required hosted results
remain the source of truth for CI completion. Claude owns ChannelFilesTrash/SettingsStorage wiring;
C21 supplies the backend. Local base/Worker evidence is distinguished above, not silently combined.
