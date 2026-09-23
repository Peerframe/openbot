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
- Native delegation, completion, root claims and channel member removal coordinate through
  PostgreSQL advisory namespace 731. The existing cancelWithDescendants instead locks the target
  Run row, then updates active descendants; it does not acquire the channel advisory lock itself.
  Member removal expires pending SQL approvals, while native plugin cancellation has separate
  service callbacks. Preserve these distinctions when reviewing lock order and commit timing.
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


Projection review correction: the current schema already includes runs_status_valid and
runs_execution_profile_valid CHECK constraints. Strict Python projection tests defend malformed
read-port values; they do not establish that those values can be inserted into the accepted
PostgreSQL schema. A prior assisted source comment claiming these columns had no CHECK was wrong
and has been corrected without changing behavior.


## S2b persisted execution authority review (2026-09-23)

This is the next implementation boundary after process supervision, using the same pinned
PostgreSQL 17.11/Psycopg 3.3.6 APIs reviewed above; no new dependency or SQL migration. The source
reference is `postgres-agent-store.ts`, `postgres-agent-collaboration.ts`, `agent-steering.ts` and
`channel-interactions-store.ts` at 1057104. Only existing OpenBot application semantics are ported;
no upstream source is copied. The intended unit is the persisted lifecycle with actual database
race tests, not a second runtime loop or an in-memory task engine.

### Authority and lock boundaries

- Background execution is authorized by persisted Run identity, native profile, current membership,
  persisted ancestry and the selected settings/skill/memory revisions. It must not depend on a
  browser cookie surviving: logout is not task cancellation. Owner commands still require the
  existing locked session transaction and final expiry check. Share bounded connection mechanics
  if needed, but never inherit or silently bypass Owner authorization in public command services.
- Queued root claims serialize against the six-root global advisory lock `(731, 6)`, then the
  channel hash advisory lock; current membership is held under SHARE, and the exact queued
  identity/profile/node/time predicate is updated once with RUN_STARTED in the same transaction.
  A model cannot choose an executor or acquire a Worker computer profile.
- Ancestry comes from stored rows, not optional caller provenance. Re-read at most three levels,
  same channel, current native running state and each Bot membership. Acquire required ancestor
  row locks root-to-leaf; recheck state after obtaining locks. Completion shares the channel lease
  with delegation so a child cannot appear after the unfinished-child check.
- Model usage advances by compare-and-set on the previous step count and commits its audit before
  the model result can expose a tool intent. Unknown token counts remain null. Progress and usage
  cannot revive terminal rows; competing claims/usage/completion must have at most one winner.
- Owner corrections lock the target Run, accept only active native tasks, bound the history to
  eight trimmed 1..4000-character instructions and retain existing event names/identities. Final
  completion locks that same row and refuses if any committed correction is missing from the
  host's applied IDs. A newer correction must not vanish between model return and SQL commit.
- Cancellation/failure must settle active descendants and report committed records before process
  callbacks run. SQL approval expiry and plugin-service pending calls remain different owners.
  Do not report a cancelled external side effect as undone. Scope checks after awaited ports
  block late results; uncertain effects must not be retried by a cleanup path.

### Completion and retained assets

The final publication transaction must include the Bot reply, Run terminal state, content-bound
audits, accepted artifacts and reviewed memory/skill reference checks. Preserve knowledge
proposal validation/caps and revision conflicts. A text-only internal test is not evidence that
artifact/learning completion has migrated, and cannot select Python as the default dispatcher.
No synthetic empty replacement for those retained features may be exposed to the client.

### Required actual-fixture evidence

Use the existing owned PostgreSQL schema/HTTP fixture: concurrent claims and channel exclusion,
audit-failure rollback, revision/Owner revocation, cancellation against usage/final publication,
correction against completion, ancestor cancellation and membership removal. Persist the real
SDK host result through the control store with deterministic model/tool ports. Compare projected
records with the existing TypeScript readers. A database commit and terminal message must occur
once; test that a losing operation creates neither a reply nor a success audit. Restart recovery,
external provider success and production switching remain separate gates.


## Owner lifecycle commands — frozen adapter design (2026-09-23)

The next user-facing increment reuses the reviewed OwnerTransactions and existing PostgreSQL
lifecycle above: POST cancel (strict empty JSON, 128-byte body) and POST steer (strict instruction,
18,000-byte body). Use actual Zod 4.6.2 against Python before accepting the pure adapters. No new
library, schema, worker protocol or upstream source. Current OpenBot TS source at4cbdc63 remains
the local porting reference; its original MIT license is retained.

Cancellation locks the persisted target row, permits only native queued/running tasks, preserves
idempotent cancelled responses and records one Owner audit for the target and each affected active
native descendant in the same channel. Preserve the existing parent/root selection and do not
invent SQL-approval expiration in this command: member removal and plugin callbacks own those.
Bound descendant rows and fetched text before public projection; an exceeded bound rolls back,
never returns success for partial cancellation. A cancellation racing a task claim/completion
must serialize on the Run row; no model/external call is made while holding the transaction.

Steering locks the same Run row used by completion, holds membership SHARE, and reads at most nine
existing scoped steering events (at most eight accepted). It stores exact Owner audit identity
and trimmed valid Unicode, rejects additional attachment markers at HTTP and store boundaries,
and returns 202 only after final Owner/session expiry recheck and commit. Cancellation against
steering is tested with real row-lock contenders; rejected or rolled-back commands add no audit.
No execution callback is exposed in the current queued-only reference. When the dispatcher is
integrated, process/plugin interruption and realtime publication must follow the committed result;
the persisted cancel result is not evidence that an external effect was undone. Whole S2b remains
open until execution/tool/approval/complete integration is accepted.


A real two-writer race exposed an acceptance-test assumption: existing cancellation audit timestamps
use PostgreSQL now() (transaction start), so timestamp order may differ from commit order after
lock waits. Preserve that existing schema behavior in this slice. The corrected fixture proves
serialization via observed row contention and both committed payloads, without treating timestamps
or random UUIDs as an event cursor. Durable ordered events remain the explicit S2c contract task.


## Owner commands local acceptance

Root independently verified 71 combined PostgreSQL/HTTP cases (26 new command cases), actual TS
readback of cancelled roots/descendants and Owner corrections, and 38 focused command/task/entry
checks. The final locked Python package passed 728 cases; its 71 fixture-only cases were verified
separately as above. Full npm run check passed. A first package run had two pre-existing process
timing failures (TERM-grace elapsed-time assertion and a real-SDK process refusal). Both passed
alone, then the complete suite passed without any process implementation/test/timeout change.
The observed host load was high, but no causal claim is made. Both run logs are retained locally.

The new database races observe real row-lock contention: only one repeated cancellation produces
an audit, at most eight competing corrections commit, a correction that wins remains recorded,
a cancelled target rejects later correction, and Owner expiry during a Run wait rolls back all
changes. Audit failure rolls back both parent and descendants. Existing node/profile boundaries,
1000-descendant and 4 MiB transfer/JSON bounds fail closed. Real loopback HTTP in tasks mode now
submits, steers and cancels a task. No model execution, plugin interruption, realtime publisher,
completion transaction, restart recovery or production selection is established by these checks.


Assisted contribution: WorkBuddy DeepSeek supplied the pure input/projection module and its tests.
Root stopped the worker, reviewed its files, corrected a non-behavioral false claim about Python
lone surrogates, and wrote the final comparator. All 34 actual installed Zod/Python command cases
agree, including strict unknown-key refusal, ECMAScript trim, astral/combining boundaries and
lone-surrogate value parity. The trusted store independently rejects non-UTF-8 text. The comparator
is wired into the existing combined control gate. No upstream source was copied or dependency added.


## Persisted runtime lifecycle implementation boundary — 2026-09-23

Baseline e942321; this implements the full existing native Run-store lifecycle, including final
publication with retained artifact metadata, skill/memory revision checks and optional knowledge
proposal audits. Reuse the same pinned Psycopg/PostgreSQL/Pydantic and original OpenBot MIT source
reviewed above. No dependency or SQL migration. Share only bounded SQL connection mechanics with
OwnerTransactions: background Run authority never inherits an Owner cookie requirement, while
HTTP writers must retain locked session authorization and final expiry recheck.

Port persisted claim/scope/usage/progress/correction/failure/complete, and freeze the same channel
history cutoff used by the TS executor. All invocation identity is bound by trusted composition;
a worker receives neither DSN nor storage handle. Claims are root-only and respect the six-root
lease, per-Bot channel exclusion, membership and startup cutoff. Mutations recheck persisted
ancestry root-to-leaf; lock ancestors SHARE, target UPDATE, and current membership SHARE before
writing so cancellation/revocation wins atomically. Failed/revoked tasks can still be settled by
failure without resurrecting state or requiring membership to remain. Never retry uncertain writes.

Completion validates final UTF16/text bounds, at most two trusted persisted Markdown artifacts,
up to eight memory references and two distinct skill references, all submitted correction IDs,
and the existing pending knowledge proposal cap50. Completion includes all retained asset options;
it is not a text-only replacement. Optional proposal saturation produces a SKIPPED audit and cannot
roll back otherwise valid delivery. Reject unsupported/unreviewed skill dependencies/capabilities,
stale revisions or unfinished children under the existing channel creation lease. Store metadata
validation does not establish that bytes exist: actual file content/digest comes from a trusted
storage port and must be exercised using owned fixture files before claiming delivery.

The maintained standard APIs already reviewed supply transaction/locking/JSON behavior. The local
adapter ports only existing OpenBot policies. Sensitive-text patterns remain a heuristic, not a
universal secret detector. Pure values and exact failure text will be compared with actual compiled
TypeScript before SQL acceptance. Use real database races and the separately installed SDK worker;
no private models, production switching or synthetic empty aggregate response is introduced.


The Python adapter additionally validates persisted root/delegator consistency and fixes the
provider/model identity across usage steps. These are explicit fail-closed corrupt-state checks;
the legacy TS store validates step monotonicity without that additional identity predicate. Normal
existing runs retain the same contract. Claim never starts a delegated row as a new root.
The combined PostgreSQL gate now requires the separately bootstrapped SDK interpreter rather
than allowing that integration to silently skip; the existing Linux CI lane bootstraps both.


## Persisted lifecycle local acceptance

The final locked control package passed 766 tests; its 95 fixture-only skips were independently
executed in the owned PostgreSQL/HTTP/real-SDK gate and all passed. The final combined gate also
passed 129 identity inputs, 60 task contracts, 48 wire cases, 34 Owner commands and 40 execution
value comparisons against actual TypeScript/Zod, plus all 20 public failure messages. Full npm
check passed. No new dependencies, schema migrations or default backend selection were added.

The 24 new fixture cases prove concurrent claim/usage/completion exclusivity, six-root and channel
limits, persisted ancestry, logout independence, membership/revision/cancellation races, failure
cascade, new correction refusal, final audit rollback, proposal saturation and context cutoffs.
Four include a real separately installed SDK subprocess and database ports: one retains actual
report bytes, reviewed references, a pending proposal and corrections; others refuse late model
results after revocation/cancellation or a new correction after the worker returns. Model responses
are deterministic fixture data, not live-provider evidence. TS reads completion/context and the
owned file digest matches committed metadata. SQL rollback deliberately does not claim cleanup of
pre-existing bytes; the production file adapter still owns that responsibility.

WorkBuddy DeepSeek supplied the value module, focused cases and compiled-TS comparator. Root
stopped additional mutation experiments outside the bounded task, inspected the draft, and fixed
recursive metadata validation before JSON encoding, strict nested types and revalidation of
already-created mutable models. It also corrected inaccurate comments about pending proposals
and escaped lone-surrogate JSON. Root owns all SQL/runtime integration, real fixtures and acceptance.
The worker is stopped and the stale unsent review draft was cleared in the UI. This delivers the
persisted lifecycle, not production dispatch/tool/approval integration or the entire migration.
