# Research: Temporal durability candidate

- Status: source review and local development-profile fault qualification; no production selection
- Date: 2026-09-23
- Owner: WorkBuddy supplied the source investigation; Codex reviewed and integrated it
- Acceptance journey: the same approval, crash, stale-worker and unknown-effect journey as DBOS
- Security boundary: OpenBot controls identity, authority, budgets, effects and final publication;
  the engine orchestrates trusted activities. Workflow determinism restrictions are not a sandbox.

## Search evidence

WorkBuddy inspected official SDK release metadata, pinned source, tests, issues and self-hosted
Temporal documentation. Codex independently verified the tag commit, license, Python requirement,
`Info`, `RetryPolicy`, client cancellation/termination methods and the listed issue states.
The initial source-review task did not start Temporal Server or run a workflow. The subsequent
executable profile and independently run fault results are recorded below; their deployment
limitations remain distinct from the DBOS PostgreSQL engine profile.

Reviewed existing OpenBot research: Python task authority, runtime supervision, runtime ports,
executor seam and capability leases. Existing process supervision is not durable orchestration.

## Candidate comparison

| Candidate | Exact release/commit | License | Fit and decision |
| --- | --- | --- | --- |
| Temporal Python SDK | [1.33.0](https://github.com/temporalio/sdk-python/releases/tag/1.33.0), [ab52fdde33ee8ed193402625bfdba25d240a762d](https://github.com/temporalio/sdk-python/tree/ab52fdde33ee8ed193402625bfdba25d240a762d) | MIT | Python >=3.10; Linux/macOS/Windows wheel distribution; workflow history/replay and activity APIs. Keep as candidate; separate Server version/configuration still must be pinned. |
| DBOS Python | 3.0.0 / dd8a5f315a54c02a750f80dd15127958243ed339 | MIT | Reviewed and experimented separately; see [qualification](durable-execution-qualification.md). |

## Reviewed mechanisms and design consequences

**Identity.** The pinned [`Info` fields](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/workflow/_context.py)
include engine workflow ID, run ID, first execution ID and attempt. These are not OpenBot domain
identities. The target mapping is an OpenBot Run to an orchestration chain; engine retries and
Continue-As-New may change internal IDs without creating another business Run. Task and Action
records remain independent. Standalone Activities are an available API, not a required Action model.

**Approval.** The SDK supports signal/update handling and `wait_condition`; history can rebuild
workflow state. OpenBot still records the business wait, immutable approval intent, expiry and
idempotency key. Duplicate decisions and Continue-As-New boundaries need explicit tests. A replayed
old authorization value must never stand in for current admission checks.
See [messages](https://docs.temporal.io/handling-messages) and
[approval pattern](https://docs.temporal.io/design-patterns/approval).

**Replay.** Deterministic orchestration may use recorded activity outcomes; network/model/file/DB
operations belong outside workflow replay, typically in normal remote Activities. An Agent loop is
not automatically one safe retryable Activity. The [workflow rules](https://docs.temporal.io/workflow-definition)
and the pinned SDK's `patched`, `deprecate_patch`, `continue_as_new` and
[`Replayer`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/worker/_replayer.py)
provide relevant mechanisms, not proof our checkpoint format upgrades safely.

**Cancellation.** [`WorkflowHandle.cancel` and `terminate`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/client/_workflow.py)
target engine execution chains. Cancellation is cooperative; termination closes engine execution.
Neither is an operating-system process kill, credential revocation or rollback of an external
request. Cancellation delivery to running remote Activities depends on heartbeat/cooperation.
Inspect [activity execution](https://docs.temporal.io/activity-execution) and verify the exact
activity type/cancellation mode before making a product stop guarantee.

**Retries and usage.** [`RetryPolicy.maximum_attempts`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/common.py)
defaults to zero, meaning no cap in that policy; this is not a claim that every workflow defaults
to retrying forever. Set explicit per-operation retry/timeout policy. Heartbeat details can carry
progress, but do not transact with external systems. A normal remote Activity with one attempt
has different recovery behavior from DBOS disabling exception retries. Compare actual failures,
not matching option names. No engine option alone proves exactly-once external effects.

**Fencing and unknown outcomes.** The SDK exposes activity task tokens and completion APIs.
The scope of server-side stale-token rejection was not validated. Token identity does not prevent
an old worker from sending an external request. Enforce admission, attempt ownership and applicable
fencing at the actual execution boundary; reconcile unknown writes before another dispatch.
The engine's current state is evidence for supervision, not OpenBot's final result authority.

## Maintenance and open issues

The pinned tree includes [activity tests](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/tests/worker/test_activity.py),
[workflow tests](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/tests/worker/test_workflow.py)
and [replay tests](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/tests/worker/test_replayer.py).
WorkBuddy read relevant heartbeat/cancellation/nondeterminism cases; these tests were not run here.
Open issue reports observed on 2026-09-23 include
[#1881](https://github.com/temporalio/sdk-python/issues/1881) (local-activity replay payload ordering),
[#700](https://github.com/temporalio/sdk-python/issues/700) (awaiting cancellation confirmation) and
[#1591](https://github.com/temporalio/sdk-python/issues/1591) (cold-start Update nondeterminism).
Reports are risk inputs, not independently reproduced failures in OpenBot. Avoid local activities
for the first effectful probe; assess relevant fixes before relying on the affected paths.

## Deployment and operating obligations

Temporal adds a separately operated service and its persistence/history lifecycle. Development
server convenience does not qualify a production configuration. Pin SDK, Server, persistence and
schema tools together for the real comparison. Define networking/authentication, visibility,
retention, database backups, history compatibility, upgrades and restore operations. Do not copy
large upstream deployment examples as OpenBot's minimum footprint, or confuse cluster creation
settings with compiling the application.

Sources: [self-hosted guide](https://docs.temporal.io/self-hosted-guide),
[persistence](https://docs.temporal.io/temporal-service/persistence),
[server upgrade procedure](https://docs.temporal.io/self-hosted-guide/upgrade-server),
[worker versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning).
This review did not establish a complete tested backup/restore or rollback procedure; that is an
unresolved investigation/qualification item, not a claim that upstream lacks such capabilities.

## Reuse decision

Keep the released dependency as a candidate rather than inventing a new recovery engine.
No production dependency, generic multi-engine framework or migration is added by this review.
The control/engine seam must preserve [the work execution contract](../WORK_EXECUTION_CONTRACT.md).
Select one recovery owner after the same fault cases and integrated journey, including operational
costs. Missing/incompatible engine behavior fails closed; it must not select a silent custom fallback.

## Source incorporation

No upstream implementation code copied or substantially adapted. This integrated record paraphrases
source findings. If installed, retain the package's MIT notice and record exact dependencies.

## Verification plan and unresolved questions

1. Pin a compatible Server and persistence profile, then run actual worker death/restart and durable
   approval delivery with duplicate and expired decisions.
2. Test single-attempt versus bounded-retry normal Activities; distinguish no retry from guaranteed
   effect completion. Keep unknown outcome visible and its budget reserved.
3. Suspend/partition a live old worker, admit a successor, restore the old worker and check external
   writes, late receipts and conditional completion; do not test only SIGKILL.
4. Test atomic domain admission versus engine enqueue/notification, parallel shared-budget reservation,
   provider billing without a local receipt and file creation without final metadata registration.
5. Exercise engine/database outage, upgrade replay, retained histories, backup/restore and reconciliation
   against external facts. Do not reuse a cached positive authorization after revocation.
6. Measure waiting-workflow resource use, recovery time, history growth and actual operator steps on
   the same target environment. These are measurements, not inferred maturity rankings.
7. Run the public-API task journey before selecting the engine. No runtime, availability, performance,
   platform or security support is established by this source review alone.

## Executable probe profile (2026-09-23)

This added profile qualifies local worker behavior only; production Server/storage selection is
still open. Root reviewed CLI startup source and tests before implementing the harness.

- CLI [1.9.1](https://github.com/temporalio/cli/releases/tag/v1.9.1), commit
  `1de87a9f26991bf4f5c0a5ff96f2cea8d7a3cbde`, MIT, released 2026-09-14.
- Its pinned `go.mod` and executable version report Server **1.32.0**; SQLite driver dependency
  `modernc.org/sqlite v1.51.0`. Development persistence uses a private temporary SQLite file.
- Downloaded official macOS arm64 archive SHA-256:
  `41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56` (verified).
- Reviewed [startup/configuration source](https://github.com/temporalio/cli/blob/1de87a9f26991bf4f5c0a5ff96f2cea8d7a3cbde/internal/devserver/server.go)
  and [CLI tests](https://github.com/temporalio/cli/blob/1de87a9f26991bf4f5c0a5ff96f2cea8d7a3cbde/internal/temporalcli/commands.server_test.go):
  file-backed SQLite initialization, loopback binding, simple startup and persistence banner cases.
  These upstream tests were inspected, not run locally.
- The CLI explicitly says its development server is unsuitable for production and omits some HTTP
  security checks. Use headless, loopback-only binding and disabled config/environment loading;
  never connect this experiment to a user database, namespace or credentials.
- SDK 1.33.0 uses normal remote Activities with explicit retry/timeout policy. PG 17.11 and the
  existing fake effect service supply the same domain-intent fixture as the DBOS probe. The
  Temporal engine's own store is SQLite here, so this is not a production PG deployment comparison.
- No upstream implementation copied. WorkBuddy implements the bounded worker; Root owns the
  runner, actual failure injection, result assertions and independent review. Product dependencies,
  default engine and schema remain unchanged. Do not infer performance/availability selection
  from this development profile.

### First fault run and corrected stale-worker fixture

The first actual run passed eight cases through persisted approval across Server restart, then
failed the expected stale-write assertion. A resumed synchronous activity received SDK-injected
`CancelledError` during HTTP sending, leaving a truncated fixture request. This is evidence of
SDK cancellation behavior, not evidence of guaranteed fencing or a passed stale-worker case.

The pinned SDK's public `activity.shield_thread_cancel_exception()` defers a synchronous thread's
injected cancellation until its context exits (`temporalio/activity.py`, lines 351–378). The
corrected stale-worker negative/positive pair deliberately shields only the experimental
non-cooperative action section. Normal action/cancellation cases retain SDK cancellation behavior.
This models a section that does not stop when the engine times out; it must be described explicitly,
not presented as default Temporal behavior. The intended counterexample remains: an engine's
closed execution does not itself revoke external authority. No product cancellation is disabled.

### Independently executed result

The corrected full run passed **12 cases** on 2026-09-23: checkpoint recovery, rejection of duplicate
completed IDs, unsafe duplicate write, guarded unknown write, guarded pre-write uncertainty,
approval while the worker is absent, current revocation, approval across development Server death,
shielded stale action without/with boundary fencing, single-attempt timeout and cancellation.
The single-attempt case checks a real Activity timeout: the engine is FAILED while the external
write exists. The normal cancellation case is CANCELED, retains the existing write and never
executes the finish activity. These states are not production Task completion decisions.

The two stale-worker cases use the explicit cancellation shield described above and controlled
SIGSTOP/SIGCONT. They do not establish default-worker cancellation races, network-partition
detection, production leases or external provider fencing. The first failed assertion remains
part of the evidence; it was not counted as a passed stale-worker case.

CLI issue query `repo:temporalio/cli is:issue is:open sqlite` returned
[#312](https://github.com/temporalio/cli/issues/312) (development archival settings) and
[#847](https://github.com/temporalio/cli/issues/847) (integration deadline) on the review date.
These reports were identified but not reproduced and are not claims of production defects.

Source review plus these probes does not select Temporal or DBOS. The public Task/Action journey,
actual unknown-outcome reconciliation, current-authority races, shared usage reservation, Linux
execution isolation, target production persistence, upgrades/restores and operating measurements
remain mandatory gates. No mock result is labeled as a real model/browser/product acceptance.
