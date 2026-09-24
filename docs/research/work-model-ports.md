# Research: durable model observations in the shared Worker

- Status: optional port and durable receipt accepted locally; no provider/default activation.
- Date: 2026-09-24
- Owner: Codex integration, bounded dsh SDK adapter implementation.
- Related issue: #91
- Acceptance journey: an actual SDK model response survives a Worker/activity retry without a
  second billed request; missing receipt remains unknown; cancellation cannot authorize more work.
- Security boundary: control owns credentials, Actions, budget and immutable receipt references;
  the Runtime receives only bounded model observations. No live account is used for development.

## Search evidence

Searches: GitHub pydantic/pydantic-ai v2.47.0 releases/Temporal/OpenAIResponsesModel;
primary OpenAI model/retry documentation, existing runtime SDK/Temporal reuse entries, and
previous Python model-services dependency research. Read installed pinned SDK implementations
`_model.py`, `_dynamic_toolset.py`, `models/openai.py`, `providers/openai.py`, and OpenAI `_client.py`.

- https://pydantic.dev/docs/ai/models/openai/
- https://pydantic.dev/docs/ai/core-concepts/retries/
- https://github.com/pydantic/pydantic-ai/tree/77d5fce751ab8ab04bd5db4ed6acc1131a4baed6
- https://github.com/openai/openai-python/tree/8c72a700d900fb2578227df564a54462abfe67f8

The official model documentation explicitly notes the independent SDK retry budget. Installed
OpenAI3.17.0 additionally inherits custom headers from OPENAI_CUSTOM_HEADERS despite explicit
credentials/endpoint settings; the new port must reject that configuration, never copy values
into logs. Provider-hosted tools, automatic previous-response lookup and provider persistence are
outside the accepted port. Model tool IDs and a Runtime-local step counter are not durable identities.

## Candidate comparison

| Candidate | Exact pin | License | Maintained behavior / fit | Decision |
| --- | --- | --- | --- | --- |
| Pydantic AI model adapter | 2.47.0 / 77d5fce751ab8ab04bd5db4ed6acc1131a4baed6 | MIT | Existing Runtime message model; reviewed generated model/tool activity boundaries, released provider conversion and tests | Reuse public OpenAIResponsesModel; no second Agent or message converter |
| OpenAI SDK | 3.17.0 / 8c72a700d900fb2578227df564a54462abfe67f8 | Apache-2.0 | Reviewed client, response types, resource tests, release and issues in retained dependency research | Optional Worker dependency; explicit credentials and max_retries=0 |
| Existing PostgreSQL/LocalWorkFiles | current2372911; PostgreSQL17.11/psycopg3.3.6 | PostgreSQL / LGPL-3.0-only / project MIT | Control-owned transactions plus immutable private blobs with digest readback | Reuse for durable receipt metadata and payload |
| Independent provider conversion or local retry/cache service | none | n/a | Duplicates SDK mapping or introduces another recovery owner | Reject |

## Reuse decision

Select released dependencies and thin control adapters. Unlike the earlier standalone JSON-RPC
host, the shared Temporal Runtime already uses Pydantic AI ModelMessage/ModelResponse directly;
its released provider model avoids another conversion layer. This does not revive unsent TASK015,
accept its dirty dependency files, change backend choice or claim all11 preserved providers are
implemented. OpenAI Responses is the first bounded optional port; remaining providers/configuration
stay in their owning plan stages.

The OpenBot-specific gap is persisting the received model observation/usage together with its
exact admitted Action before an activity acknowledgement can be lost. Temporal records activity
results only after acknowledgement; a crash in between cannot safely authorize another API call.
Use a narrow immutable receipt record plus existing private blobs and Action settlement, not a
new cache/orchestrator/audit system. Missing or corrupt observation stays unknown. SDK retries,
redirects, inherited environment routing, unbounded bodies and incomplete terminal output fail
closed. Unknown billing retains reservation. Historical receipt storage/settlement grants no new
model/tool execution after cancellation.

Independent design review: SDK Activity ID is stable across activity attempts but its automatic
sequence resets in a new engine Run. Include exact current engine Run in the operation key and
refuse new engine chains/CAN for this initial profile unless the original operation identity is
explicitly carried by a later reviewed continuation contract. Do not advertise workflow-level
retry/CAN deduplication. Read existing admitted/unknown/applied Actions and receipts before any
new claim: an expired claim must not block historical readback or trigger another model request.
New admission alone obtains a fresh claim. No mutation of old SQL history; any receipt schema is
additive, with explicit synthetic compatibility coverage.

## Source incorporation

No upstream source copied or patched. Dependency licenses remain in installed distributions.
Adapter and acceptance fixtures are OpenBot code; the dsh task receives only relevant code and
public SDK reference source, with its changes restricted to the two task files.

## Verification plan

Real SDK requests through synthetic HTTP transport: text/tools, strict usage/completion,
no retry/redirect/hosted effects, bounded payload/lifetime, cancellation and secret redaction.
Then actual public entry/PostgreSQL/Temporal restart after response persistence: one external
request, same observation and usage, no new admission on expired claims; missing/corrupt receipt
retains unknown; cancellation permits historical settlement only. Stable candidate hashes and
unique logs; required repo checks. Fake providers do not prove live model quality or real billing,
and this step grants no Linux/runsc support.

## Unresolved questions

Whole-Run continuation/corrections, provider configuration/API parity, non-OpenAI adapters and
live-provider evaluation remain open. The additive receipt schema and recovery ordering passed independent review and actual
PostgreSQL/Temporal fault qualification; this does not activate general production service loading.


## Implemented boundary and evidence — 2026-09-24

Parent2372911; candidate files are recorded by SHA-256 in
`/private/tmp/openbot-model-candidate-20260924.json`. New SQL0033 stores immutable receipt metadata;
private blobs use existing LocalWorkFiles, with no public Artifact entry. SDK serialization is versioned.
Applied receipt reads/writes require original settlement usage and exact source/reference/hash.
Activity attempts use the same operation identity; a new engine Run is explicitly refused.

The dsh SDK task reached its480-second limit (exit124) and handed back candidate files without an
implementation-test claim. Codex reclaimed sole ownership, ran tests and fixed the independent
findings: media/hosted history could enter SDK downloads; settled receipt matching was incomplete.
Further checks reject encoded response bodies, disable transport-level inherited CA paths, and
prove SDK request was never entered for forbidden message parts. No upstream source was copied.

Actual runs (exit0 unless noted):

- Public startup: `apps/server-python/.venv/bin/python -B -m pytest apps/server-python/tests/test_entry.py -q`:
  9 passed. Only pytest cache writing was sandbox-denied; assertions ran.
- `npm run migrations:check`:7 checks passed,34 SQL files. Prior33 SQL bytes preserved.
- `OPENBOT_TEMPORAL_TEST_PYTHON=/private/tmp/openbot-model-port-review/venv/bin/python node scripts/test-python-control.mjs`:
  baseline302 passed/2 optional files skipped; supplied SDK interpreter108 passed, including13 new
  receipt cases. No receipt tests were skipped in that profile. Log:
  `/private/tmp/openbot-model-postgres-20260924-01.log`.
- `python -B -m unittest discover -s experiments/work-journey -p 'test_*.py' -v`:
  140 actual passes; `/private/tmp/openbot-model-journey-unit-20260924-01.log`.
- `python -B experiments/work-journey/probe.py --engine postgres-mtls --only-case model-receipt-recovery`:
  actual public Task creation, released SDK transport, private reply persistence, owned Worker SIGKILL
  before settlement/acknowledgement, exact expired claim, same Activity retry, one settlement,
  downloaded bytes and unchanged offline replay passed. Two distinct model stages made two synthetic
  provider requests total, zero repeated requests after crash. Log:
  `/private/tmp/openbot-model-recovery-mtls-20260924-01.log`.
- `--engine postgres-mtls --only-case concurrent-runs`: unchanged shared-Worker cancellation,
  accounting, output isolation and replay passed; `/private/tmp/openbot-model-concurrent-mtls-20260924-01.log`.
- Final review found the forbidden-input tests could pass when a mocked SDK exception was wrapped.
  Added explicit `assert_not_awaited` for every input. Also set default AsyncHTTPTransport
  `trust_env=False`; a real transport constructor with nonexistent ambient CA paths succeeds.
 29 SDK cases passed (`/private/tmp/openbot-model-port-review-fixes-20260924.log`). These post-probe
  changes affect test assertions and the non-injected TLS transport only; the already-qualified
  injected transport, receipt, model Activity and workflow paths are unchanged. Database/probe
  evidence is reused for those unchanged inputs, not relabeled as a second run.

The first SDK candidate24 cases, hardened35 model/identity cases, full140 suite, and final29 SDK
cases are successive changed-input checks, not additive coverage counts. Original logs remain in
`/private/tmp/openbot-model-port-unit-raw-20260924.log`,
`/private/tmp/openbot-model-port-unit-final-20260924.log`, and the paths above. Model retries inside
Temporal are deliberately injected recovery behavior; the dsh timeout is an implementation handoff
failure, not provider failure. No production account, credential, user database or live provider used.

CI now bootstraps the optional SDK profile once, runs the receipt PostgreSQL cases and public
recovery case in the existing Linux lane. Actual local execution is macOS arm64 with disposable
PostgreSQL/Temporal services; CI has not been run remotely for this candidate. Existing adjacent-
release qualification is reused for unchanged engine deployment, not rerun. S4 is unaccepted.

Final forbidden-input assertions passed for both media and native-tool cases after checking each
individual SDK mock (`/private/tmp/openbot-model-no-sdk-entry-20260924.log`). `npm run check`
passed; prerequisites executed, Turbo build17/18 cached with the Server rebuilt. Per-lane cache
counts remain in `/private/tmp/openbot-model-repository-check-20260924-01.log`; they are not fresh
Python or live-provider evidence. S7 target pin must be advanced and requalified for additive SQL0033.
