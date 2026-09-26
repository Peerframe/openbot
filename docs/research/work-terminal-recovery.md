# Research: bounded hard-terminal Work closure

Date: 2026-09-25. Scope approved by root: **TERMINATED and TIMED_OUT only**. This is a
finite observation inside the existing ProductWorkService pass, not another executor,
Workflow, Activity, recovery daemon or effect retry. This file precedes implementation.

Reuse ledger: `docs/OPEN_SOURCE_REUSE.md` product Worker, closed-workflow lookup and product
composition entries. Existing reviews: `python-work-failure.md`, `work-closed-repair.md`,
`work-reconciliation-commands.md`, `work-product-worker.md`. Read current failure, service,
dispatch, repair binding, handoff, engine correlation, claims, Task store and shared tree
closure code. Existing `FailureActivities.finalize` requires a live actual Activity, which a
hard-closed Workflow cannot schedule. Calling it without its proof or inventing that Activity
would cross its authority boundary. The gap is exactly SQL closure after durable engine death.

## Reviewed released APIs

Temporal Python **1.33.0**, pinned source commit
`ab52fdde33ee8ed193402625bfdba25d240a762d`, MIT; Temporal Server **1.32.0**, reviewed commit
`d94e34a1ebba5410a2e7d07119a76896909591aa`, MIT. Retain the existing worker lock and mTLS
client. No new dependency or upstream source copy. Existing OpenBot MIT attribution remains.

- [Official cancellation/termination documentation](https://docs.temporal.io/develop/python/workflows/cancellation):
  hard termination records a terminal event without scheduling Workflow cleanup. Reset starts
  another engine Run, so the old terminal record cannot authorize closing that newer Run.
- [Official timeout/retry documentation](https://docs.temporal.io/develop/python/workflows/timeouts):
  Workflow Run, Execution and Task timeouts differ; Workflow retry is opt-in. A business timer
  failure is not an engine TIMED_OUT event.
- [Official WorkflowHandle API](https://python.temporal.io/temporalio.client.WorkflowHandle.html):
  explicit Run IDs pin describe/history; the start-returned handle's latest lookup may observe
  a different execution. Do not use result(), follow_runs or latest identity as positive proof.
- [Pinned SDK source](https://github.com/temporalio/sdk-python/tree/ab52fdde33ee8ed193402625bfdba25d240a762d)
  and raw GitHub file fetches returned tool errors today. Reused the existing exact-commit
  release/license review and inspected installed 1.33.0 source, generated requests, event
  protobufs, and tests instead of silently switching to main. GitHub/official searches used
  `Temporal terminate timeout cleanup`, `sdk-python v1.33.0 fetch_history_events`, and
  `WorkflowExecutionDescription first_run_id close event`.

Installed sources inspected: `client/_workflow.py` describe/history/result behavior;
`api/workflowservice/v1/request_response_pb2.pyi` exact Describe/GetHistory requests;
`api/history/v1/message_pb2.pyi` start, termination and timeout fields; `api/workflow/v1`
first_run_id and status. The timeout close event can carry `new_execution_run_id` for retry
or cron. The start carries original/first/continued Run IDs, retry policy, attempt and cron.
Use the existing SDK raw service calls with explicit namespace/execution, no SDK retries,
short RPC deadlines and bounded first/close responses. Never use visibility listings.

## Existing real history inspected

`history-metadata.json` records only paths, hashes, event counts and terminal types from four
already-exported synthetic real-engine journeys. Failure, Owner cancellation and collaboration
deadline samples end in **WORKFLOW_EXECUTION_FAILED**; collaboration success ends COMPLETED.
The deadline sample is therefore not evidence of a hard engine timeout. No fresh engine or
credential access was performed for this design. Existing closed-repair review records a real
termination journey, but its exported event body was not located; new TERMINATED/TIMED_OUT
and lost-ACK qualification remain required after integration.

## Decision and rejected options

First viable option: thin adapter over released exact-history APIs plus current SQL authority
and shared `cascade(include_self=False)`. A short receipt transaction revokes authority and
marks already-admitted actions unknown; it cannot manufacture outcomes, cost, claims or refunds.
Retain Owner-requested lookup repair as the separate existing mechanism for verified outcomes.

Reject replaying a model/effect, starting a cleanup Workflow, resetting the original Workflow,
using generic exception text as evidence, assuming missing history means failure, or treating
any FAILED/COMPLETED/CANCELED state as this new terminal condition. The current product makes
no Continue-As-New/Workflow retry/cron chain, so refuse successor/retry/reset evidence rather
than introducing chain traversal. A latest describe is only a negative veto for changed Run
identity; the positive proof always comes from the SQL-recorded exact first Run.

The service-local keyset cursor affects scan order only. SQL events own idempotency and unknown
reservations; losing a cursor merely repeats bounded observations. No new schema is needed.

The available `dsh --help` was read. Headless help tried to refresh its profile outside the
sandbox; root requested no parallel dsh profile use because it owns an independent Linux
review. No dsh model task, credential access or VPS connection was started here.


## Implementation qualification

The frozen design is implemented as one finite service pass using the existing SDK client.
The first history response may contain a bounded contiguous batch despite the requested page
size. The adapter accepts only event IDs 1..N within the described history length; if that
prefix does not reach the end, a continuation token is required. Only event 1 contributes
start authority. The close response must contain exactly one event and no continuation token.
Raw/archived, incomplete prefixes and oversized replies remain unproven. Intermediate history
is intentionally not needed for either immutable endpoint and is never inferred from absence.

Focused validation: 116 tests passed with Temporal Python 1.33.0 and a dedicated disposable
canonical-40 PostgreSQL database: 42 exact SDK protobuf/converter cases, 21 new PostgreSQL
cases, 2 finite-pass cases, 11 existing service cases and 40 existing failure cases. Engine
RPC responses in these tests are synthetic. SQL locking, rollback, commit-before-ACK,
Owner cancellation, publication races, ancestor/child closure and original record readback
are real PostgreSQL transactions. This evidence does not claim a new live Temporal hard
termination or hard timeout; the separate mTLS journey must qualify those after integration.

No migration, model/effect resend, claim, settlement, reservation refund or Workflow change.
External administrative reset after the final remote veto cannot be atomically excluded
across Temporal and PostgreSQL. It is not an authorized product operation; SQL authority
revocation still fences future effects, and a newer SQL WorkRun is checked under Task locks.

### Actual mTLS qualification

The separate actual-engine journey subsequently passed all three cases in 67.67 seconds:
hard termination, actual 35-second execution timeout and terminal SQL commit followed by
SIGKILL before acknowledgement. A restarted ProductWorkService closed each Task once,
retained its unknown Action/reservation and original engine Run, and made no new provider
POST. Each case kept two original HTTP attempts and one synthetic write. Owner lookup in
the termination case settled the existing receipt without another write or reopening the
failed Task. Four real histories (55/11/48/55 events) replayed offline with unchanged SQL/HTTP
counters. Exact-owned processes, Compose containers/volumes and Task rows were removed.

Sanitized evidence: [product-terminal-recovery.json](../../experiments/work-journey/evidence/product-terminal-recovery.json),
SHA256 `b4ef60bcf85253ebaf302d639999888ce514000e518b40274fecf5eec210ee30`.
Private history payloads and generated credentials are not repository artifacts. The reviewed
reproduction lives in [terminal-recovery](../../experiments/work-journey/terminal-recovery/README.md);
it accepts an explicitly supplied disposable loopback fixture with the documented database
prefix, rather than a maintainer-specific dated database name. The original successful run
used canonical40; the prefix/import-only reproduction adaptation does not constitute a new run.

## Reproduction and maintenance

Use the repository's pinned Worker Python and `OPENBOT_CONTROL_TEST_FIXTURE` pointing to an
owned disposable canonical fixture, then run `pytest` over `test_work_terminal_proof.py`,
`test_work_terminal_postgres.py`, `test_work_terminal_service.py`, `test_work_product_service.py`
and `test_work_failure.py` from `apps/server-python`. The worker branch of
`scripts/test-python-control.mjs` registers the three new test modules. New tests skip cleanly
when the optional Temporal SDK profile is absent. No paid model or external account is needed.
