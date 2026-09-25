# Python base / Worker collection gate repair

2026-09-25. Scope: test selection only. No production, dependency, schema, authority or oracle changes.

## Evidence and selected reuse (before implementation)

The CI failure occurs in `apps/server-python/scripts/check.sh -q`, before the optional Worker environment bootstrap, because `pytest` recursively collects every module. Seventeen modules now import Temporal, Pydantic AI or `openbot_agent_runtime` directly or transitively. The base lock deliberately excludes these dependencies; adding them would violate the reviewed profile separation. Sixteen failing files already belong to the existing Worker PostgreSQL invocation; `test_work_collaboration_deadline_replay.py` is absent. `test_temporal_engine.py` also relies on `importorskip` in base and is absent from that Worker list.

Reuse `docs/research/python-control-read-slice.md` (separate base environment, pytest8.4.2, MIT) and `docs/research/work-product-worker.md` (opt-in Worker profile, Temporal1.33.0 and Pydantic AI2.47.0). The reuse ledger records both profiles. Read the official [pytest collection options](https://docs.pytest.org/en/8.4.x/example/pythoncollection.html#ignore-paths-during-test-collection) and [8.4.2 implementation](https://github.com/pytest-dev/pytest/blob/8.4.2/src/_pytest/main.py). Released `--ignore` excludes named paths before module import, while explicit file arguments select the Worker suite. These documented APIs already close this gate gap; no plugin, new dependency, modified test skip or copied upstream source is needed. The existing local pytest package matches8.4.2 and retains its MIT notice.

Use one checked-in plain-text Worker file list, relative to `apps/server-python`, shared by base `check.sh` exclusions and the existing owned PostgreSQL Worker invocation. Preserve every original Worker file and order, including root's just-added `deploy/server/test_product_container.py`; add the two omitted Temporal files. Both readers reject missing entries; Node rejects duplicate entries. Base prints the delegated file count and required separate gate. CI already bootstraps the Worker closure and sets `OPENBOT_TEMPORAL_TEST_PYTHON` on `test:control:python`; preserve that workflow and fixture isolation. Without that variable, the existing optional local gate will explicitly report Worker execution was not performed, rather than silently implying full acceptance.

Validate with exact-lock base and Worker interpreters, no fixture variables, collection-only for the complete respective selections, explicit file/node-id accounting, and focused non-database tests. PostgreSQL acceptance remains the existing CI gate and is not claimed from collection. The replay module's pre-existing history-input skip remains visible and is not newly bypassed.

## Full base execution: three stale contract assertions

The actual base entry subsequently executed1289 cases successfully and exposed three assertions
left behind by commit `778236bdb01014f62aa590e22389263a4c5ec4ee`. Current domain/protocol includes
the `model` computer profile and optional `{connectionId,modelId}` Bot selection. Original fields
retain legacy projection behavior; the frozen old `toBot` does not project this new selection and
is not modified or presented as its oracle. Reuse the Python model-services/task-profile reviews.
Tests now pin the current public selection, omission when absent and refusal of malformed/private
fields without allowing configuration, keys or system prompts into the public DTO.

The persisted context loader intentionally accepts32768 UTF-8 bytes, matching the trusted source
admission path for existing8000-codepoint Run instructions. Public native Task admission retains
16384 bytes and has no caller-selectable `source` flag. The old16385-byte rejection expectation
was stale. Reuse the task-authority/source review and `work_store.create_in_transaction` contract;
test exact32768 acceptance and32769 refusal for ASCII, Chinese and emoji, plus legitimate16385
readback. No production, authority, dependency, schema or frozen oracle is changed. All175 tests
in these two files passed in the exact base environment. Root repeated the real base entry successfully:1304 passed,453 fixture-dependent skips.
The independent owned PostgreSQL base profile also passed826 cases with2 optional skips.

Final integrated owned PostgreSQL execution passed826 base cases (+2 optional skips) and1489
Worker cases (+1 missing-history fixture skip), with real HTTP, session issuance/revocation and
read parity. The full `npm run check` also passed. These are actual local executions; the next
hosted run separately validates the clean Linux CI bootstrap and native container matrix.

## Hosted bootstrap conflict — 2026-09-26

CI currently passes both `experiments/work-journey/requirements-model.txt` and `apps/server-python/requirements-worker.txt` to the same pip invocation. The former recursively includes `sdk-durability/requirements.txt` -> `durable-execution/requirements-temporal.txt` -> `requirements.txt`, whose DBOS3.0.0 experiment pins websockets17.1. The product closure pins17.0.1; pip correctly refuses. Even arbitrarily aligning those versions would introduce DBOS/SQLAlchemy/greenlet into the exact63-distribution product environment and fail `verify_environment.py --worker`.

Read `docs/OPEN_SOURCE_REUSE.md` (durability experiments and product Worker sections), `docs/research/work-product-worker.md`, `work-model-ports.md`, `work-temporal-journey.md`, and `temporal-postgres-operations.md`. The accepted product Worker deliberately excludes the discarded DBOS experiment dependency and composes Temporal1.33.0, Pydantic AI2.47.0 and the current control/Runtime lock. Existing successful local product checks use the63-distribution Worker separately from the52-distribution base API environment. Reuse those exact locks, without new resolutions or upgrades.

Trace: `work-journey/probe.py` imports `durable-execution/probe_temporal.py`, which imports disposable database/polling/effect helpers from `durable-execution/probe.py`. Only that last module's DBOS `qualify()` uses `DBOSClient`/`WorkflowSerializationFormat`; the common helpers and all Temporal routes do not. Move that import to the start of DBOS `qualify()` so importing common fixtures does not require the unused engine. The original DBOS requirements and execution behavior remain intact when its own experiment is invoked. No helper duplication, alternate engine or interpreter selector is introduced.

Downstream interpreter audit: `work-journey/probe.py:launch` uses `sys.executable` for all Worker/dispatch subprocesses; `product_dispatch_entry.py` again uses `sys.executable` for the real product `dispatch-work.py`. Therefore starting the probe with the exact Worker interpreter keeps every product child in the same63-pin environment. `API.start` intentionally uses the separate existing `apps/server-python/.venv/bin/python` for its base work API. No new ambient path, account configuration or provider credential is used. Add explicit existing repository source roots to the adjacent qualification step so mixed-directory pytest/unittest entrypoints can import both source packages independently of collection order.

## Primary source reuse

Python3.12 [venv](https://docs.python.org/3.12/library/venv.html) documents isolated site-packages and absolute interpreter invocation; [sys.executable](https://docs.python.org/3.12/library/sys.html#sys.executable) identifies the active interpreter. Reviewed project pins remain Python3.12.13, Temporal1.33.0, Pydantic AI2.47.0 and pytest8.4.2; no update is inferred from the documentation site's newer patch label. No upstream source is copied. Existing MIT OpenBot helper is narrowed with a local import using standard Python semantics.

## Chosen gate

Install only the existing `requirements-worker.lock` in the fresh CI reference venv, then run pip check and the unchanged exact Worker verifier. Keep the actual PostgreSQL gate and every adjacent qualification command. Check the real `work-journey/probe.py --help` before the expensive fixture stage; it must import in an environment with no DBOS. The CI probe help command guards the optional-engine import boundary; four local packet checks also cover the same-interpreter product CLI entry without Docker, DB, a Temporal server or a model request. Existing DBOS experiment requirements remain independent and unmodified.

Actual validation used a fresh install of the existing63-package lock: pip check and the exact Worker verifier passed. Four bootstrap/entry tests passed against the integrated checkout (1.942 seconds), including real probe/dispatch help, child imports and refusal to run the uninstalled DBOS engine. Mixed-directory protected Host and Temporal pytest collection succeeded; Work-journey discovery collected172 cases. Collection is not execution. This is bootstrap/import/unit evidence on macOS; native Linux PG/mTLS qualification remains a hosted CI gate.


### Downstream fixture execution

Actual172-case Work-journey execution in the fresh lock exposed five stale unit fixtures after
bootstrap was repaired: two completed-publication cases omitted the Task id and historical Run
correction-policy query now required by `work_completion.complete`; three deferred-Workflow
cases did not supply the Temporal patch marker or failure-finalization Activity introduced in
[terminal recovery](work-terminal-recovery.md). Nine additional local socket failures were the
sandbox refusing owned loopback listeners, not product failures. Repair only the old fixtures:
keep the real completion/context validation with an explicit scoped database port, and exercise
the current Workflow patch branch with a terminal Activity assertion proving malformed batches
never prepare a tool. Product code, authority checks, dependency pins and test selection stay
unchanged. Run the affected suite with its owned loopback permitted before the next CI push.

Actual follow-up execution passed all172 Work-journey unittest cases,153 protected Host/native,
Temporal and deferred-workflow pytest cases, and198 Linux execution unittest cases. The repository
`npm run check` passed again with unchanged Turbo tasks cached. These executions use the fresh
canonical Worker environment; the hosted Linux database/engine sequence remains separate.


### Native Linux short-socket fixture correction

Hosted4a523b9 passed the exact Worker bootstrap,826 base PostgreSQL cases (+2 optional skips)
and1489 Worker cases (+1 missing-history skip), then failed two real Unix-stream fixture setups:
`/private/tmp` exists on macOS but not the Linux runner. Use canonical `/tmp` on both systems;
retain the short random directory, actual peer credentials, signed flow, assertions and cleanup.
The system default macOS temporary path can exceed the Unix socket length limit, so simply
removing the short-directory selection would reintroduce a separate known platform failure.
This changes test location only, with no product fallback or bypass.

### CLI-independent environment assertions and disposable Linux fixture

Reuse the existing `SubprocessCommander(binary=sys.executable)` synthetic-child pattern and
Python3.12's documented `sys.executable`; DSH implemented the one-line test constructor change
in an isolated public/synthetic packet. All environment-filtering assertions and the independent
missing-CLI refusal test remain unchanged. No production fallback, dependency or upstream source
copy is introduced. The actual Linux image has no Docker CLI, exposing the old implicit dependency.

The follow-up disposable container's `/proc/mounts` confirmed `rw,nosuid,nodev,noexec` for `/tmp`.
The172-case journey suite intentionally executes a synthetic upstream shell script there, so its
exit126 was a local runner constraint. The official [Docker tmpfs options](https://docs.docker.com/engine/storage/tmpfs/)
define explicit `exec`/`noexec`; DSH implemented a temporary runner using `rw,exec,nosuid,nodev`
with the same pinned image, read-only source, no network/socket, dropped capabilities and resource
limits. This runner is validation machinery only; repository/product mount policy is unchanged.

Actual execution of the reviewed DSH runner on the pinned Linux arm64 image passed198 execution
unittests,153 Host/native/Temporal/deferred pytest cases and172 journey unittests. `/proc/mounts`
confirmed the executable tmpfs without `noexec`. Required `npm run check` passed;33 test/typecheck
and20 build tasks reused unchanged Turbo cache, while direct repository gates executed. Subsequent
documentation edits passed `npm run docs:check`. Hosted latest-head success is still a separate gate.

### Hosted product cancellation assertion

At80e2b90 all198 execution,153 adjacent pytest and172 journey cases passed in hosted Linux.
Four real PostgreSQL/mTLS scenarios then passed. `product-concurrent-runs` failed because its
shared reference/product probe still searched the exception chain for `admission_closed`.
The reviewed product failure wrapper in `work_worker.py` deliberately emits the sanitized,
non-retryable `ApplicationError('execution_failed', type='OpenBotTaskFailed') from None` after
finalization. The unwrapped reference Worker retains its original exception chain.

Reuse the ledger's Product Worker/failure entries and `python-work-failure.md`: Temporal1.33.0
commit `ab52fdde33ee8ed193402625bfdba25d240a762d`, MIT. Read the official
[ApplicationError API](https://python.temporal.io/temporalio.exceptions.ApplicationError.html)
and the installed pinned implementation; the pinned GitHub source URL again returned a fetch
error. Use the released typed `cause`, `type`, `message` and `non_retryable` properties, not a new
exception protocol. DSH is assigned the bounded fixture implementation: assert the exact sanitized
product error, retain the reference assertion, and preserve all cancellation, usage, action/effect,
independent completion, artifact and replay checks. No product behavior or upstream source copy.

The DSH patch passed the actual `--engine postgres-mtls --only-case product-concurrent-runs`
entry in this checkout, including its unchanged public snapshots, accounting/effect counters,
artifact download and offline replay. The following three previously unreached hosted cases also
passed locally: product-deferred-approval, product-closed-repair and product-owner-corrections,
each with real HTTP/PostgreSQL/mTLS and synthetic model/effect peers. Required `npm run check`
passed again with unchanged Turbo tasks cached. No paid model or remote VPS call was repeated.

### Container preflight log pipeline race

Native amd64 run36166126715 failed its optional Python smoke at the expected-preflight log
assertion; the same step passed on arm64 and preceding amd64 commits. Its current Bash script
uses `set -euo pipefail` with `docker logs ... | grep --quiet`. Quiet matching can close the pipe
before Docker finishes writing, so a present marker is not sufficient for pipeline success.
The failing run discarded that container's logs, so its exact producer status was not retained.
A real Docker CLI reproduction with an owned, networkless synthetic-log container produced
producer/reader statuses141/0 for the current form and0/0 for a complete-reading grep.

Reuse the existing reviewed Server-container smoke and native shell tools; no dependency or
product change. The [GNU grep3.12 manual](https://www.gnu.org/s/grep/manual/html_node/Usage.html)
explicitly documents early pipe closure with `set -e -o pipefail`.
[Docker's CLI implementation](https://github.com/docker/cli/blob/master/cli/command/container/logs.go)
and [logs API](https://docs.docker.com/reference/cli/docker/container/logs/) describe streaming
container stdout/stderr. The unpinned Docker source is contextual only; no CLI upgrade or copied
source is proposed. Select the existing normal grep behavior with output redirected to `/dev/null`,
which consumes the producer to EOF while preserving pipefail. Add a real Bash stream regression
using the actual checked-in guard, including a missing marker and a failed producer that emits
the marker. Keep startup exit, empty-database and all real container assertions unchanged.

The actual Docker log-stream comparison passed (old141/0, fixed0/0). All14 container-contract
tests passed, including the real Bash guard with matched, missing and failed-producer streams.
`bash -n` and the required full `npm run check` passed; unchanged Turbo tasks reused cache.
The next native hosted run must verify the complete original smoke and retain diagnostic logs
if the preflight marker is absent. This fix does not infer success from a producer failure.
