# Durable collaboration tree deadline

Reviewed before implementation, 2026-09-25. Root approved the narrow design and owns integration.
Reuses docs/research/python-work-collaboration.md and the existing Temporal Python 1.33.0 MIT,
Pydantic AI 2.47.0 MIT, PostgreSQL/Psycopg pins; no new dependencies, services, executors, or model-facing protocols.
No upstream code copied. Existing OpenBot MIT Workflow/Activity seams are locally extended.

Primary sources rechecked:
- https://docs.temporal.io/develop/python/workflows/timers: Workflow sleep is durable server
  timer state, survives Worker restarts, and does not keep a resident Activity.
- https://docs.temporal.io/develop/python/workflows/cancellation: cancellation follows asyncio
  task cancellation; cleanup can be shielded, and Activity cancellation depends on its type.
- https://github.com/temporalio/sdk-python#asyncio-and-determinism and #asyncio-cancellation:
  use workflow.wait instead of set-order-dependent asyncio.wait; cancelling an awaited timer
  cancels that timer; tasks must be awaited to finish their cleanup before finalization.
- Installed exact 1.33.0 workflow/_context.py and _asyncio.py: workflow.now returns recorded UTC,
  workflow.sleep uses Workflow timers, no-timeout wait_condition creates no timer, and patched
  gates replay-safe new commands. Existing project research retains release/tests/license review.

The root contract is the first run.claimed event of the exact root Work Run plus 300 seconds.
Do not start at child creation or refresh after corrections/restart. SQL lock_task already
verifies ancestry, root Work Run and stored deadlines; check_fence now independently checks
fresh tree deadline. Those are retained authority backstops, not replacements for a Workflow
alarm which interrupts idle/unknown/model waits without another business Activity.

Selected implementation: existing load_task records None or the validated absolute tree deadline.
A read-only, historical-accepted actual-SDK Activity exposes that same fact for roots that later
create children; no model/caller deadline/identity, no claim, no budget or receipt mutation.
A Workflow-local controller remains dormant without a tree/creation attempt. Before a start_task
or delegate_task proposal it performs short recorded reads and two-second durable waits until
SQL has committed a tree, independent of whether the creation response settled. It then arms
one sleep to the original absolute deadline. Race it with the main body using workflow.wait;
cancel and await both owned tasks before propagating a typed failure to the existing bounded
historical failure wrapper. The wrapper alone closes Task/descendants and preserves unknowns.

Commands require recorded collaborationProtocol=1 plus patched openbot-collaboration-deadline-v1.
Histories without the flag, and old flagged histories without the new patch marker, keep their
previous command sequence. Ordinary Tasks that never attempt collaboration have no deadline
polling or timer. No second executor, in-process scheduler, new Workflow or continuation owner.

Root owns actual mTLS execution/kill/replay qualification; packet tests distinguish real SQL/SDK
ActivityEnvironment from patched Workflow command tests. Read failure is fail-closed through
existing bounded Activity retry/failure finalization, not an extension of tree lifetime.

## Validation and integration boundary

2026-09-25: 113 passed: 32 new deadline tests (14 PostgreSQL/actual ActivityEnvironment,
18 Workflow command/unit), plus 81 existing collaboration/Workflow/failure tests. No model,
provider, or account requests. The assigned disposable database was canonically migrated to
journal 40 before testing. Current actual-SDK binding, wrong scope/accepted chain, malformed
input, first exact-root-Run claim, child equality, original deadline after reclaim, cancelled
and expired historical observations, stored deadline corruption, and committed creation with
no ToolResults receipt were exercised against real PostgreSQL.

An additional 4 actual Temporal SDK Replayer checks passed over root's retained synthetic mTLS
histories: 3 collaboration runs (including SQL commit/Worker termination/original lookup,
delegate and final child barrier) and 1 failure-finalization run. These already contained
collaborationProtocol=1 and the failure wrapper, but no deadline patch marker. Replay emitted
no new deadline commands. One existing sandbox import warning for annotated_types occurred;
there was no replay failure. Histories are external disposable evidence and are not copied
into repository fixtures. The opt-in test accepts paths via an environment variable.

New timer races use explicitly labelled command/unit tests; the packet does not claim real
Server firing/Worker restart behavior for new timer histories. Root owns that final composed
mTLS qualification. The unit cases prove cancellation cleanup precedes one finalizer, both
normal/corrected creation paths arm before preparation, idle body cancellation, original-time
arming after commit without acknowledgement, no ordinary-task polling, and old-path gating.
The existing failure tests also cover retained unknown reservations and descendant closure.

No shared SQL/helper/failure-finalizer source was changed. Historical deadline reads grant no
new effect authority; fresh SQL check_fence/check_deadline remain authoritative, including
when a creation observation takes one short poll interval or the timer Worker is unavailable.


## Actual composed acceptance, 2026-09-25

The final PostgreSQL/mTLS expiry journey used the unchanged original 300-second root
claim deadline. Child creation committed while its parent observation remained unknown.
The parent failed once without resending its model request or releasing the unknown Action.
The actual parent history contains TimerStarted event 69 (292.332349 remaining seconds) and
TimerFired event 1577. Both parent/child histories replayed successfully. The probe now asserts
that long timer pair directly, in addition to the SQL first-claim-to-failure interval.

The separate Owner cancellation journey stopped active authority for the parent and child
after child SQL commit but before its acknowledgement; it did not start the child Workflow.
The parent remains open with cancelRequested and inactive authority because its original
unknown Action still requires lookup. This is preserved reconciliation, not a completed
cancellation claim. Original history replay passed with no model resend. Public bounded
results are in experiments/work-journey/evidence/product-{expiry,cancel}.json; full histories,
credentials and private fixture paths remain outside the repository.
