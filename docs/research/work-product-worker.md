# Research: product Worker and bounded dispatch composition

- Status: locally accepted product composition slice, 2026-09-24; production activation remains closed.
- Owner: Codex implementation/integration; separate read-only reviewer. dsh dispatch attempt timed out without code (see below).
- Parent: d0f7c1a; related issue#91.
- Acceptance: public Task routes use a product workflow with real SDK ports, independent result
  verification, idempotent publication/recovery and an operator-triggered bounded handoff pass.
- Boundary: one Server authority, one Temporal recovery owner, unknown effects lookup only,
  no model result alone declares completion, no unaccepted S4 executor or alternate scheduler.

## Reuse decision

Reuse the already reviewed/pinned Temporal Python1.33.0 (MIT), Pydantic AI2.47.0
77d5fce751ab8ab04bd5db4ed6acc1131a4baed6 (MIT), and existing work_* control modules.
Read official https://docs.temporal.io/develop/python and installed SDK Worker/activity/workflow
APIs; GitHub source/release/issues/license review remains the recorded exact pins in
work-temporal-journey.md and work-model-ports.md. Re-read the existing OPEN_SOURCE_REUSE entries
for product handoff and Runtime composition. No new dependency, protocol or upstream source copy.

The released Worker supplies execution/scheduling; existing dispatch_one/HandoffStore own
submission reservation and immutable engine-start provenance. A finite pass over existing
pending/unconfirmed lists is an ingress adapter, not another retry scheduler. Repeated delivery
only invokes the existing reservation/history policy. Existing TemporalDurability agent and fresh
per-Run port factory are preserved. Trusted result verification remains separate from model final
text, while existing completion checks own fences, revision, unresolved actions and blob readback.
Do not invent a generic semantic-success check from a filename/hash or accept arbitrary model
verification. Custom service callbacks are trusted deployment composition, never input paths.

## Qualification

Before long tests: check actual entry validation, bounded batch and real SDK registration;
independently review crash/publication ordering and fixture steps. Then owned PostgreSQL/public
HTTP/Temporal, reused bounded model port, concurrent/cancel and acknowledgement-loss recovery.
Synthetic provider/tool/verifier fixtures prove wiring only, not production model quality or
Linux/runsc. Core production composition must not import experiments or use a per-Task process
configuration. No default activation, new language, production migration, release or retiring code.

## Implemented boundary

`work_worker.py` owns the importable `OpenBotWorkV1` Workflow/Agent and required trusted service
and verifier callbacks. `work_engine_binding.py`/`work_temporal_activity.py` add a read-only
completed-Run binding with the same immutable engine provenance. Completed publication recovery
checks the unique completion event, exact original Artifact set/order, canonical completion digest
and every blob before returning IDs. It creates no claim or grant and calls no verifier. Active
publication captures revision before independent verification and retains its original fence;
concurrent completion can succeed only by the same strict readback. The Agent cannot declare a
Task successful using final text alone. One process serves one queue with fresh per-Run ports.

`work_dispatch_batch.py` reuses the existing handoff/reservation/history policy in one finite pass.
The actual `scripts/dispatch-work.py` requires explicit, owned private configuration and mTLS;
all TLS materials reject group/other writes. It distinguishes acknowledged, unconfirmed and
failed observations without logging secrets or rescheduling work. The optional product dependency
profile requires no experiment package and does not change the default control install.

## Observed failures and corrections

- dsh task S3-DISPATCH-BATCH received the narrow file allowlist, but its write backend could not
  deliver within the five-minute supervisor limit. Exit124; both allowed source files remained
  empty. Its process ended before Codex reclaimed ownership. No dsh code was accepted, no second
  writer ran concurrently, and there was no further access-debugging retry.
- First real model journey exited1 before starting a Task: the probe imported product source
  without the Runtime source path. The fixture entry now supplies both source roots. The retained
  `openbot-product-model-mtls-20260924-01.log` contains the ModuleNotFoundError. This was an agent
  fixture failure, not a recovery failure or a passed run.
- Independent pre-run review corrected CA/certificate other-user write permissions and a fixture
  30-second outer wait shorter than its 60-second CLI subprocess bound. Targeted negative checks
  and a 65-second outer wait closed these findings. The publication case requires mTLS explicitly.
- Worker SIGKILL and Activity retries in successful cases are intentional recovery inputs. Their
  original engine Run, single completion and unchanged effects are asserted; they are not retries
  caused by development-tool failure.

## Candidate and executed evidence

Parent `d0f7c1adf5db53c64424590254ede6e9f0f7df3d` plus this change, including untracked product
files. Unrelated dirty model-service manifests/research and TASK020 were excluded. During the final
run, `/private/tmp/openbot-product-candidate-20260924-03.json` recorded18 file hashes and a subsequent
comparison reported zero changed inputs. Manifest SHA256:
`a49886815702994021bc48a16e6e9cc22da432b881dd52beabd8bcbe90e0ec34`.
The two preceding recovery runs used candidate02; later changes only add the separate concurrent
case/CI selection, with their Worker, model/publication fixtures and assertions unchanged.

All following logs are retained under `/private/tmp/`; results are local, not hosted CI results.

| Actual command or case | Result and scope | Log basename |
| --- | --- | --- |
| `node scripts/test-python-control.mjs` with `OPENBOT_TEMPORAL_TEST_PYTHON` selecting the pinned optional SDK environment | Actual owned PG/HTTP:302 passed,2 optional-SDK skips in base interpreter;119 passed in separate SDK gate, including11 new publication counterexamples | `openbot-product-worker-postgres-20260924-01.log` |
| Actual startup entry + finite batch unit checks |25 passed; pending/unconfirmed policy, strict bounds, malformed input, deadline and cancellation | `openbot-product-entry-batch-20260924-01.log` |
| Actual CLI preflight before final TLS correction |8 passed, superseded for TLS permissions by the following run | `openbot-product-cli-entry-20260924-01.log` |
| Clean product-profile install, committed parent control/Runtime locks and new requirements-worker.txt | Installed successfully; no experiment/DBOS dependency or unrelated dirty lock included | `openbot-product-profile-20260924-01.log` |
| Clean-profile `pytest` dispatch entry/batch, final TLS candidate |26 passed, including CA/certificate writable-file refusals and secret-safe failures | `openbot-product-profile-entry-20260924-02.log` |
| `probe.py --engine postgres-mtls --only-case product-model-recovery` | Actual public Task/PG/Temporal and real SDK over synthetic HTTP: original reply after expired claim, no repeated model request, one charge, verified download and unchanged replay | `openbot-product-model-mtls-20260924-02.log` |
| `probe.py --engine postgres-mtls --only-case product-publication-recovery` | Actual operator CLI and repeated empty pass; crash after commit/before ack; same engine Run, one completion, no callbacks after restart, identical bytes and replay | `openbot-product-publication-mtls-20260924-01.log` |
| `probe.py --engine postgres-mtls --only-case product-concurrent-runs` | One product Worker/Agent/queue with overlapping Tasks; cancel one, independently complete/download the other, unchanged replay. Scripted model/tool ports | `openbot-product-concurrent-mtls-20260924-01.log` |
| `python -B -m unittest discover -s experiments/work-journey -p 'test_*.py' -v` |141 reference regression tests executed and passed | `openbot-product-reference-regression-20260924-01.log` |
| `npm run check` | Exit0; repository prerequisites executed; Turbo lint/typecheck31/31, tests31/31, build18/18 cached (not re-executed) | `openbot-product-check-20260924-01.log` |

The CLI checks are added to the existing optional SDK PG runner, and the three actual product
journeys to the existing Linux CI lane. The post-wiring CLI cases were run separately; the119-case
PG run predates this test-list-only addition. No claim that129 cases ran together. Existing schema
qualification at `d0f7c1a` is reused: this slice adds no migrations. No historical long upgrade run
was repeated; actual model/provider quality, S4 Linux/runsc and arbitrary external services remain
unverified. Warnings observed: Starlette deprecated AnyIO alias and Temporal sandbox late
`annotated_types` import; neither caused an acceptance failure.

## Next boundary

Service callbacks/verifiers are trusted deployment composition and this profile is opt-in.
Product-owned service selection and general approval/correction/continuation remain S3 work.
S4/TASK020 is unaccepted and not imported. This delivery does not complete S3, activate a default
backend, grant Runtime authority, or retire/release the old implementation.

Key candidate source hashes:

- `apps/server-python/src/openbot_server/work_worker.py`: `2a532c3ddf76b2277b734e8cf4e5c704743346accf3de58b5903d86a004d58f0`
- `apps/server-python/src/openbot_server/work_engine_client.py`: `008e44bdadc8336716f55cf5aba7a3c8bd626a97b076ff61ffd6a3f5cb855ad5`
- `apps/server-python/scripts/dispatch-work.py`: `a3a46ba3933b214711798982ce190a833892cab21dba501cb7e0daf080b4d191`
