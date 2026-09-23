# Research: durable execution candidate qualification

- Status: experiment approved; production engine selection pending
- Date: 2026-09-23
- Owner: OpenBot integrator
- Acceptance journey: kill an actual Python worker before/after an external write and during approval wait; recover with a new process and inspect independently observed effects.
- Security boundary: disposable local PostgreSQL and loopback HTTP only; no application database, provider credentials, real external writes, or production dispatcher.

## Search evidence

Queried official GitHub releases and docs for Python durable workflow recovery, cancellation,
retries and external effects. Reviewed existing reuse entries for recurring tasks and partial
multi-Server dispatch; neither establishes restart-safe task execution. Existing Python lifecycle
acceptance remains valuable but is not durability qualification.

## Candidate comparison

| Candidate | Exact version | License | Evidence and fit | Decision |
| --- | --- | --- | --- | --- |
| DBOS Python | [3.0.0 / dd8a5f315a54c02a750f80dd15127958243ed339](https://github.com/dbos-inc/dbos-transact-py/tree/dd8a5f315a54c02a750f80dd15127958243ed339) | MIT | Released 2026-09-16; Python >=3.10; PG-backed embedded orchestration. Inspected `_recovery.py`, `_core.py`, `_dbos.py`, `_client.py`, `_serialization.py`, `test_dbos.py` and `test_workflow_management.py`. | First executable candidate; not yet the production selection. |
| Temporal Python | [1.33.0](https://github.com/temporalio/sdk-python/releases/tag/1.33.0) | MIT | Maintained workflow/activity SDK with a separate Temporal service. See the [integrated Temporal review](temporal-durability-review.md); Codex verified key identity/cancel/retry claims. | Comparator; the independent 12-case local probe now passes with development SQLite. Production persistence and the integrated domain journey remain unqualified. |
| OpenBot-specific recovery engine | Existing single-process Run lifecycle | Project license | Lacks durable approval continuation and uncertain-effect policy. | Do not grow a parallel orchestration engine before evaluating released components. |

Primary documentation: [workflows](https://docs.dbos.dev/python/tutorials/workflow-tutorial),
[architecture/recovery](https://docs.dbos.dev/architecture),
[decorators and retry options](https://docs.dbos.dev/python/reference/decorators).
The pinned implementation re-enqueues interrupted executions through atomic queue ownership.
Exception retries default off, but an unfinished step still runs on crash recovery. A successful
checkpoint suppresses repeating the step body; a crash after an external write but before the
checkpoint does not. Cancellation prevents later steps; it does not undo an in-flight synchronous
call. Approval messages are durable; policy/approval validity still belongs to OpenBot.

Reviewed historical issues [#759](https://github.com/dbos-inc/dbos-transact-py/issues/759)
(empty workflow IDs; closed 2026-07-07) and
[#818](https://github.com/dbos-inc/dbos-transact-py/issues/818)
(duplicate recovery after datasource transaction; closed 2026-08-19). Their closed status is not
proof of absence of races. The pinned source has regression coverage for empty IDs and duplicate
recovery; this experiment does not substitute for multi-executor fencing qualification.

## Reuse decision

Use the released DBOS package only inside `experiments/durable-execution`, with separate exact
requirements. Do not add it to the Server or Runtime dependency graph yet. Reuse PostgreSQL17.11
and the existing pinned image for an owned disposable fixture. The narrow local gap is an
independent fault harness, fake effect endpoint, and deliberately conservative action-intent
example; none is a replacement workflow engine. DBOS alone owns replay in this experiment.

No workflow history contains provider secrets. Use portable JSON for workflow inputs/results
rather than relying on the SDK's default pickle serialization. This does not establish a secure
untrusted-history boundary. Production history ACLs/encryption/retention require further design.
Missing/incompatible dependency or failed assertion must fail the experiment; never silently
select a homemade fallback. Upgrade/replacement requires rerunning the same fault cases.

## Source incorporation

No upstream source copied or substantially adapted. Calls use public package APIs. DBOS remains
an independently installed MIT dependency; its wheel includes its license. Test/harness logic is
original OpenBot code. No production support or performance claim follows from this experiment.

## Verification plan

1. Checkpointed step does not repeat after SIGKILL and restart.
2. A deliberately unsafe external action repeats after a post-write/pre-checkpoint crash, even
   with `retries_allowed=False`; this negative control detects a misleading exactly-once claim.
3. A durable intent prevents blind resubmission and returns a needs-reconciliation result.
4. Waiting approval survives process death; current authority is rechecked before an effect.
5. Cancelling while a synchronous step is in flight preserves already-observed effects but
   prevents the next effect. No claim of external rollback or hard process termination.
6. Reusing a completed workflow ID returns recorded output without another external effect.

## Unresolved selection gates

Real Runtime segment/checkpoint mapping; approval process eviction; safe workflow-code upgrades;
lease/fencing and stale worker commits; transactional enqueue with domain writes; budget authority
on replay; engine outage and restore; history size/retention; exact sandbox and credential boundary;
Temporal comparison and the real user-facing task/client journey. Do not mark S3 complete until
these are implemented and independently verified.

## Executed evidence

The original local harness passed all ten cases on 2026-09-23, including the deliberately
unsafe negative control. See [the reproducible experiment](../../experiments/durable-execution/README.md).
This validates the narrow fixture behavior and leaves the selection gates above open.

Additional controlled suspension cases keep the old process alive: SIGSTOP before external
dispatch, simulated successor recovery, then SIGCONT. Without an effect-boundary epoch check,
the old process still writes; with the fake endpoint enforcing the new epoch, it is rejected.
This is not a real network partition, production lease or automatic failure detector. The first
two-active-poller attempt timed out and is not counted as evidence.
