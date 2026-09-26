# Product closed-workflow reconciliation

- Parent:6f69be9, 2026-09-24. Implementation gate, not acceptance.
- Reuse the previously reviewed Temporal Python1.33.0 (MIT), pinned commit ab52fdde33ee8ed193402625bfdba25d240a762d; same PostgreSQL Action/ReconciliationStore and product Worker. No new dependency, schema, copied upstream source or scheduler.
- Research reused: work-reconciliation-commands.md (including actual closed-history reference) and work-product-worker.md. Rechecked GitHub temporalio/sdk-python WorkflowIDReusePolicy/WorkflowAlreadyStartedError and official workflow identity/retention documentation. Sources: https://github.com/temporalio/sdk-python/tree/ab52fdde33ee8ed193402625bfdba25d240a762d and https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx . REJECT_DUPLICATE is retention-bounded; persisted command facts remain authoritative.

## Accepted implementation boundary

Use the existing finite operator CLI with an explicit closed-repair mode. The same product Worker registers the original and separate command-scoped repair Workflow; do not run incompatible registration sets on one queue. The repair activity receives only four bounded IDs, binds its actual SDK execution to its exact immutable start, then verifies the original workflow using the PG-recorded first Run ID, never latest history. Original acknowledged attempt, references, namespace, queue, type and start input remain mandatory. A historical binding skips active-state admission only and returns no execution authority.

The trusted repair loader exposes only lookup and independent verification, with detached historical context and original intent. No model, claim, proposal, admission, apply, artifact publication or original workflow restart is reachable. Existing delivery references survive handover. Finished commands return their original outcome even when a later cycle resolved the Action. Missing/bad/timeout evidence remains unknown with the reservation; a bounded cycle ends unresolved. A closed repair with an unfinished command may record only its current verified terminal state or unresolved, after exact history verification, so an owner can request a new cycle.

Independent read-only review fixed queue registration, exact first-Run identity, preserved delivery references, immutable finished outcomes and sufficient timeout for finalization before implementation. Validate entry locally, then owned PostgreSQL, then frozen real mTLS workflows: cancelled/revoked source, bad receipt followed by a new cycle, and commit-before-ack crash with zero new lookup on replay. Existing public approval and unknown semantics remain unchanged.

## Current ownership

Codex owns S3 implementation and independent-review integration. Separate project threads own S2 client files, S4 isolated executors and S5 memory/skill modules. User approved resumed parallel work after the earlier pause; no default switch, production migration or release is implied.

## Candidate and executed validation

Parent `6f69be91185a08350ca52964c3f0543ef51f0020` plus the files below, tested before commit.
The 14-file manifest was frozen before the long test and matched after completion; documentation
and CI registration were updated separately. Independent review accepted only historical lookup
recovery, with no reopening of authority or Agent execution.

| Check | Actual result | Local log |
| --- | --- | --- |
| Focused repair dispatch and CLI entry tests | Initial 11 passed; expanded CLI/entry run 23 passed, exit0 | `/private/tmp/openbot-closed-entry-20260924-01.log`, `-02.log` |
| `OPENBOT_TEMPORAL_TEST_PYTHON=<pinned-worker-python> node scripts/test-python-control.mjs` | Base302 passed, 2 optional-SDK files skipped; separate installed-SDK157 passed; actual PG/HTTP/TS compatibility passed, exit0 | `/private/tmp/openbot-closed-postgres-20260924-01.log` |
| Journey `--engine postgres-mtls --only-case product-closed-repair` | Actual CLI, cancelled source, unresolved then resolved cycles, crash after commit, same Activity acknowledgement recovery and replay passed, exit0 | `/private/tmp/openbot-closed-product-mtls-20260924-01.log` |
| Affected existing journey `--engine postgres-mtls --only-case product-deferred-approval` | Actual approval/denial recovery, unknown lookup, cancellation and replay passed, exit0 | `/private/tmp/openbot-closed-approval-regression-20260924-01.log` |
| `npm run check` before documentation finalization | Exit0; repository prerequisites executed; Turbo typecheck31/31, test31/31 and build18/18 were cache hits. Cached test output is not a new test execution. | `/private/tmp/openbot-closed-check-20260924-01.log` |

The journey commands use `python -B experiments/work-journey/probe.py` in the existing pinned
Temporal/Pydantic environment. Worker dependencies were installed in a separate clean Python3.12
profile from the product lock; unrelated dirty model-service dependencies were not used as evidence.
No paid model, provider account or Linux/runsc executor was exercised. The mTLS probes use an owned
disposable PostgreSQL/Temporal fixture and synthetic HTTP effects. No production state changed.

### Review corrections and retry meaning

Before the long run, review required waiting for the actual original Workflow to close instead of
asserting premature Task cancellation: an unresolved external Action retains its reservation.
The recovery fixture also checks the new Worker's lookup marker is absent, that the original repair
Activity completed, and that no fallback finish Activity was scheduled. A mere successful Workflow
result could otherwise conceal a failed lookup. These assertions were fixed before the long run;
neither real journey failed or was rerun. The expanded entry check added actual CLI configuration
coverage. Temporal's retry after the intentional Worker kill is the tested recovery behavior, not a
failed development-tool invocation. There were no failed product/PG test runs in this slice.

### Frozen source hashes (SHA-256)

- `apps/server-python/src/openbot_server/work_engine_binding.py`: `11c2d4e3e457c7f294ed7dd79e419ce665dc85174364fd8e4625e987c05599ad`
- `apps/server-python/src/openbot_server/work_worker.py`: `f55db35b9b21d2641745b38381317fab8e20ad035ac12fc868c8815151865239`
- `apps/server-python/src/openbot_server/work_repair_binding.py`: `48c1daa3281fa6de92563dcab2638b395df1f87211b6d7826b10fc09d4ba086e`
- `apps/server-python/src/openbot_server/work_closed_repair.py`: `d373d3dfd1c653d50a5ea7f329c43f0bb4b0c8f896551cadc624ee19d856caaa`
- `apps/server-python/src/openbot_server/work_repair_dispatch.py`: `7eeed5a7993674728fc52824672dc6cc29253e57519f7605c27ebd5ee3b057f8`
- `apps/server-python/scripts/dispatch-work.py`: `91ef4f6ea171c4df9e949995255aff84c0a9065323e432fae0a175e95135b1b4`
- `apps/server-python/tests/test_work_repair_dispatch.py`: `9389c14d60611c3bfbc1c0b5da23adf7ede143765b8ffd3d74e4b37f2759a224`
- `apps/server-python/tests/test_work_closed_repair_postgres.py`: `47cc21b76343f50c07d88b2938286e7cc9810942a06421e60422217690b6afdd`
- `apps/server-python/tests/test_work_dispatch_entry.py`: `60bff4b4097b24df04504e6886f58e6b33b3b38673fd5e5dfda6bb0d8618d85f`
- `scripts/test-python-control.mjs`: `9fe3280a483e4f1ac2a3af2fbf7590cae3debf184d63f3202240c4eb6c863670`
- `experiments/work-journey/product_closed_probe.py`: `909cb0f29136cc1e4e1eac3cdba5a847ccfd0977c4fc1b496fbadd348c3b5f91`
- `experiments/work-journey/product_approval_worker.py`: `e1166de06475f00f19adf2d052fc108c92a9268a1fe61e2e1c1f667774a2a868`
- `experiments/work-journey/product_dispatch_entry.py`: `06c7a8bd970903372d7ee388a8041ba4f8a4d90ddaaf107a0e2d7f8938f5b64b`
- `experiments/work-journey/probe.py`: `a7cc207d5b052fa56de454d089aeb2f7bc0755067267c30fb23a8b4d1724d29c`
