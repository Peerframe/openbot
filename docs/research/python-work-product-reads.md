# Work product read tools: reuse and authority review

Date: 2026-09-25. Implement only a Work adapter for `read_channel_context`,
`read_task_status`, `read_attachment`, `list_channel_bots`, and a trusted initial
profile reader. No schema, dispatcher, workflow, provider, dependency, or core edit.

Reuse the reviewed PostgreSQL 17.11/Psycopg 3.3.6 transactions, CPython 3.12.13
hashlib/JSON, and Temporal 1.33.0 SDK context through existing OpenBot binding gates.
The exact releases, licenses and upstream source/test reviews already appear in the
root `docs/OPEN_SOURCE_REUSE.md` Python control/Work/attachment entries. The
[PostgreSQL locking specification](https://www.postgresql.org/docs/17/explicit-locking.html)
confirms SHARE/UPDATE conflict and updated rows after lock waits. The
[ECMAScript slice specification](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.slice)
supplies UTF-16 offset semantics. GitHub Psycopg 3.3.6 source was also requested;
the web cache could not retrieve that already-reviewed source. No new dependency
or external source is copied.

Retained OpenBot MIT source: `agent-attachments.ts`, `native-agent.ts`,
`postgres-agent-store.ts`, `postgres-agent-collaboration.ts` (latest relevant
retained commit `57622393b5c64eb94b791b8ce286d768f3d99423`), plus the accepted
`execution_context.py`, `OwnerFiles`, Work gates, and `ToolResults`. Query/projection
and paging logic are substantially adapted from these existing application files.
Keep their existing attribution and notices; no second parser or file layout.

Public contracts: empty strict arguments for context/status/colleagues; attachment
UUID plus UTF-16 offset 0..262144 and limit 1..16000 (defaults 0/12000). Preserve 12
recent context messages plus the explicit reply reference, 1600 bytes per content,
10000 content bytes total; 8 task status records; 32 colleague records and 12KiB
catalog; 8192-byte/10240 JSON-content-byte attachment pages, 32 reads and 262144
returned UTF-16 units per Work task. The original `none` colleague eligibility is
retained; listing does not authorize a delegation.

Accepted migration differences: immutable source-message time and source-Run creation
time replace the old lifecycle's `RUN_STARTED` cutoff. Status comes from
`runs_work_projection`. No old `active_chain` or Run execution loop participates in
authority. Every entry derives actual SDK/accepted Work identity; Task/source,
correction and membership are rechecked in the read transaction. New data reads after
admission additionally require the current Activity claim fence. Historical receipts
never mint a claim or perform another read operation.

Like the accepted knowledge adapter, `load` only reconstructs the common response
adapter/verifier. This preserves hash-only lost-acknowledgement settlement after process
restart and cancellation. Actual apply and public result readback perform fresh authority
checks; reconstructing a trusted service object grants no data access.

Lock order: OwnerFiles lock (attachments and whole-history validation), then the
existing source channel/Run KEY SHARE locks, Task, source/Work Run, membership and
Action. File reads are bounded synchronous reads under that lock. Acquire the
strongest needed Task lock before accepted-engine validation to avoid SHARE-to-UPDATE
upgrade deadlocks between simultaneous read admissions.
Persist a private `work_reads` version-1 result/receipt envelope through the existing
ToolResults codec. Recovery returns the originally observed DTO only after current
access checks; attachment original and extracted-content hashes must still match.
Status observations remain historical, not a fabricated latest snapshot.

Attachment budgets inspect at most 32 prior admitted observations under the Task
lock using the accepted `ToolResults.load_in_transaction` method. Unknown observations
reserve their requested page length. No process cache,
second budget table, new codec, or callback-derived authority.

`read_prompt` returns bounded Server-owned Bot profile, source identity and the retained
ChannelAttachment descriptors for the source Task's explicit references, not model
messages or knowledge. Root freezes the initial correction context before this call;
the same Task/source/membership/current-correction contract applies. When references
exist it acquires the file lock before SQL and validates the original files and any
processed text. It consumes no tool read and does not disclose file content. Unprocessed
image/PDF descriptors are not a claim of binary model input support.

Root requires current-generation read receipts to be revalidated before each model
send and inside final publication. `revalidate` holds files before opening its Task
transaction. `revalidate_in_transaction` uses the caller's existing file lock and SQL
transaction without reacquiring either. Both verify actual SDK binding/fence, current
source/correction/membership, each applied observation's settled hash, and consumed
attachment metadata/original/derived hashes. This is validation, never a second read
budget charge. With `history_reset_on_correction=True`, only earlier generations
whose model history root discards are skipped; a caller preserving old history must
select False and handle the resulting fail-closed reset requirement.

The only paging compatibility restriction is explicit rejection of an offset in the
middle of a UTF-16 surrogate pair, or a limit too short to make scalar progress. The
accepted ToolResults JSON codec cannot persist lone surrogates. A trailing half is
left for the next page; bytes are never rewritten or replaced. This is recorded as a
restriction rather than claimed as exact ECMAScript lone-surrogate support.
