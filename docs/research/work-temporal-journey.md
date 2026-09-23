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
remain open. Production activation still requires persistence, upgrade and restore qualification.

## Product handoff attempt before external submission (2026-09-24)

The reference `dispatch.py` uses Temporal Python 1.33.0 `start_workflow` with
`WorkflowIDReusePolicy.REJECT_DUPLICATE` and verifies the immutable start event before recording
acceptance. The [official workflow identity contract](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx)
limits ID uniqueness to retained histories. A committed `work_admissions` row currently stays
`pending` until acceptance is acknowledged. If the enqueue response and acknowledgement are lost,
that row cannot distinguish “never submitted” from “submitted but not observed”; blindly starting
it again after history expiry could execute a second workflow.

Extend the existing admission row with a durable submission-attempt reference and timestamp under
the Task lock **before** the external request. `pending()` may return only never-attempted rows;
an attempted, unacknowledged row is an inspection obligation, including after cancellation. The
reference dispatcher queries its configured Task/Run directly so a bounded backlog cannot hide
that obligation. An identical repeat of the reservation never permits another `start_workflow`;
conflicting references
fail closed. A verified start event may be acknowledged later without restoring Task authority.
This uses the already-reviewed PostgreSQL 17 row locks/transactions and Temporal 1.33.0 protocol;
it adds no engine or retry scheduler and copies no upstream source. If a crash happens before the
request reaches Temporal, the conservative row remains unresolved until an explicit operator
resolution path proves it safe to continue. This is a necessary ingress safety step, not S3
production-dispatch acceptance or a claim of automatic recovery in every failure window.

The additive migration and control handoff ran in the real temporary PostgreSQL/HTTP fixture:
189 checks passed. The final reference unit suite passed 61 cases, including two focused dispatcher
cases proving that missing history and a lost reservation race do not call `start_workflow`.
The public API/Temporal recovery case and four handoff cases passed on both the development
engine and the PostgreSQL/mTLS engine. In the new crash-after-reservation-before-enqueue case,
redelivery left the Task queued and unconfirmed, found no engine history and made zero external
requests; it did not create a replacement workflow. The recovery case still made one actual
external write. These are synthetic effects, not a production dispatcher or real Linux isolation.
The full historical scenario matrix was not rerun after this change.

## Runtime tool port under TemporalDurability (2026-09-24)

The target uses pinned Pydantic AI 2.47.0 (`77d5fce751ab8ab04bd5db4ed6acc1131a4baed6`)
and Temporal Python 1.33.0. The [official Temporal integration guide](https://github.com/pydantic/pydantic-ai/blob/main/docs/durable_execution/temporal.md#toolsets-at-runtime)
requires executing toolsets to be attached when the agent is constructed, with a stable ID for
dynamic toolsets. Review of the installed 2.47.0 source showed that its durable leaf wrapping
recognizes `FunctionToolset`, `DynamicToolset` and `MCPToolset`; OpenBot's custom `PortToolset`
is an `AbstractToolset` and is not one of those wrapped kinds. The separate Runtime package can
run without `temporalio`, so the current subprocess path remains useful outside workflows.

A disposable real Temporal development-server probe used the existing OpenBot `PortModel`,
`PortToolset` and `RunGuard` with a scripted two-model-step, one-tool journey. Directly attaching
`PortToolset` returned the tool observation to the model and a final answer, yet history contained
only two `model_request` activities: **no tool activity**. The original trusted tool port recorded
zero calls, consistent with execution in the workflow sandbox copy. A successful answer was thus
not evidence of durable tool execution. Wrapping the same `PortToolset` in a constructor-time
`DynamicToolset(id='openbot-ports')` produced `get_tools`, `model_request`, `call_tool`, `get_tools`,
`model_request` activities; the trusted tool port recorded one call and the guard counted one.
The test used no provider, product database, real tool or external write.

Decision for the next integration: reject direct `PortToolset` use inside a Temporal workflow;
the durable worker must register the dynamic wrapper before starting and carry bounded Task/Run
identity in serializable dependencies. A global fake guard in this probe does not establish
multi-Run isolation, crash recovery, authorization, budget persistence or idempotency. Those
remain product acceptance gates; do not promote the probe's agent to the production dispatcher.

## Product control ingress reused by the real-engine reference (2026-09-24)

`apps/server-python/src/openbot_server/work_dispatcher.py` now owns one exact Task/Run handoff
decision using the existing `HandoffStore`. It reserves before the first engine start invocation,
inspects only after any prior attempt, and acknowledges only a start event with matching workflow
type, queue and exact Task/Run input. Its injected engine port must expose the actual namespace;
a mismatch is refused before any handoff or engine call. The reference dispatcher now supplies a
thin Temporal Python 1.33.0 adapter and retains its crash barriers around those control facts.
This is an integration of the already-reviewed local reference, not an additional scheduler or
an upstream source copy. The production Temporal Worker and default dispatcher remain absent.

The pinned SDK builds one `StartWorkflowExecutionRequest` with a generated `request_id` before
calling its service client with `retry=True` (`temporalio/client/_impl.py`, SDK 1.33.0). Therefore
the control guarantee is **one high-level start invocation per reserved Run**, not one network
attempt. A later dispatcher delivery never constructs another start request for an unknown prior
attempt. Workflow-ID rejection and the SDK's same-request retry operate only within engine history
and retention; missing history remains unresolved rather than authorizing a replacement.

After namespace binding, the control decision passed 25 focused cases; the reference dispatcher
passed two offline regressions. The existing public HTTP + temporary PostgreSQL + real Temporal
development-server probe passed four handoff cases (history missing and scope/type/queue
collisions) and a full recovery case (five attempts, one external write, one lookup, 11 fixture
units, replay verified). The cancel-unknown case passed on the immediately preceding candidate
(four attempts, one historical write, one lookup, no final completion); it was not rerun for the
namespace-only check. These are synthetic services and a fixed reference strategy. They do not
establish production concurrency, real Runtime composition, Linux isolation or default activation.

## Product Temporal transport reused by the reference (2026-09-24)

The one-Run `TemporalEnginePort` now lives in `apps/server-python` and the real-engine reference
imports it instead of keeping a duplicate class. This is a thin adapter of the pinned Temporal
Python SDK 1.33.0 client; no upstream source was copied. It binds the client's actual namespace,
starts with `REJECT_DUPLICATE`, reads the first immutable start event, and leaves all admission
decisions to `dispatch_one`. Only a `NOT_FOUND` error from history fetching is treated as missing
history; transport errors and decoding failures propagate. The optional SDK is still installed
by the isolated reference requirements, not the default Python control environment. Production
worker installation, lifecycle, authentication and Runtime composition are still open.

On the final adapter candidate, 34 focused control/transport tests and two offline dispatcher
tests actually ran. The real public HTTP + temporary PostgreSQL + Temporal development-server
probe passed four handoff cases and one full recovery case before the final error-scope tightening;
that last change was exercised by the focused decoder-failure test, not another full probe.

## Bind the accepted engine run chain before worker execution (2026-09-24)

The product admission currently records a Temporal Workflow ID but no engine Run ID. The
[official identity contract](https://docs.temporal.io/workflow-execution/workflowid-runid)
distinguishes a Workflow ID from the Run ID of each execution and identifies a Continue-As-New
chain by its `first_execution_run_id`; Workflow ID rejection is limited by retained history.
The [official event reference](https://docs.temporal.io/references/events) records that first
Run ID on `WorkflowExecutionStarted`. In the pinned Temporal Python SDK 1.33.0, the start-event
protobuf and `workflow.info().first_execution_run_id` expose this field. A disposable local
Temporal Server 1.32.0 probe confirmed a first start event carried a nonempty
`first_execution_run_id` equal to `original_execution_run_id`, while the SDK's returned handle
had no bound Run ID. No upstream source is copied.

Decision: the dispatcher must persist the verified **first execution Run ID** together with the
acknowledged Workflow ID. A trusted worker activity must compare the same first Run ID supplied
by trusted workflow code from `workflow.info()` with the admission, and independently read its
current workflow Run ID from `activity.info()`. Once the chain is acknowledged, this admits its
Continue-As-New runs and rejects a later same-ID chain after retention. It does not yet prove an
initially unknown submission when its history expires before acknowledgement: a different
same-ID chain could be mistaken for the original. Before production Worker activation, bind a
durable submission-attempt nonce to immutable Temporal start facts and verify it on inspection,
or establish equivalent provenance. An old acknowledged row
without this new fact remains unusable for worker execution; ordinary inspection of current
same-ID history cannot prove it belongs to the original chain after retention, so automatic
redelivery cannot backfill it. A separately reviewed operator recovery path would need independent
historical proof. A Reset changes the chain's first Run ID
and therefore fails closed pending a separately reviewed recovery policy. The current Run ID is
correlation only; neither ID grants Task authority, a claim, or permission for model/tool effects.

The additive `0031_work_engine_chain` migration keeps older acknowledgements nullable but
constrains new values. Product `dispatch_one` now accepts only a matching start event with a
nonempty bounded first Run ID; `HandoffStore.acknowledge` writes the Workflow reference and first
Run ID atomically. Repeated identical acknowledgement is read-only. An older acknowledgement
with a missing first Run ID or missing submission fact cannot be automatically attached to
today's same-ID history. The new read-only `work_engine_binding` gate also requires an active
Task, an open Run, the exact acknowledged reference and the accepted first Run ID. This gate is
not yet wired into a production Worker and its returned record is not an authority token.

The dsh-produced initial binding candidate passed 226 owned PostgreSQL/HTTP control checks only
after Codex independently ran them. Codex then identified the Workflow ID retention gap, added
the chain fact and hardened the gate. The final owned PostgreSQL/HTTP control fixture passed 244
checks, including the added legacy-row regression. The normal Python control check separately
passed 840 checks with 245 PostgreSQL/optional-SDK checks skipped outside their owned fixture.
Focused dispatcher/Temporal-adapter tests passed 40 checks and the two offline dispatcher tests
passed. Four public HTTP/PostgreSQL/development-Temporal handoff cases and one recovery case
passed after the migration; the later probe revision independently verified that rejected
handoffs have no first Run ID and a successful acknowledgement stores the same Run ID as Temporal's
workflow description. The recovery case still performed one synthetic external write and one
lookup. No real product Worker, multi-Run continuation, untrusted Linux execution or default
switch was qualified by these tests.
The required `npm run check` passed after an initial sandbox-denied Turbo cache-log replay was
rerun with the required filesystem access; 29 of 31 Turbo lint/typecheck/test tasks and all 18
build tasks hit cache. Documentation, research, migration, security and other prerequisite checks
actually ran. No production data, external service or default dispatch was changed.

## Prove the one reserved start before initial acknowledgement (2026-09-24)

The remaining collision window is narrower than the acknowledged-chain problem: if the first
start response is unknown and its history expires before acknowledgement, a later same-ID chain
can match Task/Run, type and queue. A first Run ID read only from that later history does not
prove it was the reserved attempt. The [Temporal Python client documentation](https://github.com/temporalio/documentation/blob/main/docs/develop/python/client/temporal-client.mdx)
states that a start creates `WorkflowExecutionStarted` in history; the reviewed Python SDK
1.33.0 at commit `ab52fdde33ee8ed193402625bfdba25d240a762d` uses
[`Client.start_workflow`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/README.md)
passes a workflow argument. Our pinned adapter already decodes that start-event input. Reuse
those released primitives rather than adding a broker, scheduler or custom engine protocol.

Before the only start request, control should persist a fresh 128-bit random attempt identifier
with the submission reference in the same transaction. The trusted adapter must include it in
the immutable start input. Inspection must compare the exact stored attempt identifier, even
on an initially lost response, a duplicate-ID collision or redelivery after retention. A prior
reservation without that identifier must remain unknown and never be resent or backfilled from
current history. The identifier is correlation evidence, never authorization, and must not be
placed in public audit payloads. The existing first Run ID still binds the acknowledged chain.
The gap is OpenBot's SQL-to-Temporal handoff provenance; no upstream source is copied.

Verify with an owned PostgreSQL fixture, fake engine collision and lost-response cases, then
real Temporal start-history inspection. In particular a later same-ID history with matching
Task/Run/type/queue but a different attempt must stay unacknowledged with no model/tool action.
Historical admission rows without an attempt identifier remain fail-closed; no migration or
default-dispatch switch may silently grant them a fresh start.
