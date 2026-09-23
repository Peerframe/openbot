# Work execution target contract

[English](WORK_EXECUTION_CONTRACT.md) · [简体中文](WORK_EXECUTION_CONTRACT.zh-CN.md)

Status: design contract, 2026-09-23; not an implemented API or schema. This refines the
[approved delivery plan](ARCHITECTURE_MIGRATION_PLAN.md), rather than creating another roadmap.
The [durability experiment](../experiments/durable-execution/README.md) supplies narrow evidence;
[Temporal is selected as the target recovery owner](decisions/0046-temporal-as-recovery-owner.md),
while product integration and production activation remain open.

## Identity and ownership

| Record | Meaning and lifetime | Authority |
| --- | --- | --- |
| Bot | Persistent colleague identity, reviewed knowledge and configuration | Control service |
| Task | A user objective, scope, budget, supervision and verified results; survives chat/worker/model changes | Control service |
| Run | One admitted attempt at a Task, with pinned policy/strategy/configuration references | Control service; engine schedules segments |
| Runtime segment | A bounded strategy invocation yielding a checkpoint, proposed action, wait or provisional result | Runtime proposes; control validates |
| Action | A stable logical external operation, immutable intent and its observed outcome | Control admits; scoped executor reports evidence |
| Artifact | Independently addressable content, digest, provenance and access scope | File service plus control registration |

An engine retry or worker replacement does not create another product Run by itself. An explicit
retry with a changed strategy may create a new Run under the same Task. An Action identifier is
stable for the same intended effect across transport retries/recovery; redoing an operation
intentionally requires a new Action and authorization. A model-generated tool-call ID is only
correlation. Changing a chat layout or closing the client cannot change any of these identities.
Existing legacy Run records must be migrated with explicit provenance; do not assert that every
old message was a Task or rewrite SQL history to make it look so.

## One owner of continuation

The selected durable engine owns scheduling, durable waits and segment retry/continuation.
The control service admits transitions and persists domain facts. It must not run a second polling
loop that independently retries those same segments. The Runtime must not retry a side effect
behind the control service. Executor transport retries follow an Action's explicit policy.

Do not put an entire indefinite Agent/tool loop inside one retryable activity/step. A segment
must expose enough validated state to resume without recharging a completed model call or
repeating completed actions: input/context references, strategy/schema versions, model observations,
consumed corrections, skill/memory versions, action references and provisional artifacts. The
exact mature SDK continuation API must be reviewed and tested before fixing a checkpoint format.
Approval waits must not require keeping a Runtime process alive. Engine success is not Task
success: a segment can succeed while the Task waits for approval or reconciliation.

## Admission, results and uncertainty

Before dispatch, persist the immutable Action intent, scoped authority, target/content digest,
approval reference when required, budget reservation and attempt ownership. Approval is bound to
that exact intent and expires or becomes invalid when the relevant inputs or authority change.
A refreshed user instruction must not silently reuse approval for an older target/content.

Separate not-dispatched, dispatch-admitted, confirmed-applied, confirmed-not-applied and unknown
outcomes. A committed intent is not proof of dispatch or non-dispatch. A process exit, timeout,
lease expiry, cancelled request or missing receipt is not proof that the external effect failed.
For an unknown outcome, use adapter-supported authoritative lookup or a verifiable receipt.
If neither proves the result, keep the Task unresolved and request bounded human reconciliation.
An idempotency key helps only when the destination actually enforces the promised scope/lifetime.

Attempt leases need monotonic fencing and conditional commits, not only a time-to-live. A stale
worker cannot register a final result or spend fresh budget. Fencing prevents external stale writes
only when the executor/destination enforces it; do not claim it retroactively undoes an HTTP call.
Admission and revocation must have a documented serialization point. Already-admitted/in-flight
actions may have effects after a user presses stop: preserve their receipts and report uncertainty.
Cancellation stops new admission and requests execution abort; it is not rollback.

Reserve shared Task budget before model/tool admission and settle it from verified usage. Engine
replay reuses the recorded reservation/outcome. Unknown billed usage remains reserved pending
reconciliation; do not refund it and let sibling Runs spend it again. Runtime, worker and model
cannot grant budget or overwrite recorded usage.

## Completion and client projections

Complete a Task only when required work is verified, all required actions are resolved, artifacts
exist with checked content/digests and current access, and final publication commits with the
relevant domain revision/audit. A model's final text is a proposal. Partial completion, failed
execution, cancelled admission and uncertain effects remain distinct visible outcomes.

The client receives versioned projections and can fetch a consistent snapshot after reconnect.
Events are hints/deltas with an explicit ordering/recovery contract; duplicate or missing delivery
must not create another authority. Web, Desktop and headless clients use the same commands.
User-visible phase names explain work and required intervention, not internal engine objects.

## Next integrated acceptance journey

A user submits a small CSV correction task. The Bot reads rows, checks a loopback business fixture,
prepares a specific record update and output file, then waits for approval. Close the client and
kill the Runtime/control worker. Persist approval while no Runtime is running; reconnect and show
the same Task. Revoke authority in a separate case and prove no new admission. In the approved
case, kill after the external update but before receipt storage, then recover and reconcile without
another update. Verify the output file, shared budget, audit and final status through the public API.
Include the control-domain/engine enqueue gap, concurrent budget reservations, lost billing receipts
and artifact-registration failure. Unknown outcomes need a verified resolution path, not permanent
parking. Repeat a real network-partition stale-worker race and a workflow-code upgrade before selecting
an engine. Only synthetic fixture data is authorized for this qualification.

This journey precedes broad API translation. It does not replace later real-model, browser,
execution-isolation, data-upgrade/restore, teaching and contributor acceptance.
