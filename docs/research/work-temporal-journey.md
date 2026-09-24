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

### Implemented and checked in the next S3 candidate

The additive `0032_work_submission_attempt_id` migration preserves historical NULL rows. Control
now generates `secrets.token_hex(16)` inside the winning reservation transaction and returns a
typed result with the persisted ID. A losing caller can inspect that original ID but cannot
start. The trusted Temporal adapter sends it in the exact start input; the dispatcher compares
the immutable start event before acknowledgement, and the handoff store compares it again under
the Task/Run row locks. An old NULL attempt stays unresolved and cannot be backfilled. Neither
the attempt ID nor any authority grant appears in the public audit event.

The initial dsh candidate could not run tests in its nested sandbox. Independent Codex review
found that the fixed reference Worker discarded the attempt ID before its first control activity,
and an existing offline test double still returned the old boolean type. Codex corrected both and
added a real wrong-attempt Worker collision case. On the integrated candidate, 48 focused
dispatcher/Temporal tests and 14 offline reference tests passed; the owned PostgreSQL/HTTP control
fixture passed 258 checks. A disposable real Temporal development-server probe passed five
handoff cases, including a same-Task/Run/type/queue but wrong-attempt collision with zero
model/tool attempts. Its recovery case completed with one synthetic external write and one
authoritative lookup. `npm run check` passed: 29/31 Turbo lint/typecheck/test tasks and all 18
build tasks hit cache, while repository prerequisites ran. No production Worker, multi-Run
recovery, untrusted Linux isolation or default dispatch was qualified by these checks.

## Derive activity binding from the current engine run (2026-09-24)

The next Worker boundary must not accept a first Run ID supplied as workflow input. In the pinned
Temporal Python SDK 1.33.0 (`ab52fdde33ee8ed193402625bfdba25d240a762d`),
[`activity.Info`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/activity.py)
contains the actual namespace, task queue, Workflow ID/type and current Workflow Run ID, but not
the first execution Run ID. The pinned client's
[`get_workflow_handle(workflow_id, run_id=...)`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/client/_client.py)
binds calls to that specific Run. Its first `WorkflowExecutionStarted` history event contains
`first_execution_run_id` and start input; the official
[Workflow identity contract](https://docs.temporal.io/workflow-execution/workflowid-runid)
defines the former as the chain identity across Continue-As-New and distinguishes a Reset.

Decision: a trusted control activity should obtain current-run identity from `activity.info()`,
inspect the start event of that **exact** Run through the released SDK, and then compare the
result with the durable Task/Run, attempt ID, accepted Workflow reference and first Run ID under
the existing read-only control gate. A missing run ID, unavailable history, malformed event,
wrong start input or mismatched chain fails closed. These facts are correlation evidence only;
each model/tool effect still needs its own current authority, budget, claim and reconciliation
policy. The narrow local gap is this adapter and its verification, not a second scheduler or
new protocol. No upstream code is copied.

### Activity adapter evidence (2026-09-24)

The next candidate adds `work_temporal_activity.bind_current_activity`: inside a trusted
Temporal activity it reads `activity.info()`, opens the **exact current Run** history and
validates the immutable start type, queue and `{taskId,runId,attemptId}` before applying the
read-only PostgreSQL acceptance gate. The activity queue and start queue remain separate facts;
both must match trusted composition. The accepted result is correlation only, never effect
authority. `TemporalEnginePort.inspect_start(..., run_id=...)` adds exact-run lookup without
changing the dispatcher's existing latest-run inspection on redelivery.

Independent checks on the integrated candidate: the owned PostgreSQL/HTTP control fixture ran
274 checks with one optional-SDK test file skipped by the default interpreter; the **same owned
fixture** then ran all 32 adapter tests through the separately pinned Temporal SDK interpreter.
A disposable real Temporal development-server probe ran the adapter from an actual activity,
verified the SDK's current Run ID resolved to that Run's immutable start event and matched its
first Run ID. Earlier probe-only workflow sandbox import errors were corrected in the disposable
harness; they did not change product code. The SDK unit suite in isolation ran 43 checks and
skipped its fixture-dependent case. Logs are under `/private/tmp/openbot-s3-activity-*20260924*.log`.
This does not qualify a production Worker, multi-Run continuation or effect recovery.

## Bind a control claim to the current engine activity (2026-09-24)

The pinned Temporal SDK activity identity and exact-run history contract above have already
been reviewed and verified against a real development server. The existing control-owned
`work_claims.claim` transaction refuses closed/revoked Tasks, advances a per-Run execution epoch
and returns a fence. The next narrow integration can call it only **after**
`bind_current_activity` verifies the acknowledged Task/Run, immutable submission attempt and
first engine Run ID. Derive a stable, bounded claim identifier from the trusted namespace,
Workflow ID and actual current engine Run ID with a domain-separated SHA-256 digest; do not
accept a claim ID or identity from workflow, model or HTTP input. A redelivery of the same live
engine Run may retrieve its existing fence; expiry, cancellation and revocation must remain
closed rather than minting a new claim. The claim is control-owned authority; the prior binding
record alone remains correlation evidence. No upstream code is copied, no new dependency is
needed, and this does not by itself authorize or retry any external effect.

### Claim-boundary candidate and verification

`claim_current_activity` now uses the actual activity binding above, derives a domain-separated
claim ID from the accepted namespace/Workflow ID/current engine Run ID and calls the existing
control-owned `work_claims.claim` transaction. The same live Run receives the same fence; a
new Run in the accepted chain advances the epoch and stales the old fence. No claim is created
for a wrong attempt, an unacknowledged start, a closed Run, cancellation, revocation or an
expired same-Run claim. A separate cancellation/revocation race test closes the gap between
read-only binding and claim: the claim transaction rechecks authority after the binding lock is
released. The dsh implementation ran no tests because its nested command sandbox failed; Codex
independently inspected and tested the integrated code. On the final candidate, the owned
PostgreSQL/HTTP suite passed 274 checks with one optional-SDK skip, then the same fixture and
pinned Temporal interpreter passed 44 adapter checks. The real Temporal SDK identity probe from
the preceding section covers SDK facts, but these new claim tests use scripted engine history;
no production Worker or real multi-Run recovery is qualified by them.

## Refine claim identity to one Temporal activity (2026-09-24)

The prior `13fb278` claim ID keyed only namespace/Workflow ID/current engine Run ID. That is too
coarse for a long-running Workflow: all model/tool/control activities in one Run share one
60-second control claim, so a later independent activity cannot advance after that claim expires.
The pinned Temporal Python SDK 1.33.0
[`activity.Info`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/activity.py)
exposes `activity_id` separately from `attempt` and Workflow Run ID. The official
[Activity Execution lifecycle](https://docs.temporal.io/activity-execution#activity-id) defines
the ID for an Activity Execution and notes that an ID can be reused after an earlier activity
closes; the [Python error-handling guidance](https://docs.temporal.io/develop/python/best-practices/error-handling)
recommends Workflow Run ID plus Activity ID for activity idempotency. A disposable real Temporal
1.32.0 / SDK 1.33.0 probe observed the same activity ID on attempts 1 and 2, then a distinct
ID for the next activity in the same Workflow Run. The probe used generated IDs; reused custom
IDs must fail closed rather than silently mint a second claim. The exact log is
`/private/tmp/openbot-activity-id-probe-20260924.log`.

Decision: derive a new versioned control claim ID from the accepted namespace, Workflow ID,
current engine Run ID **and actual SDK Activity ID**, never the retry attempt or workflow/model
input. A retry of the same live activity addresses its existing fence; the next activity can
advance the epoch and stale prior work, even in the same Workflow Run. A repeated Activity ID
after closure may conservatively collide and refuse; production Worker composition must use
unique generated activity IDs. This still does not authorize effect replay: an unknown action
must be reconciled before a later activity executes an effect. No dependency or scheduler is
added, and the existing claim transaction remains the only fence issuer.

### Per-activity claim correction and acceptance

The integrated candidate changes the domain and prefix to `work-claim-v2-` because the hash
material changed. The public read-only `bind_current_activity` still reads its own SDK context;
only a private helper shares one immutable SDK info snapshot with `claim_current_activity`.
The claim uses the actual Activity ID as well as namespace, Workflow ID and current engine Run
ID. It deliberately excludes `attempt`. A next generated Activity ID in the same engine Run
advances the control epoch and makes the prior fence stale; an expired retry/reused ID stays
closed. The caller cannot pass an SDK info snapshot to the authority-bearing entry point.

On the integrated code, the owned PostgreSQL/HTTP fixture passed 274 checks with one optional
SDK-file skip, then the same fixture with the pinned SDK interpreter passed 63 activity/claim
checks, including the cancellation/revocation race. The disposable real Temporal probe above
verified stable ID across one retry and a distinct next generated ID. These checks do not prove
that an effectful production Worker uses unique generated IDs, persists per-effect outcomes or
resumes multi-Run tasks after a crash; those remain activation gates.

## Control-side effect execution and readback seam (2026-09-24)

The work store already owns the immutable Action intent/approval/budget transactions
(`propose`, `admit`, `uncertain`, `resolve`) and the reconciliation path owns owner lookups, but
no control-side seam sequenced one external write after a **new** admission and then recovered an
uncertain write without replaying it. That narrow gap is filled in
`apps/server-python/src/openbot_server/work_effects.py`; it adds no scheduler, broker, migration
or dependency and reuses the pinned PostgreSQL 17 row-lock semantics plus the already-reviewed
`WorkFence`/`PostgresWorkStore` transactions. No upstream source is copied.

`execute_action` accepts only trusted composition inputs (Task/Run, existing control fence,
immutable key/intent/policy, adapter, verifier). It calls the existing `propose` then `admit`, and
invokes the adapter's `apply` only when `admit` reports a new admission. Because
`work_actions.status` never returns to `proposed`, a crash between admit and apply, a lost
response, a verifier failure or a restarted attempt can only reach an authoritative `lookup`; a
second `apply` is impossible for that Action. An absent, empty, malformed or untrusted receipt
leaves the Action `unknown` through `uncertain` — never refunded or replaced. `resolve` receives
bounded `actual_tokens` and receipt evidence only from a `VerifiedOutcome` re-checked against the
exact actionId, Task/Run and intent digest, so a Worker/model report is never forwarded there.
`recover_action` is the separate effect-free readback for an existing admitted/unknown Action and
stays valid after cancellation or revocation; it never calls `apply`, `propose`, `admit` or mints
a fence. `CancelledError` always propagates, and a pending-approval Action is refused by `admit`
before any effect.

`apps/server-python/tests/test_work_effects_postgres.py` pins the failing counterexample first: a
logical write commits while its response is lost, a retry must settle the Action from lookup with
exactly one `apply`, an absent lookup stays unknown without a refund, a changed intent under the
same key is rejected, a pending approval never executes, and a post-cancel/revoke readback records
truth without a new admission or fence. The bounded dsh implementer could not execute shell
commands in its sandbox. Codex independently added the test to the owned fixture runner, corrected
a concurrent-resolution return value that could falsely report `unknown`, and added the actual
admit-before-apply crash counterexample. The first PostgreSQL/HTTP control run passed 296 checks
with one optional Temporal-SDK skip; after review, the same entry passed 298 checks with one SDK
skip. These are actual fixture executions on an uncommitted candidate, not proof of a production
Worker, real external service, multi-Run recovery, schema migration or default activation. An
adapter that verifies a negative outcome must prove external finality, not merely an empty read at
one instant; this generic seam does not supply that provider-specific proof.

Independent follow-up: the control seam now refuses a lookup value that cannot be represented as
bounded canonical JSON before the trusted verifier sees it; transport adapters must still limit
their own network reads. An owned PostgreSQL/HTTP counterexample supplies an oversized external
record to an otherwise permissive verifier and proves it remains `unknown` with the reservation
retained. The final control entry passed 299 checks with one optional-SDK skip; `npm run check`
passed, with its Turbo lint/typecheck/test/build task output served from cache.

## One constructor-time Agent across two concurrent Runs (2026-09-24, revision 2)

The [disposable probe](../../experiments/work-journey/multirun_port_probe.py) asks whether one
Agent built once **before** Worker startup can serve two concurrent Workflows with separate Run
inputs. It requires a disposable Temporal frontend address via `--address` and pins the SDK
versions at startup. Reviewed pins are unchanged:
pydantic-ai-slim 2.47.0 (`77d5fce751ab8ab04bd5db4ed6acc1131a4baed6`) and Temporal Python 1.33.0
(`ab52fdde33ee8ed193402625bfdba25d240a762d`), against the disposable Temporal CLI 1.9.1 / Server
1.32.0 profile. Reviewed public surface: `Agent(model, deps_type, toolsets, capabilities,
output_type, instructions, retries)` and `Agent.run(user_prompt, *, deps, message_history,
usage_limits, ...)` (`apps/agent-runtime-python/RESEARCH.md` §2); `Model.request`;
`AbstractToolset.get_tools`/`call_tool`; `DynamicToolset(id=...)`;
`TemporalDurability(activity_config, model_activity_config)`; `PydanticAIPlugin`; and the workflow
registration `__pydantic_ai_agents__` already exercised in
`experiments/work-journey/workflow_worker.py`. The upstream
[`ResolveModelId` capability](https://github.com/pydantic/pydantic-ai/blob/main/pydantic_ai_slim/pydantic_ai/capabilities/resolve_model_id.py)
was reviewed as the per-Run model-selection mechanism; its public resolver signature is
`(ModelResolutionContext, model_id) -> Model | None`. The
[official Temporal integration guide](https://github.com/pydantic/pydantic-ai/blob/main/docs/durable_execution/temporal.md#toolsets-at-runtime)
still requires executing toolsets to be attached at Agent construction with a stable dynamic-toolset
ID.

The first probe revision failed before any Workflow started: the Worker's workflow validation raised
`RuntimeError: Failed validating workflow MultirunPortProbeWorkflow`, and the sandbox reported
`__call__ on pathlib.Path.resolve restricted`. That revision computed its repository root with
`pathlib.Path(__file__).resolve()` at import. Revision 2 computes the same location with pure
`Path.parents` and imports the OpenBot runtime inside `workflow.unsafe.imports_passed_through()`,
the reviewed composition already used by `workflow_worker.py`; the workflow sandbox is not disabled.

The more serious rejection was design, not syntax. Revision 1 kept a `_RUNS` dictionary of mutable
`RunGuard`/`PortModel`/`PortToolset` state and selected a Run from a prompt marker or a bounded
`model_settings` value. That is global Run state: it would not survive a Worker restart or a second
process, so it could not be presented as a production-feasible per-Run boundary. It is removed.
Revision 2 builds exactly one Agent at import with the constructor-time
`DynamicToolset(id='openbot-ports')` and the public `ResolveModelId` capability. Each model activity
resolves its `PortModel` from the serialized `RunDeps.label` through
`ResolveModelId(ctx, model_id)`; each tool activity builds its `PortToolset` from `RunContext.deps`.
Every activity builds a fresh `RunGuard`/`ToolCatalog`/`RuntimeLimits`, so no guard or port is
shared between Runs or between activities. The scripted model derives its behavior from the message
history it receives, so an activity retry re-derives the same step instead of reading a
process-local counter.

A bounded, label-keyed observation log records what each scripted port saw, so a separate trusted
activity can read it back independently of the Workflow result. It is measurement-only: it never
selects a model/toolset and never authorizes an effect, and the authority port returns success
regardless of it. Both Workflows are started before either result is awaited. The parent asserts
that the measured tool-activity intervals actually overlap, plus label-scoped outputs,
per-label observation entries with no crossed
label, per-activity guard evidence (each model activity one fresh guard step, each tool activity one
call), and each real history's completed `model_request`/`call_tool`/`get_tools` activities;
`call_tool` must be exactly one, so a model-visible answer without a durable tool activity cannot
pass. No provider, PostgreSQL, credential, real tool or external effect is used, and the script
neither starts nor installs a server.

Known limitation and exact review bound: whole-Run guard counters are **not** proven durable by this
probe, because each activity owns a fresh guard; a control-owned, durable budget must supply those
counters before production use. The bounded dsh sandbox could not run nested shell commands. Codex
then ran the revised candidate in an owned disposable Temporal environment with
`pydantic-ai-slim==2.47.0`, `temporalio==1.33.0`, Temporal CLI 1.9.1 and Server 1.32.0. The
independent run exited 0 and reported `PASS`; the retained log is
`/private/tmp/openbot-s3-multirun-probe-overlap-20260924.log`. Each Run's real history contained two
completed `get_tools`, two `model_request`, and one `call_tool` activities. The measured tool
intervals overlapped: Run A entered at `1012867.185719666` and exited at `1012867.78686975`;
Run B entered at `1012867.186391333` and exited at `1012867.787048791` (monotonic seconds in
the same Worker process). This is evidence from the actual pinned SDK path, not an inferred API
shape. The only stderr was a Temporal warning that `annotated_types` imported after initial
workflow load; no workflow or activity failed.

This pass establishes that one constructor-time Agent can serve two concurrent Workflows with
separated serializable Run deps, per-activity state and port logs, and that tool I/O runs as durable
activities rather than inline workflow code. It does not establish crash/replay recovery, durable
authorization or budget persistence, multi-Run continuation, Continue-As-New, effect idempotency,
or production Worker composition.

## Activity-to-Action effect seam (2026-09-24)

`apps/server-python/src/openbot_server/work_temporal_effect.py` is the narrow composition a future
Worker activity calls. It reads exactly one `temporalio.activity.info()` snapshot through the
existing `_bind_activity_identity` helper, refuses a wrong or missing queue/type/attempt/chain,
Activity ID or history and a canceled/revoked Task before the policy, then asks an injected trusted
`ControlPolicy` to turn a bounded, detached `ToolRequest` copy into one exact `ActionPlan`. Only a
valid plan reaches `_claim_bound_activity`, which derives the same activity-scoped claim ID and calls
the existing control claim transaction; the plan then goes to `work_effects.execute_action`, whose
`propose`/`admit` transactions still decide and a pending approval still yields no external apply.
The model/tool `call_id` is bounded transport metadata only: the policy never sees it, it is never
the Action key, and a plan that equals it is refused. A same-Activity-ID retry reuses its fence, a new Activity ID
advances the epoch, a lost response is settled by the existing lookup/verify path without a second
apply, and a cancellation or revocation during the policy still mints no fence. The refactor keeps
`claim_current_activity` behavior by delegating to the same one-snapshot helpers.

Explicit limits: this is not a Worker service, not a durable whole-Run budget and not an OS sandbox;
it keeps no process-global Run registry or credentials. The bounded dsh implementer could not run
shell commands because its nested sandbox backend failed. Codex then removed the model-supplied
`call_id` from the trusted policy input, kept the two-step bind/claim helpers private, and wired
the new cases into the existing owned PostgreSQL fixture runner. On the integrated candidate,
`node scripts/test-python-control.mjs` exited 0: the default control interpreter recorded
299 passed and two optional-SDK skips; the separately pinned Temporal SDK 1.33.0 interpreter,
with the same server dependencies, recorded 95 passed including 32 new seam cases. The retained
log is `/private/tmp/openbot-s3-bound-effect-owned-20260924.log`. These checks use the real
control PostgreSQL store and a fake SDK context/history for this seam; prior probes establish the
real SDK activity context separately, but this change has not yet run inside a real product Worker.
The replay guarantee remains scoped to a stable Action key. A future production policy must
derive that key from a durable control/workflow operation fact and demonstrate the same key after
a distinct Activity or Worker restart; these fixture tests use a fixed trusted policy and do not
prove that future binding. No upstream source is copied and no dependency was added.


## Real-engine Activity-to-Action reference (2026-09-24)

Candidate: parent `e176e90`, the four `experiments/work-journey/` files in this
commit. dsh implemented in `/private/tmp/openbot-dsh-s3-real-effect-20260924`;
Codex reviewed and corrected the candidate before independent acceptance. The
integrated files match the tested copy byte for byte (SHA-256):

| File | SHA-256 |
| --- | --- |
| `control.py` | `48f68d06de50cc878f92f2d7538540404fecfc47a0c4dcd8face893460e2e3d3` |
| `deliver_repair.py` | `d385b87008e10511a7d2ce089b8b640fd20df055f8610325d0748a23485a6231` |
| `test_control.py` | `4c4434a11c6cee9e02bd29526e3d7b9357f222135ccf5b28330aa33d23b76ef5` |
| `workflow_worker.py` | `3aab8c85a493722e0f06045a290bc080e4c9b938ad4f4ed59ad34581b1a467ea` |

The fixed reference now runs its reviewed write through the product
`execute_activity_action` seam using actual SDK activity/history identity. The
trusted policy owns the stable Action key; the adapter performs a POST only after
fresh admission, then requires authoritative lookup. Its old receipt verifier is
reused. Cancelled Tasks cannot claim again: a separate `recover_action` path can
only inspect an already admitted, exact-intent Action from the reference's trusted
Task/Run configuration. This is historical settlement, never a new grant.

The first real cancellation run failed with `admission_closed`; adding that
lookup-only path fixed it. The subsequent full run caught stale repair input
verification that omitted the persisted start attempt. Delivery now checks the
full accepted input and original engine Run chain, including after Task closure.
Neither fix relaxes unknown-result, cancellation, reservation or receipt checks.

Final actual runs in the isolated candidate:

- `/private/tmp/openbot-temporal-review/venv/bin/python -B -m unittest discover
  -s experiments/work-journey -p test_control.py -v`: 21 passed. Log:
  `/private/tmp/openbot-s3-real-effect-unit-final-20260924.log`.
- The same interpreter, `-B experiments/work-journey/probe.py --temporal-cli
  /private/tmp/openbot-temporal-review/temporal`: 16 case records passed, real
  public HTTP/PostgreSQL/Temporal with synthetic external effects. It checks
  unknown results, malformed receipts, timeout, repair delivery, automatic/manual
  races, cancellation, closed-history repair, publication and rejected handoffs.
  Actual-history replay passed; deliberately incompatible replay was rejected.
  Log: `/private/tmp/openbot-s3-real-effect-full-dev-final-20260924.log`.
- Runtime versions: Temporal SDK 1.33.0, Pydantic AI 2.47.0, CLI 1.9.1,
  development Server 1.32.0. No live model or external account was used.

Failed runs remain in `/private/tmp/openbot-s3-real-effect-cancel-unknown-20260924.log`
and `/private/tmp/openbot-s3-real-effect-full-dev-20260924.log`. A broader 69-test
reference unit run passed on an earlier candidate; it is not substituted for the
final candidate's checks. dsh could not run local shell tests in its nested sandbox;
its delivery was accepted only after Codex's independent runs.

Not run on this candidate: PostgreSQL/mTLS engine, adjacent-release upgrade,
real Linux/runsc, or production Worker/Runtime composition. The adjacent-release
probe's held-publication lookup-count expectation also needs review before that
lane runs: the new product seam always verifies the POST via lookup. Earlier
engine-upgrade passes do not qualify this candidate. This is a fixed reference,
not the per-Run production Worker or a proof of general stable Action derivation.
No new dependency or copied upstream source; reuse decisions above remain valid.

Integrated-tree `npm run check` exited 0; repository prerequisite checks executed,
while both 31-task Turbo lanes and all 18 build tasks were cache hits. Log:
`/private/tmp/openbot-s3-real-effect-check-resume-20260924.log`. The unchanged
real-engine candidate evidence above was reused rather than rerun.


## Runtime-owned Temporal Agent composition (2026-09-24, implementation gate)

Continue the pinned 2.47.0/1.33.0 constructor-time composition reviewed and actually
exercised above. Move the shared Agent construction into an opt-in Runtime module;
the existing two-Run probe will call that same product builder. Trusted factories
receive only typed serializable deps, run only in real activities, create fresh
PortModel/PortToolset instances and refuse alternate model IDs. No registry,
prompt routing, new engine or new protocol. Default standalone dependencies stay
unchanged; this module requires the separately pinned Worker environment.

This builder does not replace BoundedExecutor: control/Workflow composition must
still supply accepted identity binding, durable admission/budgets, corrections,
final validation and publication. Runtime never grants any of those. Review uses
the existing OPEN_SOURCE_REUSE runtime-port entry and exact upstream pins above;
no source copying or additional dependency. dsh owns only temporal_agent.py and
its optional-SDK unit file in an isolated e07e858 worktree. Codex owns the probe
call-site change and independent real-engine/negative validation.

Independent acceptance caught two composition defects before integration. The real
engine failed during `_prepare_run`: the 2.47.0 resolver is also called in Workflow
bootstrap, not only inside the activity. The [official resolver guide](https://pydantic.dev/docs/ai/capabilities/resolve-model-id/)
and installed `durable_exec/_base.py` / `agent/__init__.py` confirm the two-pass
contract at pinned commit `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6` (the GitHub
file fetch was unavailable). The narrow adapter correction is an inert Model for
Workflow metadata; its request always refuses and it holds no ports/deps. Only
activity-side resolution may call the trusted port factory. Do not relax the host
factory gate or introduce provider fallback. Also, dict-only config copies retain
mutable RetryPolicy objects; clone nested configuration before SDK construction.
No upstream source is copied. New entrypoint and nested-mutation counterexamples
are required before accepting the correction.


### Accepted Runtime composition candidate (parent e07e858)

The final candidate was reviewed independently by `review_runtime_composition`:
no blocking finding within composition, replay, async or cross-Run boundaries.
dsh's two-file implementation completed with exit 0; its one forbidden nested
shell attempt failed and tests were explicitly NOT RUN. Codex owned the actual
entrypoint integration, counterexamples, correction and acceptance. No concurrent
implementer remained during those edits.

Candidate files were copied byte-for-byte into the integration tree after the
existing uncommitted probe was saved and both diffs reviewed. Code SHA-256:

- `apps/agent-runtime-python/src/openbot_agent_runtime/temporal_agent.py`: `0dc778548ca9f0cc0a885a5a5a7c8ba4b827ea03399f2c4c140b68db10a3927c`
- `apps/agent-runtime-python/tests/test_temporal_agent.py`: `dfbb73ad06ea6b64aa7894b3e4477be9507123e311ac505d6e06a77a41cd332f`
- `experiments/work-journey/multirun_port_probe.py`: `7a37118a242bc9ca3bedff7600361fd3831f7b955e6c0ed0dc60f443a6a3236a`

Actual execution evidence (Python3.12.13, Pydantic AI2.47.0, Temporal SDK1.33.0;
CLI1.9.1 / development Server1.32.0 for the engine):

- Pinned Python `-B -m pytest -q -p no:cacheprovider` on Runtime tests
  `test_temporal_agent.py`, `test_authority.py`, `test_lifecycle.py`,
  `test_sdk_hazard.py`, `test_journey.py`: 71 actual passes. Log:
  `/private/tmp/openbot-s3-compose-regression-final-20260924.log`.
- Pinned Python `-B experiments/work-journey/multirun_port_probe.py --address
  <owned-loopback-address> --namespace default --task-queue <unique-queue>`:
  both concurrent Runs passed, each with two model activities and one tool call;
  measured tool intervals overlap, outputs stay scoped. One uses sync factories,
  the other async. Actual histories replayed without factory/port work. Log:
  `/private/tmp/openbot-s3-compose-engine-final-20260924.log`; owned server log:
  `/private/tmp/openbot-s3-compose-engine-6510f9cd8753/server.log`. Service stopped.
- Default Runtime optional-only collection returned 5 (no runnable tests, Temporal
  absent), not a pass. The pinned optional checks above are explicitly added to
  the existing CI environment. Hosted CI is NOT RUN in this acceptance.

Failures retained: `openbot-s3-compose-engine-initial-20260924.log` (Workflow
bootstrap rejection, then bounded timeout), `openbot-s3-compose-negative-before-20260924.log`
(bootstrap and nested RetryPolicy mutation counterexamples), both under
`/private/tmp`. Corrected-only interim logs are not substituted for final results.
The first 34 supplied unit checks had passed despite the real-entrypoint defect.

These are real engine / synthetic host-port results, not real provider or Linux
isolation evidence. No whole-Run budget, Worker restart, general stable Action key,
correction/final validation or production publication qualification is implied.
The unchanged fixed-reference development-engine evidence at 6b9250a is reused;
PostgreSQL/mTLS and adjacent-release qualification remain open as recorded above.

Integrated-tree `npm run check` exited 0. Repository prerequisites actually ran;
Turbo lint/typecheck/test/build results were cached (see exact lane totals in
`/private/tmp/openbot-s3-compose-integration-check-20260924.log`). The accepted
three code files match the tested candidate byte-for-byte; unrelated dirty files
are preserved and excluded from this delivery.

## Runtime-backed public task journey (2026-09-24, implementation gate)

Connect the accepted Runtime builder to the existing public Task/approval/effect/
Artifact journey rather than maintaining another Agent construction. Reuse the
already-reviewed pinned SDK `ExternalToolset`, `DeferredToolRequests` and
`DeferredToolResults`; see [official deferred-tool documentation](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)
and [toolsets](https://pydantic.dev/docs/ai/tools-toolsets/toolsets/), checked against
installed 2.47.0 `toolsets/external.py` and the existing reference Worker. No new
package or copied source. ExternalToolset never executes its calls and its JSON
argument validator is permissive: proposals are untrusted and control must validate
again before approval/admission. Runtime descriptors use the existing bounded,
offline ToolCatalog; this does not turn proposals into authorization.

The narrow builder extension accepts optional deferred descriptors, adding only
the released external-tool wrapper/output type. Real model ports carry both inline
and deferred descriptors; inline PortToolset exposes only inline tools. Workflow
bootstrap remains inert. The reference's activity factories check typed Task/Run
identity against the product's accepted current engine binding before creating
ports. All model usage, effects, decisions, unknown-result reconciliation and final
publication continue through the existing control transactions. No new scheduler,
provider service, Task schema or default switch. Require the real public journey,
not only direct factory unit checks. This is a fixed scripted reference migration,
not proof that generic product Worker or real-model integration is complete.


### Runtime-backed journey candidate and preflight

Parent d6ee990. dsh S3-RUNTIME-DEFERRED completed in its isolated worktree with
exit 0; only temporal_agent.py and its unit file were changed. It reported two
unsuccessful nested shell attempts despite the task's known-tool warning; no test
execution is credited to that delivery. No worker remains writing those files.
Codex reproduced nested schema aliasing with a counterexample, then deep-copied
validated SDK declarations and clarified that call IDs are correlation only.

Independent preflight review (`review_runtime_composition`) accepted the final
extension and Worker/lookup-expectation changes before the expensive engine run.
Local results:

- Final optional Runtime suite: 48 actual passes, log
  `/private/tmp/openbot-s3-deferred-unit-final-20260924.log`. The failed mutation
  counterexample is retained at `/private/tmp/openbot-s3-deferred-nested-before-20260924.log`.
- Pinned Python `-B -m unittest discover -s experiments/work-journey -p 'test_*.py' -v`:
  75 actual passes, including new wrong-Run and before/after-call revocation checks.
  Log `/private/tmp/openbot-s3-runtime-journey-unit-initial-20260924.log`.
- Pinned Python `-B experiments/work-journey/probe.py --temporal-cli <CLI1.9.1>
  --only-case publication-ack`: actual public HTTP/PostgreSQL/Temporal case passed;
  three model charges plus the approved write total 11, no reservation remains,
  one write and one authoritative lookup; recovery after publication creates no
  second artifact. Log `/private/tmp/openbot-s3-runtime-public-entry-20260924.log`.
- `npm run check` exited 0. Repository prerequisites executed; both 31-task Turbo
  lanes and the 18-task build lane used cache. Log
  `/private/tmp/openbot-s3-runtime-journey-check-20260924.log`.

Frozen code hashes for the subsequent PostgreSQL/mTLS adjacent-release run are in
`/private/tmp/openbot-s3-runtime-journey-candidate-20260924.sha256`. Its result is
recorded separately below; preflight alone does not qualify upgrade or recovery.
The suite uses official 1.31.3 binaries over pinned fixture images and preserves
the prescribed 600-second healthy period before upgrading to 1.32.0. No production
namespace, live model credential or private runtime dataset is involved.


### Runtime-backed journey final engine acceptance

The frozen candidate passed the full PostgreSQL/mTLS adjacent-release run, exit 0:

```sh
/private/tmp/openbot-temporal-review/venv/bin/python -u -B experiments/work-journey/probe.py \
  --engine postgres-mtls \
  --upgrade-archive /private/tmp/openbot-temporal-postgres-review/upgrade-1.31.3/temporal_1.31.3_linux_arm64.tar.gz
```

Actual log: `/private/tmp/openbot-s3-runtime-upgrade-final-20260924.log`.
It reports 20 public journey cases, in addition to engine/schema/mTLS assertions.
The 600-second old-release health gate completed on all four shards. Upgrade from
1.31.3 to 1.32.0 preserved namespace and schema history. Approval and publication
waits continued on both the original and restored engine volumes with their exact
engine Run identities; each completed with five charged attempts, one external
write and one authoritative lookup. The restored older history did not repeat
already-recorded product effects or artifact publication.

Unknown/corrupt/invalid-JSON results retained reservations until authoritative
repair; command timeout/redelivery and automatic-versus-manual repair races passed.
Cancellation and closed-engine repair did not start new writes. Replayed current
histories passed without changing product/effect state; deliberately incompatible
histories were rejected with NondeterminismError. Those expected negative replay
warnings are not operational test failures. Wrong scope/type/queue/attempt
handoffs made zero charged model/tool attempts. Engine assertions also covered
runtime schema permissions, invalid TLS peers, CA rotation, cold backup/restore,
server/database termination and incompatible schema rejection. All resources
were disposable fixtures; this is not production data migration or live-provider
acceptance, and it provides no Linux/runsc isolation evidence.

The following SHA-256 values were checked again after process exit and all matched:

| File | SHA-256 |
| --- | --- |
| `apps/agent-runtime-python/src/openbot_agent_runtime/temporal_agent.py` | `2d37eaf2985cdb34d9a0eb37218fe3d39ccbaf9092b535104fa972dad72f27e7` |
| `apps/agent-runtime-python/tests/test_temporal_agent.py` | `1955bb456ea0bb4795a6d40fc82a9dbb7d7f034752ba6cf0022728d2ef18a45f` |
| `experiments/work-journey/workflow_worker.py` | `a3387b052f00c9f2d13ae1c90ceb117d6df465e9f81181eb852b90ffd69f3a7f` |
| `experiments/work-journey/test_runtime_worker.py` | `382bf315cabbf2aa884440f210be666209be4f0f5f7a542bccd70df10ed5dca5` |
| `experiments/work-journey/probe.py` | `7eb7330647115b6a587f9b011711cf71bf568a962053993443cadd8947a2d589` |

The integrated reference is accepted at this scope. The reusable Runtime builder
is product code, but this scripted Worker still is not a generic production
Worker. It starts only after dispatch acknowledgement; a production Worker must
handle the acknowledgement race explicitly. General operation identities,
whole-Run continuation/corrections and production model/tool port assembly remain
open. No default backend switch, release or acceptance of TASK020 is implied.
