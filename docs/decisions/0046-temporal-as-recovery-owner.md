# ADR-0046: Temporal owns durable work continuation

- Status: Accepted for target integration; production activation pending
- Date: 2026-09-24

## Context

OpenBot must keep a Task alive across client disconnects, worker restarts, approval waits and
uncertain external results. The control service owns identity, grants, budgets, Action facts,
reconciliation and Artifact publication. A retryable Agent segment may propose work but cannot
replay an unknown external write. Only one component may schedule continuation. The current
TypeScript Server is transitional; the target is a modular Python control service and separate
Python Agent Runtime behind the same Web/Desktop API.

The existing reference has exercised public HTTP + PostgreSQL Task submission, approval while
workers are absent, lost write responses, explicit lookup-only repair, cancellation, Artifact
verification, engine backup/restore, mTLS transport, historical replay, and a stopped adjacent
Server upgrade. This is substantially stronger evidence than a successful standalone SDK demo,
but its fixed CSV strategy and one-Task dispatcher are not production implementations.

## Upstream review

GitHub/official-source searches reviewed Python durable workflow recovery, activity retries,
approval messaging, workflow ID reuse, history retention, worker versioning and service upgrades.
Exact candidates and maintained upstream sources:

| Candidate | Reviewed release/source | Fit and unresolved risk |
| --- | --- | --- |
| [Temporal Server](https://github.com/temporalio/temporal/releases/tag/v1.32.0) + [Python SDK](https://github.com/temporalio/sdk-python/releases/tag/1.33.0) | Server 1.32.0 / `d94e34a1ebba5410a2e7d07119a76896909591aa`; SDK 1.33.0 / `ab52fdde33ee8ed193402625bfdba25d240a762d`; MIT | Durable waits, signals, activities, replay and explicit worker-code compatibility; separate SQL history/visibility service adds deployment and operations cost. Current Pydantic AI Temporal adapter composes with control-owned activities. |
| [DBOS Python](https://github.com/dbos-inc/dbos-transact-py/tree/dd8a5f315a54c02a750f80dd15127958243ed339) | 3.0.0 / `dd8a5f315a54c02a750f80dd15127958243ed339`; MIT | Embedded PostgreSQL orchestration reduces service count. Its ten-case fault probe passed, but the product-facing work journey, multi-executor fencing, approval/reconciliation operations and code-upgrade path have less evidence here. |
| OpenBot-specific scheduler | Existing Server lifecycle | Would duplicate mature retry/history semantics and enlarge the authority surface; rejected. |

Primary contracts and actual measurements are recorded in
[durability qualification](../research/durable-execution-qualification.md),
[Temporal review](../research/temporal-durability-review.md),
[public work journey](../research/work-temporal-journey.md),
[PostgreSQL operations](../research/temporal-postgres-operations.md),
[transport](../research/temporal-transport-security.md), and
[upgrade evidence](../research/temporal-release-upgrade.md).
[Workflow IDs](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx)
deduplicate only within retained history; they are not a permanent external-effect ledger.
The reviewed SDK has an open
[local-activity replay report](https://github.com/temporalio/sdk-python/issues/1881);
the selected integration uses remote, control-owned activities and must keep replay regression
coverage. Upstream issue status is not proof that all future histories replay.

## Reuse decision

Use the released Temporal service and Python SDK as OpenBot's **sole target recovery owner**.
Continue from the already reviewed Pydantic AI durable adapter where its public APIs preserve
granular model/tool checkpoints; keep business grants and effects in control-owned activities.
This selects an integration direction, not a production default or permission to run the reference
fixture as a general dispatcher. Do not add DBOS or an OpenBot retry scheduler alongside Temporal.

The service cost is accepted because long approval waits, independent worker restart, history
inspection and versioned continuation are core product requirements. A future engine replacement
would require the same Task/Action and operational acceptance, not a hidden runtime toggle.

## Source incorporation

No Server or SDK source is copied. The existing fixed-version deployment reference adapts the
official MIT sample and retains its notice in `deploy/temporal/THIRD_PARTY_NOTICES.md`. Product
integration must pin and separately lock the selected dependencies, preserve notices and use
public APIs. No change to the current default Server is made by this decision.

## Verification plan

Before any default switch, integrate a production dispatcher and the real Python Runtime without
placing an indefinite Agent loop inside one retryable activity. The engine must own waits/retries;
control PostgreSQL must own immutable Action intent, scoped approval, budget, evidence, terminal
Task state and Artifact registration. Exercise public API → engine → Runtime → isolated executor →
reconnect/download with process death before/after admission, dispatch, approval, external effect
and publication. Unknown writes require authoritative lookup or stay unknown. Verify concurrent
dispatch, stale-worker fencing, cancellation/revocation, shared budgets, code/version upgrades,
retention expiry, resource use, independent backup/restore, and an explicit unresolved-work
operator path. Qualify production API authorization/PKI; mTLS alone authenticates peers, not
per-method authority. Run hostile-code work only behind the separately accepted Linux boundary.

Rollback means keeping the previous product writer/default available until compatibility and
old-data migration are proved. An engine-only history restore may never roll back newer control
facts or authorize a repeated external write. A failed gate leaves the new backend opt-in and S3
open; it does not silently select DBOS or revive a local retry loop.

## Decision

Temporal schedules continuation and durable waits for the target Python backend. The control
service remains the sole authority for Bot/Task/Run/Action/Artifact, approvals, budgets and audit.
The Python Runtime is a replaceable strategy implementation with no independent execution grant.
Engine history and product state are intentionally separate; neither Temporal success nor a
Workflow ID certifies external outcome or final Task completion.

## Consequences

One more service and two engine PostgreSQL stores must be installed, monitored, backed up and
upgraded. This is preferable to two partially overlapping recovery implementations for this
product, but it raises self-deployment and contributor costs that S7 must measure and document.
The reference still lacks production dispatch, real provider/tool composition, accepted Linux
isolation and full client compatibility. This ADR closes the **choice of recovery owner**, not S3
or the full architecture migration.
