# Product deferred approval and continuation

- Parent:965a643,2026-09-24. Implementation gate; no default activation.
- Reuse: pinned Pydantic AI2.47.0/77d5fce751ab8ab04bd5db4ed6acc1131a4baed6 (MIT), Temporal1.33.0 (MIT), existing ToolCatalog, Action propose/admit/settlement and ReconciliationStore. No new dependency, schema or copied upstream implementation.
- Sources rechecked: https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/ and https://pydantic.dev/docs/ai/capabilities/durable_execution/temporal/ ; https://docs.temporal.io/develop/python/workflows/message-passing . Prior source/release/security/license reviews are retained in work-temporal-journey.md and temporal-durability-review.md; this is a thin product composition of those exact releases.
- Installed SDK evidence: durable_exec/_base.py and _runtime_toolsets.py permit non-executing ExternalToolset per run; output_type override is supported without output validators. ExternalToolset uses any_schema, so control must still validate arguments. Every resume needs full message history, cumulative usage, identical tool declarations and DeferredToolResults.calls; approval never authorizes SDK tool execution.

## Contract before implementation

A trusted per-Run catalog is loaded only in Activities, validated and detached; Workflow receives declarations only. Each bounded deferred proposal is prepared in a separate Activity. Its operation key derives from accepted immutable engine identity and actual preparation Activity ID, never the model call ID. Preparation retries first read the original Action; approved execution reads the stored intent/reservation/approval without invoking the planner again. Stored intent includes the reviewed tool request and policy intent so retries can reject content changes. Admission and budgets remain in the existing store.

The preparation fence must not survive an arbitrary human wait. New execution acquires its own Activity fence; already admitted/unknown outcomes use lookup-only recovery. Owner decisions remain persisted HTTP facts; Temporal owns the timer and short decision checks, including expiry, cancel and revoke. Unknown results cannot be fed to the model as success. Existing scoped reconciliation commands permit lookup only; stored command, delivered and verified-finished remain distinct. Cancellation/revocation must not create authority from readback.

No Runtime rewrite, new agent framework or S4 executor is needed. Product activation, general corrections and unaccepted Linux isolation are outside this slice. Actual public approval/restart tests follow cheap entry and scoped PG checks. Preserve prior histories and old no-deferred Worker behavior; keep per-run model/step budget across pauses. Independent review precedes the long fault cases.

## Ownership

Codex implements the product approval/control/Workflow integration. dsh task S3-DEFERRED-VALUES owns only the standalone bounded parser and its tests in a minimal temporary copy; no overlapping edits. The previous full-worktree literal-file restriction is replaced by a tiny task-directory write boundary to permit atomic file replacement, not broader project access. The parser was handed back and independently checked by Codex; only that parser scope is accepted. dsh did not run its own tests: its nested shell tool was unavailable.


## Independent review and observed failures

- The first dsh attempt failed while creating its spill directory under the restricted OS profile.
  One justified correction put `TMPDIR` inside the existing tiny task copy; the second process
  exited0 and returned only the parser/test files. No project-wide write grant or GUI fallback.
- Codex ran the parser tests and independently found a 20,000-level JSON input below the byte
  ceiling that raised `RecursionError`. It now returns the same safe validation error. No input
  value is included in the error. Parser tests ran locally; dsh's unavailable shell is not a pass.
- The first local Runtime test command named a nonexistent file (exit4). The corrected existing
  path `experiments/work-journey/test_work_runtime_ports.py` executed26 tests successfully.
- Initial PG collection imported the store from the wrong module (exit2); corrected to the existing
  `database.py`. PG01 then exposed eight fixture construction errors (`TrustedVerifier` requires
  its service). PG02 exposed five fixture requests rejected by CSRF before authentication: valid
  Origin was added, retaining the unauthenticated401, bad-digest409, extra-field422 and private
  resolve405 assertions. PG03 passed. PG04 had one new fixture error: Task status `running` is
  invalid (Run status differs); corrected to `open`, preserving the mismatch assertion. These
  were developer/test-harness failures, not system recovery retries. Failed logs remain retained.
- Read-only review required (a) deep-copying planner arguments, (b) validating the entire batch
  before any prepare Activity and (c) a real prepare-after-commit/before-ack barrier. All are
  covered by targeted counterexamples. Repeated model call IDs cannot identify operations.
- A second review found an ambiguous unknown-repair fault point. The fixture now waits for the
  original execute Activity's completion in engine history before stopping the Worker, then
  requires a later reconcile Activity. It also kills after the denial transaction commits but
  before stop Activity acknowledgement. Real failed-state binding and mismatched Task/Run,
  attempt, chain, queue and type are exercised; no grant or write occurs on terminal readback.

The review that changed long-test inputs finished before the long journey. Preparation and
terminal-stop retries in that journey are deliberate system-under-test recovery, not tool retries.
No implementation changes are permitted during candidate validation. This slice adds no schema,
provider account, Linux isolation claim, default backend switch or deployment.


## Stable candidate and validation

Parent `965a643` plus this slice, including new untracked files. The pre-validation manifest
`/private/tmp/openbot-deferred-candidate-20260924-02.json` records the following hashes; all matched
after the actual journey. Documentation-only edits followed validation. Optional SDK checks used
the clean product profile based on committed parent control/Runtime locks, not the unrelated
working-tree model-service dependency changes.

| File | SHA256 |
| --- | --- |
| `apps/server-python/src/openbot_server/work_deferred.py` | `394cbd4e798659b79b1cf4185e99094fbb2cc21e69cb303108d328dcd8f6e19e` |
| `apps/server-python/src/openbot_server/work_deferred_values.py` | `08fb1185c6dffa5a5f6a09fe4f734196c59f811198b45bb41c51f2d0aea89979` |
| `apps/server-python/src/openbot_server/work_worker.py` | `0f4afcb1839bd75e62dcd4f3a6c78457b09a369da0adcc604f464f07907db8ba` |
| `apps/server-python/src/openbot_server/work_runtime_ports.py` | `ab728e11259edd1f0ba0df7b39069d1a1ffead0aa587b132f028bd4fc7d5f228` |
| `apps/server-python/src/openbot_server/work_engine_binding.py` | `289e5646b60962563ea1947ee0449f717f64bdfeb22bd0f70bd7a727804beaeb` |
| `apps/server-python/src/openbot_server/work_temporal_activity.py` | `49d212213f0d3b645569e7ae5b096c2d837504e7f1b2bb7910bf5a1d6376d8f0` |
| `apps/server-python/tests/test_work_deferred_postgres.py` | `7591e58cd0f8d1485cec90523cb2e11ab5074c617b402cff33839261154d9918` |
| `apps/server-python/tests/test_work_deferred_values.py` | `cc94b468fcbc65b66837cdeb24c19ff4aa63ff03d50cb9c426366c4b1901b609` |
| `experiments/work-journey/product_approval_worker.py` | `dd099fb8c47b7233155760757e698ac56bd3c92bee8b50b18e917a7d94e37311` |
| `experiments/work-journey/product_approval_probe.py` | `212598c272d34beb0d2f78bb25e83557d25afb94c954482c6b1c7a3878efbf92` |
| `experiments/work-journey/test_product_deferred_workflow.py` | `f10b2e8c846c2ed2eda9733a70204f8556e34f3a02b9dcd12ce74b4f6802dc7e` |
| `experiments/work-journey/probe.py` | `7517bcd06f21e0f9288936ed53714be879332184f6ce8e88623f9697fbef9a3d` |
| `scripts/test-python-control.mjs` | `9f13ad7e4152f71acb82e59f83c527d7052a1f2d273a8bc178000d0aa3a1379a` |


| Command / check | Actual result | Existing log under `/private/tmp/` |
| --- | --- | --- |
| `node scripts/test-python-control.mjs` with pinned optional SDK interpreter | PG05 exit0: base302 passed,2 optional-SDK skips; separate SDK142 passed. Actual HTTP decisions and real PG terminal binding, original proposal, cancellation and reconciliation | `openbot-deferred-postgres-20260924-05.log` |
| `pytest -q experiments/work-journey/test_product_deferred_workflow.py` |2 passed; whole-batch rejection before preparation and same usage/full-history continuation. Cache-directory warning only; no test skipped | `openbot-deferred-batch-20260924-02.log` |
| Parser + existing CLI checks |23 passed, including13 parser checks; RecursionError counterexample independently added | `openbot-deferred-local-20260924-02.log` |
| Runtime ports unit checks |26 executed and passed | `openbot-deferred-ports-20260924-01.log` |
| Reference unittest discovery |143 executed;134 passed,9 environment errors because sandbox denied local listener creation. Only those9 effect-service tests rerun with local fixture permission, all passed; no source changed | `openbot-deferred-reference-20260924-01.log`, `openbot-deferred-effect-service-20260924-01.log` |
| `probe.py --engine postgres-mtls --only-case product-deferred-approval` |Exit0. Actual public approval while absent, same Action after lost prepare ACK, unknown reservation/Owner-command continuation, approved cancellation, lost denial ACK, verified download and unchanged replay | `openbot-deferred-mtls-20260924-01.log` |
| `probe.py --engine postgres-mtls --only-case product-concurrent-runs` |Exit0. Same product Worker/Agent/queue, overlapping Tasks, isolated cancellation/accounting/artifacts and unchanged replay through the retained no-deferred path | `openbot-deferred-concurrent-mtls-20260924-01.log` |
| `npm run check` |Exit0. Repository prerequisites executed; Turbo lint/typecheck31/31, tests31/31 and build18/18 cached. PR research check not run outside PR event; platform-dependent release skips retained | `openbot-deferred-check-20260924-01.log` |

The actual new journey is wired into the existing Python Linux CI lane; the two new pytest
workflow checks are explicit because unittest discovery does not execute pytest functions.
Remote CI is prepared, not claimed executed. No live model credentials or production data used.
The SDK emits an `annotated_types` late-import warning; actual workflow/history replay passed.

## Scope and stop

Independent read-only review accepted the final slice and matched all13 candidate hashes after
the actual journeys. The retained no-deferred regression passed. This completes only the deferred
approval/unknown-continuation slice. General product corrections, service activation and closed-Workflow repair integration
remain outside this acceptance. S3 as a whole and the overall migration are not complete. S4
actual Linux/runsc is unaccepted; no TASK020 code imported. The user's latest instruction is to
finish this slice and stop. Retain the local commit and short handoff, pause the active goal, and
start no other S3/S4 work, agent assignment, default switch, release or deployment.
