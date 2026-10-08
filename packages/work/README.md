# Work execution in TypeScript (P4)

English · [简体中文](README.zh-CN.md)

This package implements the new `OpenBotWorkTsV1` Temporal workflow, single-attempt handoff,
immutable start-history inspection and trusted Activity identity. Server-owned SQL admission and
fences live in `apps/server-ts/src/work-handoff.ts` and `work-execution.ts`. Model/tool policy,
receipts and publication remain Server responsibilities. No package imports an application.

This is an integration in progress, **not an enabled product runtime or completed P4**. Current
Activities are composed only by the explicit synthetic control qualification. No public route,
Desktop startup, product supervisor or existing Python workflow changes owner. Python handoff and
Activity gates exclude newly created `typescript-v1` admissions; existing admissions default to
`python-v1`, and SQL rejects changing an admission's owner. Child task execution is refused by the
initial TS control adapter until root-first collaboration authority is ported.

The next product checkpoint is native Owner Task creation through model/report execution and
verified artifact download. Remaining P4 includes the harness strategy, all runtime tools, public
Work/source routes, Worker sockets, supervision, packaging and complete Python history drain.
See [the accepted decision](../../docs/decisions/0050-typescript-control-plane.md) and
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
reply recovery after cancellation, Worker replacement, durable wakeup, stale fences,
Continue-As-New chain identity, exported-history replay and the start/acknowledgement race. Its
synthetic `advanceWork` Activity proves those engine/control contracts only; it does not prove
model quality, tool effects, public Task completion or cross-language history replay.

A production composition must provide explicit authenticated engine transport and a distinct TS
queue, derive facts with `currentBinding()` inside remote Activities, and check the SQL binding
and current authority before every model/tool admission or publication. Wakeup signals carry no
authority. Unknown starts are inspection obligations; repeated high-level start calls are refused.
Keep every existing Python history, timer, child and Continue-As-New chain on its original worker
until the full drain gate passes. Run UI acceptance with `PASS 12/12` before any public group cutover.
