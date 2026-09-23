# Public work journey recovery reference

[English](README.md) · [简体中文](README.zh-CN.md)

This is a reference integration of the real Python control API/store with Pydantic AI's released
Temporal adapter. It does not select the production engine or enable default dispatch. A trusted
workflow-side strategy calls control-owned activities. The existing stdin/stdout Runtime is not
implicitly connected. See [research](../../docs/research/work-temporal-journey.md).

## Run

Use POSIX, Node22+, Docker and Python3.12. Install the existing repository npm dependencies,
initialize the Python control environment according to its README, and build `@openbot/db`.
Obtain the verified Temporal CLI1.9.1 described in
[the pinned profile](../../docs/research/temporal-durability-review.md#executable-probe-profile-2026-09-23).
Use a separate experiment environment:

```sh
npm run build --workspace @openbot/db
python3.12 -m venv /tmp/openbot-work-reference
/tmp/openbot-work-reference/bin/python -m pip install -r experiments/work-journey/requirements.txt
/tmp/openbot-work-reference/bin/python -B -m unittest discover -s experiments/work-journey -p 'test_*.py' -v
/tmp/openbot-work-reference/bin/python -B experiments/work-journey/probe.py --temporal-cli /absolute/path/to/temporal
node scripts/test-python-control.mjs
```

The probe creates a digest-pinned temporary PostgreSQL17.11 container, a loopback Temporal
Server1.32.0 with disposable SQLite, the real control HTTP server and an independent SQLite-backed
HTTP effect fixture. It uses random test-only credentials, explicit config and owned temporary
roots; it does not load dotenv or use real accounts. Children and containers are removed on normal
completion/failure. No screenshots, transcripts or runtime databases are repository artifacts.
`--only-handoff` runs just the three identity collision cases.

## Released Server with PostgreSQL

Use `--engine postgres` instead of `--temporal-cli` to run the same eight cases against the
[digest-pinned deployment profile](../../deploy/temporal/README.md). This path adds explicit schema
and SQL-role checks, engine/database SIGKILL at approval, and a cold history/visibility backup
restored to a new volume after a write becomes unknown in the newer product database. The same
success counters remain five POST attempts, one write and 11 fixture units. Both namespace identity
and current public Task state are preserved.26 unit checks cover the reference and maintenance
preflight; the PostgreSQL journey is wired into the existing Linux Python CI job.

This is actual PostgreSQL persistence evidence on the local Docker reference, not production
selection, full-product backup or native Linux isolation. The CLI/SQLite path remains a separate
regression baseline. See the profile for maintenance constraints and remaining upgrade/security gates.

## What is exercised

| Case | Observed requirement |
| --- | --- |
| Recovery journey | Public login/Bot/Task creation; dispatcher killed before enqueue and after acceptance; retry verifies one retained workflow; worker killed at approval; approve while absent; API restart preserves the snapshot; external write commits but drops its response; public state shows reconciliation with reservation retained; worker and effect fixture restart; GET receipt verifies exact intent; independent CSV readback precedes final publication and authenticated download |
| Cancel before write | Public cancellation during durable approval wait; worker restart issues no write/final model request or artifact |
| Cancel unknown | Already-applied write remains recorded after public cancellation; reconciliation settles actual spend, then cancellation; no final model request or artifact |
| Corrupt receipt | Mismatched immutable intent fails the engine activity; business Task stays open/unknown with reservation, no artifact and no repeated POST |
| Publication acknowledgement | Kill after real publication commits but before activity acknowledgement; retry verifies identical completion without reopening execution; no duplicate artifact/event or external request |
| Handoff scope/type/queue collision (three cases) | An existing engine ID with unrelated inputs/type/queue is not acknowledged; the scope case also starts a live worker and proves no product action |

The successful reference makes exactly five POST attempts: three scripted model operations, a read
and a write. It counts one external write and 11 fixture usage units. These are fake bounded costs,
not paid-provider billing. Cancel-before-write counts three attempts / zero writes / six units;
cancel-unknown counts four attempts / one write / eight units. Corrupt-receipt retains six spent
and two reserved units. Attempts are counted independently, so provider-side deduplication cannot
hide a repeated POST.

`HandoffStore` is a control-only product adapter for existing pending admissions: bounded reads,
Task-row-locked acceptance and one audit event, same receipt idempotent, different receipt rejected.
Its 22 new PostgreSQL tests run in `test-python-control.mjs` (141 actual PG/HTTP checks in this
checkpoint). The experiment dispatcher handles only its explicitly configured Task from a bounded
batch. It is not the production dispatcher, a general work pool, or another recovery scheduler.
The dispatcher verifies the engine start event without needing a live worker. The workflow separately
checks its start identity in a trusted activity before any model/tool or control mutation; uniqueness lasts only while
engine history/namespace rules preserve the ID.

## Limits and next gates

This demonstrates integrated process recovery and real product-state persistence for the fixed CSV
journey. It does not qualify real model quality, arbitrary tools, Linux isolation, production Temporal
deployment security, TLS/ACLs, retention, full-product backup/restore, version upgrades, scaling,
resource cost or a real network partition. The only client exercised here is authenticated HTTP reconnect; browser/SSE
reconnect and shared client projections remain separate work. Bounded engine retry exhaustion is
not a business success or a refund. An unresolved Task needs an explicit reconciliation/recovery
operator path before production. File quotas/GC/storage durability remain open.
