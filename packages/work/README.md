# Work execution in TypeScript (P4)

English · [简体中文](README.zh-CN.md)

This package implements the new `OpenBotWorkTsV1` Temporal workflow, single-attempt handoff,
immutable start-history inspection and trusted Activity identity. Server-owned SQL admission and
fences live in `apps/server-ts/src/work-handoff.ts` and `work-execution.ts`. Model/tool policy,
receipts and publication remain Server responsibilities. No package imports an application.

The explicit P4 product candidate composes these Activities through the TS Server supervisor,
Work/source routes and sole Worker socket registry. It includes native/channel tasks, schedules,
root-first collaboration, retained harness policy and model/media/knowledge/plugin/web/browser/
approved-command tools. Python gates exclude new `typescript-v1` admissions; existing admissions
remain `python-v1`, and SQL rejects changing their owner. Startup requires a complete paginated
SQL/Temporal drain of legacy obligations before new TS admission.

Desktop v8 selects the same composition and requires its private engine configuration. The
canonical macOS arm64 candidate is installed and has passed actual authenticated startup,
normal paired-service shutdown and restart. Actual protected Linux/runsc command and isolated
browser acceptance also passed, including original expiry and complete owned cleanup. Unified
review requires all hosted checks on the actual PR HEAD; Python retirement remains P5. See
[the accepted decision](../../docs/decisions/0050-typescript-control-plane.md) and
[implementation evidence](../../docs/research/typescript-control-plane-p4.md).

## Checks

From the repository root, with the existing pinned Worker Python environment and Docker available:

```sh
npm test --workspace @openbot/work
npm run test:work:ts
```

The second command builds cold prerequisites and reuses the repository's PostgreSQL-backed
Temporal 1.32.0/mTLS fixture. It creates private test certificates, isolated databases and uniquely
owned Docker resources; cleanup runs on completion/failure/termination. It does not install tools,
connect to configured product data, call paid providers or download an automatic test server.
`OPENBOT_TEMPORAL_TEST_PYTHON` may select the existing verified Worker interpreter; otherwise the
command uses `apps/server-python/.worker-venv/bin/python`.

The probe exercises real SQL/SDK/Temporal, concurrent reservation, cross-owner refusal, lost start
reply recovery, Worker replacement, durable wakeup, stale fences, Continue-As-New chain identity
and official exported-history replay. Product journeys also cover public Task/report download,
all runtime tool families, channel/schedule/source ownership, collaboration expiry and five actual
process SIGKILL recovery windows. A controlled tree-close acknowledgement race verifies successful
closure and refusal on failed closure, then replays both histories. Provider responses and selected
peers remain synthetic; actual native command/browser qualification runs separately in the owned
Linux CI fixture. These checks do not establish model quality or cross-language history replay.

A production composition must provide explicit authenticated engine transport and a distinct TS
queue, derive facts with `currentBinding()` inside remote Activities, and check the SQL binding
and current authority before every model/tool admission or publication. Wakeup signals carry no
authority. Unknown starts are inspection obligations; repeated high-level start calls are refused.
Keep every existing Python history, timer, child and Continue-As-New chain on its original worker
until the full drain gate passes. Run UI acceptance with `PASS 12/12` before any public group cutover.
