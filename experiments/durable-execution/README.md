# Durable execution qualification

[English](README.md) · [简体中文](README.zh-CN.md)

This is an isolated DBOS 3.0.0 candidate experiment, not an OpenBot dispatcher. It tests actual
SIGKILL and restart with a disposable PostgreSQL 17.11 container and a loopback HTTP effect service.
No model, user database, private configuration or production provider is used. The engine has
not been selected for production. See the [source review](../../docs/research/durable-execution-qualification.md).

## Run

Use Python 3.12+ and a running Docker daemon on a POSIX host. Install only in a separate environment:

```sh
python3 -m venv /tmp/openbot-durability-venv
/tmp/openbot-durability-venv/bin/python -m pip install -r experiments/durable-execution/requirements.txt
/tmp/openbot-durability-venv/bin/python experiments/durable-execution/probe.py
```

Requirements pin the complete resolved dependency set for the reference environment. They do not
change either product virtual environment. The fixture image is digest pinned. The command creates
only a uniquely named container with a loopback port and volatile database storage; its `finally`
cleanup removes that container and owned temporary files. It never accepts a user database URL.
An uncatchable termination of the parent may leave an `openbot-durability-*` fixture container.

## Evidence and limits

Local run on 2026-09-23: ten cases passed using Python 3.12.13 on macOS, PostgreSQL in Docker.

| Case | Observed effect | Meaning |
| --- | --- | --- |
| Checkpoint then kill/restart | Preparation once, write once | Completed step output survives worker death |
| Reuse completed workflow ID | No additional write | Completed workflow output is reused |
| Unsafe post-write crash | Write twice | Negative control: no exactly-once external-effect guarantee, even with exception retries disabled |
| Guarded post-write crash | Write once; needs reconciliation | Durable intent prevents blind repeat |
| Guarded pre-write crash | Zero writes; needs reconciliation | Conservatively blocked; cannot infer external truth from an intent alone |
| Approval while worker is absent | One write after recovery | Message persists without that worker |
| Revoke authority before approval recovery | Zero writes | This step rechecks current fixture authority |
| Suspend old executor, allow successor, resume old executor | Old executor still writes | Negative control: domain intent alone does not fence external execution |
| Same suspension with executor epoch check | Old write rejected | The effect boundary must enforce the current generation |
| Cancel an in-flight synchronous step | Existing write retained, next effect absent | Cancellation does not undo an external action |

The guard is a deliberately small experiment. It has no production leases, authenticated fencing, automatic reconciliation,
production authority/approval service or safe upgrade strategy. Its read-then-send authorization
check does not solve concurrent revocation. The fake effect server stays alive through worker
crashes and is not itself a durable external system. A guarded unknown result ends this *probe*
workflow; a real Task must remain unresolved, not become product success. No real Agent Runtime,
Web/Desktop reconnect, malicious execution isolation, performance, Linux Python worker, engine
upgrade, real network-partition recovery or multi-host support is established. The takeover case
suspends a still-live worker with SIGSTOP and resumes it with SIGCONT after a simulated takeover;
it does not test failure detection. The fake endpoint checks an in-memory epoch, not a production
credential/ticket. An initial attempt with both queue pollers running timed out; it supplied no
valid takeover evidence and was replaced with this controlled suspension case. Waiting approval is exercised
across process death, not automatic eviction of idle workflows. Those remain selection gates.
