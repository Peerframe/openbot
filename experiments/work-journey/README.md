# Public work journey recovery reference

[English](README.md) · [简体中文](README.zh-CN.md)

This reference connects the real Python control API/store to the Runtime's opt-in Temporal
composition. Runtime PortModel/PortToolset execute scripted model/read steps; deferred write
proposals return to the existing control-owned approval, effect verification and Artifact
publication path. Typed Run deps are rechecked against the actual accepted engine identity before
ports are loaded and at authority checkpoints. Per-activity guards do not replace the durable
control budget. Temporal is the selected target recovery owner (ADR0046); no production default
is activated and the standalone stdin/stdout profile remains separate. This is still a fixed
scripted task, not a general product Worker or real provider integration. See
[research](../../docs/research/work-temporal-journey.md).

The initial read-only activity now waits for an acknowledged handoff even when the Worker is
already running. It uses the product startup loader, an independent 120-second total retry bound,
and terminal identity/authority refusals. `--only-case worker-before-ack` observes a real pending
failure with zero port calls, restarts the Worker and completes after acknowledgement;
`--only-case cancel-before-ack` confirms that a late acknowledgement cannot reopen cancellation.

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
`--only-handoff` runs the unconfirmed-history case and three identity collision cases.

## Released Server with PostgreSQL

Use `--engine postgres-mtls` (requires OpenSSL on PATH) instead of `--temporal-cli` to run the current case matrix against the
[digest-pinned deployment profile](../../deploy/temporal/README.md). This path adds explicit schema
and SQL-role checks, engine/database SIGKILL at approval, and a cold history/visibility backup
restored to a new volume after a write becomes unknown in the newer product database. The same
success counters remain five POST attempts, one write and 11 fixture units. Both namespace identity
and current public Task state are preserved.38 unit checks cover the reference, replay and transport
preflight; the mTLS PostgreSQL journey is wired into the existing Linux Python CI job.

This is actual PostgreSQL persistence evidence on the local Docker reference, not production
selection, full-product backup or native Linux isolation. The CLI/SQLite path remains a separate
regression baseline. See the profile for maintenance constraints and remaining upgrade/security gates.

The mTLS profile rejects untrusted/no-certificate/plaintext connections and wrong hostnames, then
rotates the client CA while a task waits for approval. New credentials resume the same workflow;
retired credentials fail. It authenticates trusted control peers only, not per-API privileges.
`--engine postgres` is the explicit plaintext alternative. The recovery case fetches actual
waiting/completed histories and runs the official offline Replayer with the current SDK plugin;
a deliberately incompatible first command must fail with NondeterminismError. Snapshots and fake
HTTP counters must not change. Histories stay in memory, and no activities are registered for replay.
This verifies these histories, not arbitrary future workflow/SDK upgrades.

## Adjacent engine releases

Add `--upgrade-archive /absolute/path/to/temporal_1.31.3_linux_<architecture>.tar.gz` to the full
`postgres-mtls` command. It rejects the handoff-only mode. The [profile](../../deploy/temporal/README.md#adjacent-release-qualification)
documents exact provenance, the mandatory 600-second old-server health observation, unchanged
schema contents and separate original-volume/older-snapshot checks. Two extra tasks cover pending
approval and committed publication across both stages (four additional case records). The then-current
eight scenarios were exercised in that earlier qualification; the new reconciliation cases have not
been qualified across adjacent engine releases. Histories replay at each boundary without extra effects.
This is a stopped 1.31.3-to-1.32.0 upgrade, not a general update service.

## What is exercised

| Case | Observed requirement |
| --- | --- |
| Recovery journey | Public login/Bot/Task creation; dispatcher killed before enqueue and after acceptance; retry verifies one retained workflow; worker killed at approval; approve while absent; API restart preserves the snapshot; external write commits but drops its response; public state shows reconciliation with reservation retained; worker and effect fixture restart; GET receipt verifies exact intent; independent CSV readback precedes final publication and authenticated download |
| Cancel before write | Public cancellation during durable approval wait; worker restart issues no write/final model request or artifact |
| Cancel unknown | Already-applied write remains recorded after public cancellation; reconciliation settles actual spend, then cancellation; no final model request or artifact |
| Corrupt receipt | Mismatched immutable intent fails the engine activity; business Task stays open/unknown with reservation, no artifact and no repeated POST |
| Explicit repair of corrupt receipt | Owner records a lookup-only command through the public route; a first unresolved cycle retains unknown and the reservation, then a second independently verified receipt finishes the same Action with one write |
| Malformed JSON and repair | A response too malformed or deeply nested to parse is not a success; the Task remains open with its reservation until a later receipt lookup verifies the existing write |
| Repair timeout | Repeated bounded engine activity timeouts leave unknown pending; a later verified lookup finishes without a second write |
| Automatic/manual race | Automatic verification and Owner lookup settle the same Action/command without double completion or write replay |
| Repair after cancellation | A lookup records historical applied facts and spend but never restores authority or publishes a cancelled Task |
| Closed engine | A stored Owner command starts a separate command-scoped, lookup-only Temporal workflow after the original workflow closes. A bad receipt leaves the Action unknown; a new command after receipt repair verifies the original write without a second POST or resuming the ended Agent |
| Publication acknowledgement | Kill after real publication commits but before activity acknowledgement; retry verifies identical completion without reopening execution; no duplicate artifact/event or external request |
| Handoff scope/type/queue collision (three cases) | An existing engine ID with unrelated inputs/type/queue is not acknowledged; the scope case also starts a live worker and proves no product action |

The successful reference makes exactly five POST attempts: three scripted model operations, a read
and a write. It counts one external write and 11 fixture usage units. These are fake bounded costs,
not paid-provider billing. Cancel-before-write counts three attempts / zero writes / six units;
cancel-unknown counts four attempts / one write / eight units. Corrupt-receipt retains six spent
and two reserved units. Attempts are counted independently, so provider-side deduplication cannot
hide a repeated POST.

`HandoffStore` is a control-only product adapter for committed admissions. It records one durable
submission attempt under the Task lock before contacting Temporal, returns never-attempted and
unconfirmed rows separately, and acknowledges only a matching verified engine reference. A lost
response leads to history lookup, never a second start request; a missing history remains unresolved.
The affected PostgreSQL/HTTP control suite ran 189 checks at this checkpoint. The experiment
dispatcher handles only its explicitly configured Task, using an exact lookup for a prior
submission. It is not the production dispatcher, a general work pool, or another recovery
scheduler. The dispatcher verifies
the engine start event without needing a live worker. The workflow separately
checks its start identity in a trusted activity before any model/tool or control mutation; uniqueness lasts only while
engine history/namespace rules preserve the ID.

The reference dispatcher now calls the product `work_dispatcher.dispatch_one` for its one-Run
handoff decision. Its injected Temporal adapter verifies the start event and actual namespace;
the reference retains crash barriers for testing. This does not install a production dispatcher
or connect the fixed strategy to the real Python Runtime.

A targeted crash after reservation but before enqueue leaves the Task unconfirmed; redelivery
finds no history and creates no replacement workflow. This and three start-identity collisions
passed with both the development and PostgreSQL/mTLS engines. The recovery case passed on both
engines with one external write. The full historical matrix was not rerun for this change.

## Limits and next gates

This demonstrates integrated process recovery and real product-state persistence for the fixed CSV
journey. It does not qualify real model quality, arbitrary tools, Linux isolation, production Temporal
deployment authorization/PKI, retention, full-product backup/restore, version upgrades, scaling,
resource cost or a real network partition. The only client exercised here is authenticated HTTP reconnect; browser/SSE
reconnect and shared client projections remain separate work. Bounded engine retry exhaustion is
not a business success or a refund. An unresolved Task needs an explicit reconciliation/recovery
operator path before production. The explicit Owner reconciliation route can also start a command-scoped lookup after a closed reference workflow. It settles historical Action facts only; it does not resume the original Agent, complete the Task, or qualify a production dispatcher. File quotas/GC/storage durability remain open.

The earlier fixed-workflow candidate passed 15 case records through both the development engine and the PostgreSQL/mTLS engine, including a cold engine backup/restore with accepted-but-unfinished command redelivery. The new closed-history case passed a targeted public API/PostgreSQL/Temporal run on both engines, including lost delivery acknowledgement and two explicit lookup cycles. After the Activity-to-Action seam was connected, the full 16-case development-engine matrix passed on the candidate identified in the final research section. The PostgreSQL/mTLS matrix and adjacent-release lane have not been rerun on that candidate. These are fake external effects, not real Linux/runsc isolation.

The earlier explicit adjacent-release path passed twelve case records, 57 reference unit checks and eleven
offline histories on arm64. It covers the fixed stopped 1.31.3 -> 1.32.0 upgrade with identical PG
schemas; amd64 CI and broader release/worker-code compatibility remain unverified.

## Shared Worker acceptance

`--only-case concurrent-runs` uses one Worker, Agent and queue without a configured Task/Run ID.
The Worker-only `work_runtime_ports` factory reloads accepted Task context and trusted services
for each activity; rechecks authority after awaited configuration; detaches nested schemas;
and keeps model and inline tool catalogs separate. Service assembly cannot execute effects.
The callback still uses durable control Action admission and settlement; activity guards are not
whole-Run budgets. Ordinary HTTP startup does not import this optional composition.

The public API starts two Tasks with different objectives and limits. Both tool activities must
be running simultaneously on their first attempt before one Task is cancelled. Its next effect
is refused; the other Task completes, settles its own usage and downloads its own artifact.
Both histories replay without state changes or effects. This proves cancellation, routing and
accounting isolation with scripted ports. It does not test low-budget rejection, live providers,
generic operation identities, restart at publication or Linux/runsc. Fixed reference keys and
publication in `multitask_worker.py` are fixture policy, not a production Worker activation.
Run with the pinned development CLI above, or `--engine postgres-mtls`; CI includes the latter.


## Durable model reply qualification

Install `requirements-model.txt` instead of `requirements.txt` for the optional SDK profile, then run
`python -B experiments/work-journey/probe.py --engine postgres-mtls --only-case model-receipt-recovery`.
This uses the released model SDK with synthetic HTTP and no live credentials. The public Task
survives Worker death after immutable reply persistence, reuses it after claim expiry without a
second provider call, settles once and delivers its file. Missing/corrupt reply and cancelled-task
counterexamples live in `apps/server-python/tests/test_work_model_receipts_postgres.py`; pass the
isolated SDK interpreter as `OPENBOT_TEMPORAL_TEST_PYTHON` to the existing control database runner.
See [the reviewed boundary](../../docs/research/work-model-ports.md). New engine Run chains,
production service configuration and live provider quality remain separate gates.

## Product Worker recovery cases

The optional `openbot_server.work_worker.product_worker` composition registers one product
Workflow/Agent with required trusted service and independent result-verifier callbacks. These
cases use synthetic callback implementations; no test fixture is required by product source.
`product-model-recovery` kills the Worker after storing a model response and before engine
acknowledgement. `product-publication-recovery` dispatches through the actual product CLI,
commits a verified Artifact, then kills the Worker before publication acknowledgement. On retry,
all service/verifier callbacks deliberately fail if called; the original result must be read back.
The 110-second result wait covers the actual 75-second Activity timeout before engine retry.

```sh
/tmp/openbot-work-reference/bin/python -m pip install -r experiments/work-journey/requirements-model.txt -r apps/server-python/requirements-worker.txt
/tmp/openbot-work-reference/bin/python -B experiments/work-journey/probe.py --engine postgres-mtls --only-case product-model-recovery
/tmp/openbot-work-reference/bin/python -B experiments/work-journey/probe.py --engine postgres-mtls --only-case product-publication-recovery
```

Product-only dependencies are `apps/server-python/requirements-worker.txt`; the experiment
profile additionally supplies fixture dependencies. Operator invocation is
`python -I apps/server-python/scripts/dispatch-work.py --config /absolute/operator.json`;
add `--check` for local-only structural/file-permission validation (not TLS connectivity).
The private JSON requires `database_url`, `temporal_address` (host:port), `namespace`, `queue`,
and `tls` with absolute `ca`, `certificate`, `key` files and `server_name`.
Optional bounds are `limit` (1–64, default16), `execution_timeout_seconds` (1–86400, default3600),
`item_timeout_seconds` (1–30, default10). Config/key files must be owned/private; all TLS files
must be regular, owned and not writable by other users. The CLI does not migrate databases or
start a Worker; callbacks must be explicitly composed by trusted deployment code.
Exit0 means every reported dispatch was acknowledged (including an empty pass); exit2 retains
unconfirmed/error deliveries; exit1 is a refused or failed invocation. No result implies Task
completion. Repeating the command retains the existing handoff history policy.

This is opt-in S3 integration evidence, not default activation, arbitrary-task verification,
production service configuration, general approval/correction continuation or Linux/runsc proof.

`product-concurrent-runs` reuses the existing two-Task cancellation contract on the product Worker,
with scripted ports and unchanged budget/effect/Artifact assertions.


### Deferred approval recovery

`--engine postgres-mtls --only-case product-deferred-approval` exercises the product Worker
with synthetic model/effect services and actual public HTTP, PostgreSQL and Temporal. It kills
preparation after the Action commits and approves while the Worker is absent. The replacement
planner is disabled: retry must reuse the original Action. A malformed receipt keeps the effect
unknown and reserved; a persisted Owner command later performs lookup-only reconciliation.
Another Task is cancelled after approval without a write. Denial closes a Task, then a kill before
stop acknowledgement verifies terminal readback. The test verifies engine Activity attempts,
public file download, budget settlement and replay without additional effects.

Run focused workflow checks with `python -B -m pytest -q experiments/work-journey/test_product_deferred_workflow.py`. The owned PostgreSQL
runner includes the optional deferred tests when `OPENBOT_TEMPORAL_TEST_PYTHON` selects the
pinned Worker environment. Real provider accounts and Linux/runsc isolation are not exercised.
See [candidate evidence and failures](../../docs/research/work-deferred-approval.md).

### Closed-workflow lookup recovery

`--engine postgres-mtls --only-case product-closed-repair` uses the actual operator CLI,
public HTTP and PostgreSQL with synthetic model/effect services. It cancels an unknown-effect
Task, waits for the original Workflow to close, and keeps the first bad-receipt command unresolved
without releasing its reservation. A new Owner command verifies the original write. The Worker
is killed after settlement but before acknowledgement; the replacement has lookup disabled.
The exact Activity must complete on retry without scheduling the fallback finish Activity or
invoking another lookup. Both repair histories and the original history replay without effects.
This is historical fact recovery, not resumed Agent execution or real provider/isolation evidence.
The operator's `--repair-closed` mode requires `load_lookup` registration on the same product
Worker; delivered/finished/waiting-original rows are distinct, and exit0 is not effect success.
See [candidate evidence](../../docs/research/work-closed-repair.md).

### Owner correction recovery

`--engine postgres-mtls --only-case product-owner-corrections` exercises the opt-in product
profile through the real public API, PostgreSQL and Temporal with scripted providers. Three
concurrent Tasks distinguish correction during preparation, during unknown-effect waiting, and
before model admission/after model receipt/while verifying publication. Owned Worker crashes
must preserve the original model receipt, superseded proposals, complete deferred-call pairing,
lookup-only Owner commands and exact publication acknowledgement. Histories replay without effects.
A stored command is not a semantic-quality claim. Existing full-history limits remain in force;
no real account or Linux isolation is exercised. See [scope and evidence](../../docs/research/work-owner-corrections.md).
