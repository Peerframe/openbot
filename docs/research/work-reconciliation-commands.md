# Research: control-owned reconciliation commands

- Status: implementation qualification; not production dispatch acceptance
- Date: 2026-09-23
- Owner: Codex; independent review of engine semantics
- Acceptance journey: repair a receipt lookup after bounded failure, request reconciliation via the
  authenticated public API while the worker is absent, survive delivery acknowledgement loss, and
  finish the same Task/Run without replaying its write or refunding unknown spend.
- Security boundary: an Owner request authorizes a bounded lookup, never an outcome, new external
  mutation or execution grant. Only an independently verified receipt settles the existing Action.

## Search evidence

Reviewed existing work-domain, public-work, Temporal transport/history and upgrade reuse entries.
GitHub searches: `temporalio/sdk-python signal wait_condition activity error 1.33.0` and
`temporalio/sdk-python issues signal duplication reset workflow` (2026-09-23).
Primary documentation: https://docs.temporal.io/develop/python/workflows/message-passing and
https://docs.temporal.io/cli/command-reference/workflow (reset).
Installed SDK source: temporalio/client/_workflow.py, workflow/_context.py, exceptions.py.
Pinned source: https://github.com/temporalio/sdk-python/tree/ab52fdde33ee8ed193402625bfdba25d240a762d
Reviewed release/issues: https://github.com/temporalio/sdk-python/releases/tag/1.33.0 and
https://github.com/temporalio/sdk-python/issues (including signal cancellation / cold-handler
reports). The implementation uses a synchronous wakeup handler, not an async mutating handler or
experimental signal-with-start. Existing SDK test/replay evidence remains applicable; real repair
and duplicate-delivery cases must now be added.

## Candidate comparison

| Candidate | Exact release | License / boundary | Decision |
| --- | --- | --- | --- |
| Temporal signal + durable wait_condition + activities | Python1.33.0, ab52fdde33ee8ed193402625bfdba25d240a762d; Server1.32.0, d94e34a1ebba5410a2e7d07119a76896909591aa | MIT; an open Workflow retains a wakeup while workers are absent. Server acceptance is not processing; SDK application calls get new request IDs | Selected existing dependency |
| Temporal Update | Same | Requires a live worker for acceptance/response; validators are not asynchronous database authorization | Not needed for an asynchronous control command |
| Workflow reset | Same Server/API | Creates an engine execution at a selected history point; cannot roll back effects or substitute for product authorization | Separate explicit recovery for already-closed histories; not implicit in this command |
| Second retry scheduler or signal-with-start | n/a | Can create/restart execution rather than reconcile existing facts | Rejected |

## Reuse decision

Use the existing PostgreSQL Task-lock/Owner-transaction/event primitives and released engine APIs.
The local gap is an immutable product command, its transactional pending-delivery obligation and
bounded public projection. Schema migration is additive. No engine scheduling loop, custom retry
engine or SDK graph serialization is added. The backend retains all authority.

The request binds Action/intent digest, expected reconciliation sequence, request key, Owner,
reason and time. Same-key retry checks immutable content before current outcome; concurrent clicks
coalesce onto one unfinished cycle. A stale page cannot silently open another cycle after failure.
Each Action is bounded to 64 explicit cycles. Delivery receipt and finished outcome are distinct;
late/duplicate delivery acknowledgement cannot reopen a finished command. Only the trusted engine
adapter may finish a cycle; resolved means the existing Action has an independently verified
terminal outcome. Unresolved leaves its reservation unchanged. No public applied/usage/receipt
fields exist. Arbitrary human text is an audit reason, never verified evidence.

The workflow's signal is only a bounded wakeup hint. A control activity reloads the durable command
and current Action under the same Task lock. It performs lookup only. The engine owns bounded
lookup retries; exhaustion returns to a durable wait. Signal delivery is pinned to a verified
actual engine run; failed/closed executions are refused, never implicitly restarted. Existing
histories use an explicit patch point before changed failure handling. The current CSV reference
exercises write reconciliation; generic model/read recovery and closed-history operational repair
remain separately required before production selection.

Historical trusted resolution remains possible after cancellation, expired grants or revocation;
new model/tool admission and publication remain forbidden. A caller's session is rechecked at
transaction commit. The SQL command is not an additional execution lease.

## Source incorporation

No upstream source copied or substantially adapted; existing MIT SDK and PSF stdlib dependencies
and notices remain unchanged. This is a thin control/domain adapter, not a new dependency.

## Verification plan

Actual PostgreSQL: parallel duplicate requests, changed intent/key payload, stale sequence, audit
rollback, owner revocation/expiry during lock contention, bounded inputs, delivery/finish replay,
late acknowledgements, cancellation and unchanged authority/budget. Public routes reject extra
outcome/cost fields and inappropriate origin/session; snapshots expose the latest cycle.
Actual engine/HTTP: repair while worker absent, delivery crash/retry, wakeup before wait, repeated
unresolved cycle then verified receipt, cancellation before repair, no extra POST and one Artifact.
Keep the accepted unrepaired historical behavior in replay tests. Closed engine signal is a refusal,
not evidence of successful recovery. Update English/Chinese user docs and run full repository checks.
No live account, production data, default backend switch or paid model is involved.

## Bounded review corrections (2026-09-23)

The request remains lookup-only. Keep unfinished commands discoverable after delivery, because
an older engine snapshot can discard an accepted signal while the control receipt survives.
Verified Action settlement closes a pending cycle in the same Task transaction, including when
automatic lookup wins before the workflow consumes the Owner request. Actual Temporal activity
timeouts (not only ApplicationError type strings) enter the fixed-write repair path; an admitted
write is conservatively marked unknown without new admission. Malformed receipt JSON is a
ReceiptMismatch. Preserve the existing engine retry limit and execution deadline.
Validation order: real application middleware/request entry, actual PostgreSQL including the
public route, then frozen-candidate engine journeys. Include timeout before receipt inspection,
malformed JSON, accepted-signal redelivery, resolution/request races and cancelled historical
resolution. No new scheduler, production backend switch or Linux prerequisite is introduced.
