# Official SDK durability composition

[English](README.md) · [简体中文](README.zh-CN.md)

An isolated comparison of Pydantic AI **2.47.0** with DBOS **3.0.0** and Temporal Python
**1.33.0**. It uses the released `DBOSDurability` and `TemporalDurability` capabilities, a scripted
model, actual killed/restarted workers, disposable PostgreSQL and a parent-owned loopback event
counter. It imports existing engine-probe fixtures; nothing is wired into product dispatch.

## Run

Use Python 3.12+, Docker, a POSIX host and the verified official Temporal CLI1.9.1 described in
[the engine probe](../durable-execution/README.md). Install only in a separate environment:

```sh
python3 -m venv /tmp/openbot-sdk-probe-venv
/tmp/openbot-sdk-probe-venv/bin/python -m pip install -r experiments/sdk-durability/requirements.txt
/tmp/openbot-sdk-probe-venv/bin/python -B experiments/sdk-durability/probe.py --temporal-cli /path/to/verified/temporal
```

`--engine dbos` needs no Temporal executable; `--engine temporal` runs only that side.
`--keep` retains synthetic worker logs/configs and the result ledger for diagnosis. The parent still
removes its owned processes/container; the temporary database credentials cease to work afterward.
Without `--keep`, temporary files are also removed. SIGKILL of the parent can bypass cleanup; remove
only the named owned fixture resources, never a user's database or unrelated processes.

## Cases and independent checks

| Case | Required observation |
| --- | --- |
| DBOS ordinary function, crash before next model result | Read executes twice (negative control) |
| DBOS explicitly decorated function, same crash | Read once; completed first model request once |
| Temporal ordinary function, same crash | Read once through the official activity wrapper |
| DBOS/Temporal deferred wait boundary, worker absent | Decision persists; restored SDK history consumes the result and writes once |
| DBOS/Temporal revocation before restart | No write or final model request |
| DBOS portable workflow | Workflow uses portable JSON; SDK model steps still use native pickle in this configuration |
| All successful cases, completed engine ID reused | Recorded result; no additional model/tool effects |

The crash-before-next-model-result cases observe **four actual scripted model request attempts**
but SDK usage reports **three completed requests**. This is expected lost-result accounting, not
proof of three billed calls. Control-owned budgets and unknown-outcome reservations remain needed.

The waiting filesystem marker alone is insufficient: DBOS additionally confirms the waiting step
committed, and Temporal queries the workflow's waiting state. DBOS evidence describes the durable
deferral boundary, not instrumentation of the exact instruction inside `recv`. Temporal inspection
covers **activity-result payload encodings**, not every input/marker/history payload.

## Limits and next integration

The strategy shares the trusted workflow worker's process; this does not automatically connect the
existing separate Runtime stdin/stdout protocol. Native DBOS pickle is confined to synthetic trusted
history here, not an accepted product checkpoint format. Temporal still uses development SQLite
behind its Server, while domain fixtures use PostgreSQL; this is not production storage parity.

Signals/messages in this probe are deliberately simple decisions, not OpenBot's exact expiring
approvals. Its read-then-send revocation check does not protect concurrent revocation. It has no
product authority, shared budget, admission bridge, uncertain-write reconciliation, Artifact
publication, real model, browser or execution isolation. No production engine is selected.

The next reference journey uses Temporal's official adapter with a trusted workflow-side strategy,
control-owned model/tool ports, existing Task/Run/Action authority and verified file publication.
It must test the enqueue gap and reconcile a real fake-service write after a lost response, not
merely report an unknown outcome. DBOS plus the official deferred/JSON segment API remains a
candidate. See [research and decision](../../docs/research/sdk-durability-integration.md).
