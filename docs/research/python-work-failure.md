# Research: Work failure finalization

- Status: bounded Activity implementation and owned PostgreSQL/SDK tests complete; root owns
  Workflow integration and real-engine acceptance. No dependency changes.
- Date: 2026-09-25.
- Acceptance: a real accepted Temporal Workflow records failed Task/Run state before reporting
  a handled execution failure, preserving unresolved effect facts and reservations.
- Security boundary: only exact SDK Activity/start/handoff provenance can close its own Task
  subtree; closure grants no execution authority.

## Sources and reviewed pins

Reuse `docs/OPEN_SOURCE_REUSE.md` entries for product Work Worker, owner corrections,
closed-workflow reconciliation and Python product composition. Read current
`work_worker.py`, `work_corrected_workflow.py`, `work_deferred.py`, `work_store.py`,
`work_temporal_activity.py`, `work_engine_binding.py`, and `work_closed_repair.py`.
Related existing reviews: `work-product-worker.md`, `work-owner-corrections.md`,
`work-closed-repair.md`, `work-temporal-journey.md`.

| Candidate | Reviewed release | License | Decision |
| --- | --- | --- | --- |
| Existing Temporal Activity and patching APIs | temporalio 1.33.0, commit `ab52fdde33ee8ed193402625bfdba25d240a762d` | MIT | First viable released dependency; reuse installed product lock. |
| Existing PydanticAI Temporal integration | 2.47.0, commit `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6` | MIT | Retain orchestration/model retry ownership; no framework replacement. |
| Existing OpenBot SQL/event/closure adapters | Current root files and prior reviewed product Work implementation | MIT | Add narrowly scoped failure Activity and historical transaction entry. |
| Separate watcher/retry service or generic saga framework | Not selected | — | Adds an execution owner and cannot supply exact current Activity proof. |

Primary references checked 2026-09-25:

- [Temporal Python SDK](https://github.com/temporalio/sdk-python), including README exceptions
  and asyncio cancellation contracts. Attempt to open the pinned GitHub README URL returned a
  tool fetch error; the existing exact-commit review remains the pin, not current main.
- [Error handling](https://docs.temporal.io/develop/python/best-practices/error-handling):
  Activity delivery is at least once; Workflow Task vs execution failure differs; default failure
  conversion may retain exception details. The new public record must not echo those details.
- [Python cancellation](https://docs.temporal.io/develop/python/workflows/cancellation):
  cancellation gives code a cleanup opportunity, termination does not; non-local Activity
  cancellation requires heartbeats. Cleanup cannot imply an external request was never applied.
- [Python Workflow timeouts](https://docs.temporal.io/develop/python/workflows/timeouts):
  execution/run deadlines differ from Activity timeouts; a Workflow timer is appropriate when
  Workflow code itself needs a deadline action. No new timer policy is proposed here.
- [Versioning and patching](https://docs.temporal.io/develop/python/workflows/versioning):
  use a recorded patch marker and replay validation for added commands.
- [SDK issue 1600](https://github.com/temporalio/sdk-python/issues/1600) and
  [issue 1504](https://github.com/temporalio/sdk-python/issues/1504): cancellation/shield logging
  behavior on prior Python SDK versions warrants a real cancellation regression, not a fork.
  Installed pinned 1.33.0 `_workflow_instance.py` has `_shield_await` expressly avoiding spurious
  shielded-future warnings and an `uncancel()` path. This source observation is not a runtime test.
- Installed pinned `temporalio/workflow/_context.py` confirms `patched()` uses recorded history
  on replay. No private SDK function is proposed for application use.

Searches used GitHub/official documentation terms `temporalio sdk-python workflow cancellation
asyncio.shield cleanup`, `Temporal Python failure detection ApplicationError`, `Workflow
Execution Timeout terminate cleanup`, and `Python workflow.patched versioning`. Generic web
search returned several unrelated forks; only official project sources inform this design.

## Gap and reuse choice

Temporal already durably schedules the bounded cleanup Activity and retries lost ACKs.
OpenBot alone knows its Task authority, admission provenance, descendants, reservations and
public error record. A thin local adapter must join those existing contracts in one SQL
transaction. It does not need another scheduler, state store, retry loop, protocol, framework,
or upstream fork. The collaborator confirmed `cascade(..., reason='failed', include_self=False)`
owns descendant cancellation; this finalizer alone records origin failure and origin uncertainty.
The collaborator's `cascade` helper remains the only tree-closure owner.

No upstream source copied or substantially adapted. Existing project MIT notices remain;
no additional notice or dependency installation is needed. Later SDK upgrades must rerun
old/new history replay, cancellation, real commit-before-ACK recovery, and authority refusal
checks before this boundary is considered supported.

This design does not claim new platform support, actual model-provider quality, or hard-timeout
cleanup. `DESIGN.md` lists the exact planned PostgreSQL and real-engine acceptance checks.

## Implemented candidate and verification

`work_failure.py` exposes `FailureActivities.finalize` under the registered name
`openbot.finalize_task_failure.v1`. The only existing-module patch adds
`assert_historical_workflow_in_transaction` to the accepted binding module. It delegates to the
same provenance checks with the caller's existing transaction. The Activity uses the shared
collaboration cascade with `include_self=False`; no tree traversal was copied.

An extra guard requires the accepted origin WorkRun still queued/running before closing an
open Task. A historical acknowledgement alone cannot let an already-closed older Run stop a
later active Run. Same-Activity ACK recovery remains possible after the recorded failure.
Only actual transaction/storage errors and transient history RPC deadlines/unavailability are
retryable; malformed state, unauthorized provenance and arbitrary callback failures are not.
Every newly emitted failure message, DTO and event contains only finite local codes.

On 2026-09-25 the owned `work_failure` PostgreSQL fixture ran 40 tests, all passed in 12.05s,
exit 0, no skips. SDK `ActivityEnvironment` supplies the actual Activity context and the pinned
SDK data converter serializes exact synthetic immutable start input; the history client is
synthetic. Tests exercise PostgreSQL Task/Run/admission/Action events, rollback triggers,
concurrent parent/child closure, cancellation, resolution and publication, plus the existing
real `WorkActivities.completed_result` digest/blob readback. This is not a live Temporal engine
test or proof of real Worker kill/ACK recovery. Root must run those planned journeys separately.

Fixture history stayed at 39 canonical entries. Only that exclusive database received the
collaborator's frozen `0039_work_collaboration` SQL proposal, without editing a canonical
journal. Its SHA-256 was `8f32b1372be12077e140b29b4f10a733fa0262fbc1ced370b5b419991f16adf5`.
The shared helper's final SHA-256 was
`35a878a6dc9dc8607027d3fd3f369189701fe99baa481206d197ec4d627b18bf`.
Temporary test entities and trigger functions were removed; the owned schema remains for root.

Development runs exposed fixture mistakes (reserved pytest parameter name, assumed snapshot
field/usage shape, constructing an invalid unacknowledged row, and omitting a correction token
for a collaboration child). These were corrected and recorded in local evidence logs. They
are not presented as product passes. No production fixture or native profile packet was changed.


## Composed commit-before-ACK recovery, 2026-09-25

The canonical 40 product fixture subsequently passed real HTTP/PostgreSQL/mTLS execution:
a synthetic provider returned HTTP 400 once, failure SQL committed, and the API/Worker was
killed before its acknowledgement. Restart recovered the exact original Workflow failure
without another model request. The Task ended failed with one failure event, no report
publication and no channel result message; actual history replay passed. This closes the
packet's previously pending composed ACK-loss acceptance. It does not extend the guarantee
to engine hard termination, hard timeout or finalizer delivery exhaustion. The bounded
public result is experiments/work-journey/evidence/product-failure.json.
