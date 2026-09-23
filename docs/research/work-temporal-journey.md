# Research: public work journey through a durable engine

- Date: 2026-09-23
- Status: reference integration implementation; no production/default selection
- Owner: OpenBot integrator
- Journey: public Task -> durable handoff -> SDK proposal -> exact approval -> external write ->
  lost-response reconciliation -> verified Artifact -> authenticated reconnect/download.
- Boundary: existing Python control transactions own all grants/budgets/domain state; one Temporal
  workflow owns waits/replay. A scripted model and independently persisted loopback effect service
  replace paid providers and real applications. Original user data is never used.

## Evidence and reuse

Reuse the eight-case official SDK composition and earlier engine fault reviews, pins and licenses:
Pydantic AI2.47.0/77d5fce751ab8ab04bd5db4ed6acc1131a4baed6, Temporal Python1.33.0/
ab52fdde33ee8ed193402625bfdba25d240a762d (MIT), CLI1.9.1/Server1.32.0 development profile.
Read the existing work store, immutable intent/approval/budget transactions, 0027 pending admissions,
0028 claim/final-publication logic and PostgreSQL integration fixtures before extending them.
Searches: GitHub Temporal workflow ID/run ID/reuse policies, activity retries/side effects,
PostgreSQL17 explicit row locking. Primary references:
[workflow identity](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx),
[row locks](https://www.postgresql.org/docs/17/explicit-locking.html),
[SDK composition review](sdk-durability-integration.md).
The existing pinned SDK tests and our completed-ID experiments establish the reviewed reject-duplicate
API; uniqueness is scoped to namespace and retained history, not an eternal external-effect guarantee.

## Reuse choice and local gap

Use released TemporalDurability/PydanticAIPlugin for granular SDK work. Do not introduce a graph
serializer, message broker, home-made recovery scheduler or production dependency switch. The thin
control handoff adapter reads already committed pending obligations and acknowledges a verified
engine acceptance; SQL and engine enqueue are not falsely described as one transaction. An engine
workflow ID derived from the business Run plus REJECT_DUPLICATE makes the acceptance/ack crash
retriable while history exists. On duplicate start, verify the existing workflow identity/inputs
rather than assuming any conflicting workflow is the intended one. Acknowledgement after cancellation
records a past receipt only; it never reopens authority. Task-row locks serialize acknowledgement
and audit, matching existing commands. No public acknowledgement or trusted inspection route.

An owned fake HTTP service commits operation receipts and CSV state in SQLite before responding;
parent inspection counts POST attempts as well as logical writes. Deliberately dropping a write
response must lead to unknown, then a GET lookup of exact immutable intent and verified bytes.
The adapter never sends another POST for admitted/unknown outcomes. Missing/conflicting evidence
stays unresolved, not refunded or converted to success. Python sqlite3 is the existing CPython3.12
stdlib (PSF); this fixture is not a new storage choice for product authority. No upstream code copied.

The reference strategy executes in trusted workflow code. Only control-side activities access PG,
model/tool adapters and final artifacts; no model decides approval requirements. Every new model/tool
operation rechecks current claim/authority and reserves shared budget. Confirmed past receipts may
be recorded/read after cancellation, but no new operation or final success is admitted. Engine
success and business completion remain distinct. Current process-based Runtime is not implicitly
connected by this reference.

## Verification

Actual public API login/Bot/Task/approval/cancel/snapshot/artifact routes and real PostgreSQL.
Kill the dispatcher before enqueue and after accepted enqueue before acknowledgement; repeated
handoff must target one workflow. Kill the worker at deferred approval; approve while absent.
Lose the external write response, expose reconciliation in Task state, kill/restart and query the
persistent receipt; inspect the same bytes independently before final publication. Reconnect public
clients, verify one completion/artifact and exact spend. Repeat cancellation at approval and after
an unknown effect: no new write/final publication, and already-applied effects remain recorded.
Malformed receipts must not complete work. Add focused PG handoff concurrency/rollback tests.
Temporal service remains development SQLite, untrusted Linux execution and production storage,
upgrades, TLS/ACLs, retention, scaling and real-provider quality remain unqualified.


## Local outcome and limits

Five integrated scenarios pass: recovery, cancellation before write, cancellation while unknown,
corrupt receipt rejection, and publication acknowledgement loss. Three additional real engine-ID
collision tests reject unrelated scope/type/queue without acknowledgement or effects. The recovery
case counts all five POSTs independently, one write and one reconciliation lookup; successful
publication records 11 fixture units. Unknown cancellation records eight spent, zero reserved and
no final model/artifact. Corruption retains six spent/two reserved and an open Task after engine failure.
The scope collision additionally starts a live Worker: its independent start-identity activity
fails before any product claim/model/tool action. Dispatcher-only rejection was insufficient and
the original worker-absent collision test did not establish consumer safety.
The actual PostgreSQL suite passes 141 checks including 22 new handoff tests. Focused reference-port
regressions additionally check numeric intent canonicalization, receipt size, overlapping reconciliation,
publication revision conflicts and idempotent closed-task confirmation.

Review corrected several seams before acceptance: Python equality alone cannot bind immutable
JSON intent (7 differs canonically from 7.0); a malformed or oversized POST receipt must become
unknown; another activity can resolve between reading admitted and marking unknown; a late audit
revision is retriable without relaxing authority conflicts; after a completion commit an activity
retry verifies the same digest and bytes without reacquiring closed authority. Temporal still owns
those retries. No custom checkpoint format or second recovery loop was introduced.

This reference has one configured Task per worker queue and a bounded, one-shot acceptance drain.
It is not a production dispatcher. Reconciliation failure leaves an explicit unresolved business Task;
operator recovery, retention limits and production history/authority consistency still require design.
HTTP reconnect is tested, not browser/SSE reconnect. Real provider quality and Linux effect isolation
remain open. The final engine decision still requires production persistence/upgrade/restore evidence.
