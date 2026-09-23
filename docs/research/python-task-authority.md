# Research: Python task authority migration sequence

- Date: 2026-09-23
- Status: S2b-1 queued submission/read accepted locally; execution/approval migration in progress.
- Source baseline: 035bc95 and unchanged TypeScript task services.

Reuse the exact PostgreSQL 17.11, Psycopg 3.3.6, Pydantic 2.13.5 and Zod 4.6.2 pins reviewed for
[identity transactions](python-identity-transactions.md), [inputs](python-identity-inputs.md), and
[control reads](python-control-read-slice.md). Keep the existing SQL history, identifiers and audits.
No new workflow engine, ORM or model authority is selected. Existing released runtime/transport
reuse remains in apps/agent-runtime-python/RESEARCH.md; this document does not yet authorize an
invented second wire protocol or a dependency addition.

## Inspected responsibilities

- postgres-task-submission.ts owns one transaction for source message, chosen recipients, queued
  runs and MESSAGE_CREATED/RUN_CREATED audit. A locked channel serializes human/system timestamps
  so queued instructions retain distinct millisecond boundaries. Reply targets must be in-channel.
- task-routing.ts validates all one-to-six unique recipients before any writes; direct chats only
  address their Bot, a requested Bot must be a member, otherwise the chief/first candidate is used.
  Ordered SQL candidates are part of that fallback. A role name never grants tool authority.
- TaskAttachmentReferences and channel-attachments.ts lock/check Owner-authored attachment markers
  before the database transaction. Until Python has the equivalent file authority, it must refuse
  referenced-file submissions explicitly; accepting unchecked markers is not compatibility.
- postgres-task-records.ts and agent-observations.ts define Run/usage projection. Channel run reads
  return the latest 50, with full IDs and optional fields. Stored unknown status/profile values
  must not acquire execution authority. Model usage is reported evidence, not billing or a grant.
- native run cancellation, delegation, completion and channel member removal share PostgreSQL
  advisory namespace 731; cancellation includes active descendant runs and pending approvals.
  Their lock order, status predicates and callback timing must be reviewed together before porting.
- The current HTTP submission publishes committed events and invokes dispatch after persistence.
  Python must select one dispatcher per run and never schedule before commit. A successful queued
  write alone cannot establish that a task executed or survived a restart.

## Ordered implementation and gates

1. Frozen inputs/routing/Run projections and a paired TS/Python oracle, then atomic submission and
   channel reads in a dedicated synthetic fixture. Establish complete rollback, missing recipients,
   reply-scope rejection, exact audits and ordering. Do not expose unimplemented attachment behavior
   as supported or silently omit the multi-recipient `runs` envelope.
2. Python control-owned runtime supervision and guarded claim/complete/fail/cancel, retaining the
   accepted bounded untrusted worker framing. Deterministic process integration proves exactly one
   terminal publication, cancellation and refusal after revocation; it does not prove live models.
3. Tool/approval lifecycle plus membership removal, including transaction/dispatch boundaries and
   explicit handling of uncertain external effects. Durable restart continuation is qualified in S3.
4. Integrate each selected authority without two writers or double dispatch. Keep TS default until
   the full S2 contract/client gate, then prepare (not silently perform) the final selection change.

The public aggregate profile, snapshots/reconnect events, settings/files and schedules remain S2c.
Use larger independent implementation bundles now that the shared authority/input foundations are
stable; Root owns integrated behavior and independent real fixtures. Do not repeatedly re-implement
or re-review those settled foundations for each endpoint. The frozen submission design is below; execution supervision must retain the accepted runtime wire contract.

## S2b-1 frozen submission design (2026-09-23)

This slice is now approved for implementation against baseline 9726ddd. Root owns persistence,
HTTP and real acceptance; the assisted worker owns pure input/routing/Run projections. Preserve
createMessageInputSchema semantics: normalized 1..8000 code points, one optional Bot or 1..6 unique
Bots, optional in-channel reply, omitted-only optional fields, and unknown-key stripping. Reuse the
accepted UUID/text adapters rather than a second normalization implementation. Model usage keeps
explicit null token counts; optional Run fields still omit null. Invalid usage is omitted just as
in toRun; invalid required state fails closed.

OwnerTransactions encloses all business writes. Lock the channel, check replies and ordered member
candidates under SHARE, then commit one human message, one-to-six queued runs and their exact audits.
Use database millisecond time or the latest human/system message time +1 ms, whichever is later.
The message points to the first run, and every run points back to that source message. Include the
optional `runs` envelope only when the caller supplied botIds. No dispatch before commit. Existing
unique source-message/Bot index and foreign keys remain unchanged; no second migration history.

For titles, retain the 80 UTF-16-unit threshold and 77-unit prefix plus ellipsis, but never split a
Unicode scalar: when the boundary bisects a surrogate pair, omit that partial scalar instead of
returning an invalid surrogate. This is an intentional narrow correction to the old title helper;
normal BMP titles and non-bisected prefixes are unchanged. Validate all input is representable in
UTF-8 before a write. Exact differential cases will identify that documented invalid-surrogate
exception rather than pretending full equality with malformed legacy output.

An explicit `tasks` reference authority adds identity operations and submission. Until execution
supervision is attached in S2b-2, the API reports committed `queued` state only; no claim of execution
is made. Missing file-reference authority returns 503 on actual OpenBot attachment markers before
persistence. It must later be replaced by S2c's locked file validator, not removed. Root writes the
bounded marker extraction using the existing pattern/8-reference limit and tests case/duplicate
semantics. Public task content has a 128 KiB body ceiling/five-second input deadline, covering
8000 astral characters even in escaped JSON; raw bytes remain independently bounded.

Channel run reads reuse the authorized read-only transaction, latest-50 bound, stable tie ordering,
pre-transfer text-byte and final 4 MiB JSON checks. This intermediate reference never makes Python
and TypeScript active dispatchers of the same run. Production selection remains unchanged.


## S2b-1 acceptance

The integrator independently ran 345 package cases, 45 owned PostgreSQL/real-HTTP cases, 129
installed Zod/Python input cases and 60 actual TS/Python routing/Run projections. Existing TS reads
Python-created multi-run messages and runs exactly. Audit-trigger failure rolls back all message,
run and audit inserts; concurrent submissions preserve increasing millisecond source boundaries.
Revoked/expired Owner, missing members, direct scope, foreign replies, oversized data and absent
file-reference authority are rejected. Valid nullable usage survives HTTP serialization. No new
upstream source was copied. Only existing OpenBot code was ported; prior Zod notices are retained.
Full `npm run check` also passes. This proves local queued-state compatibility, not execution,
recovery, live models or hosted CI.
