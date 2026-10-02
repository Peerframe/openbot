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

Checkout `/private/tmp/openbot-c21-storage`, branch `codex/c21-storage-purge`, rebased onto C19 `6dd5d32` after its main refresh.
Scope: Python/storage migrations/audit/API documents; no Web, paid models, auto-merge or production
mutation. Acceptance: real owned PostgreSQL/HTTP reference refusals, late reference, rollback/recovery,
idempotent clear, existing whole-channel cleanup, measured usage and default-off/age/ref-safe auto
purge. Final focused owned PostgreSQL/HTTP run: 26 passed, zero skips (15 C21, three C19,
eight existing identity lifecycle cases), including waiting SQL writers and case-insensitive update
refusals. Full `npm run check` passed (18/18 build tasks cached on the final run; the preceding
implementation run built six tasks). Initial unprivileged check hit sandbox loopback EPERM; the
authorized local test run passed. Full SQL/control acceptance is running; hosted validate and PR
pending. Its first run had one outdated channel-read lock-order assertion (1,028 passed, two skips);
the channel read now deliberately holds file lock before Owner transaction for staging recovery.
