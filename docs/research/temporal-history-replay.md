# Research: offline replay of the public work journey

- Status: adapter and actual waiting/completed-history qualification passed locally
- Date: 2026-09-23
- Owner: OpenBot architecture migration
- Acceptance journey: replay a real `WorkJourney` history with the current workflow, then prove
  that replacing its first activity command with a timer is rejected as nondeterministic.
- Security boundary: an in-memory history is evidence for workflow compatibility. Replay grants
  no OpenBot authority and must not execute model, tool, HTTP, or database activities.

## Search evidence

Reviewed the installed versions, official releases, pinned source and upstream tests before
implementation. Searches on 2026-09-23 included `Temporal Python Replayer workflows history`,
`repo:temporalio/sdk-python replay nondeterminism issue 1881`, and
`repo:pydantic/pydantic-ai Temporal replay tests PydanticAIPlugin`.

Primary documentation reviewed:

- [Temporal Python replay testing](https://docs.temporal.io/develop/python/best-practices/testing-suite#how-to-replay-a-workflow-execution):
  replay checks deterministic compatibility with the supplied history; it is a useful deployment
  check, not a universal upgrade guarantee.
- [Pydantic AI Temporal integration](https://pydantic.dev/docs/ai/capabilities/durable_execution/temporal/):
  `TemporalDurability` routes model and tool execution through activities. `PydanticAIPlugin`
  configures serialization and registers agent activities for a normal worker.
- Existing [reuse ledger](../OPEN_SOURCE_REUSE.md#official-sdk-durability-composition-2026-09-23),
  [SDK composition review](sdk-durability-integration.md),
  [work journey](work-temporal-journey.md), and [Temporal review](temporal-durability-review.md).

## Candidate comparison

| Candidate | Exact release and commit | License | Maintenance, tests and fit | Decision |
| --- | --- | --- | --- | --- |
| Temporal Python `Replayer` | [1.33.0](https://github.com/temporalio/sdk-python/releases/tag/1.33.0), `ab52fdde33ee8ed193402625bfdba25d240a762d` | MIT | Official released SDK; Python >=3.10. Pinned replay tests cover complete, incomplete and nondeterministic histories. Accepts a fetched `WorkflowHistory` without a client/server. | Reuse directly. |
| Pydantic AI `PydanticAIPlugin` | [2.47.0](https://github.com/pydantic/pydantic-ai/releases/tag/v2.47.0), `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6` | MIT | The already-selected adapter configures the Pydantic payload converter and workflow sandbox. Pinned durability tests exercise workflow-side agent execution and recorded activity payloads. | Reuse with the same workflow definition. |
| Local replay engine/history interpreter | None | N/A | Would duplicate command matching and SDK-specific payload semantics already supplied upstream. | Not needed. |

## Reviewed source and boundaries

The pinned SDK's [`Replayer`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/worker/_replayer.py)
requires `workflows` explicitly, applies `plugin.configure_replayer`, and runs a workflow worker
against `Worker.for_replay`. Its bridge configuration disables both local and remote activity
execution. Recorded activity results drive workflow code; no activity implementations are
registered by this adapter. Replay failure is raised by default. A command mismatch surfaces as
`temporalio.workflow.NondeterminismError`; configuration, payload and arbitrary runtime failures
must not be counted as a successful negative test. The upstream
[replay tests](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/tests/worker/test_replayer.py)
were inspected, not executed in this review.

The pinned [`PydanticAIPlugin`](https://github.com/pydantic/pydantic-ai/blob/77d5fce751ab8ab04bd5db4ed6acc1131a4baed6/pydantic_ai_slim/pydantic_ai/durable_exec/temporal/__init__.py)
has a no-argument constructor. It inherits
[`SimplePlugin.configure_replayer`](https://github.com/temporalio/sdk-python/blob/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/plugin.py),
which applies its converter, runner and failure-type configuration. It does not infer replay
workflows from `__pydantic_ai_agents__`: the caller still supplies `[WorkJourney]`. That class
attribute is used by the separate worker configuration path to discover activities. Keep the
plugin on replay even though no activities run, because Pydantic payloads still need decoding.
The pinned [durability tests](https://github.com/pydantic/pydantic-ai/blob/77d5fce751ab8ab04bd5db4ed6acc1131a4baed6/tests/durable_exec/temporal/test_durability.py)
include skipped MCP replay cases; their coverage is not evidence for every toolset configuration.

Issue review found the still-open Temporal
[#1881](https://github.com/temporalio/sdk-python/issues/1881) report about local-activity result
ordering and Pydantic AI [#6883](https://github.com/pydantic/pydantic-ai/issues/6883) about agent
workflow cache eviction. These reports were not reproduced here. The current journey uses remote
activities, and qualification is limited to its actually fetched histories. Workflow replay
executes trusted workflow Python; Temporal's determinism sandbox is not an OS security boundary.

## Reuse decision

- Selected option: released dependencies with a thin experiment-only acceptance function.
- Exact OpenBot gap: combine the current `WorkJourney` replay and a deliberately incompatible
  workflow registered under the same type name, using the same history object and official plugin.
- Input: a real `WorkflowHistory` from `await handle.fetch_history()`, after `bind_identity` has
  been scheduled. Reject empty, wrong-type and too-early histories rather than claiming coverage.
- The incompatible definition schedules a timer instead of the recorded first `bind_identity`
  activity. Only `NondeterminismError` counts as detection; an unexpected successful replay fails
  the acceptance function. Current-code failure propagates before attempting the negative case.
- Use an explicitly owned thread executor and close it after both replays; do not create a client,
  start a worker that polls activities, fetch data, export history, or alter product dependencies.
- Upgrade plan: retain representative histories under an approved data-retention policy and test
  each proposed workflow/SDK change. This same-version check does not establish cross-version
  compatibility, safe worker rollout, server schema upgrades, or business authorization correctness.
- Missing or incompatible SDK/plugin/history causes a failure, with no fallback replay engine.

## Source incorporation

No upstream source copied or substantially adapted. The adapter calls the public SDK API; the
installed distributions retain their MIT notices. No additional dependency or production API.

## Verification plan and current evidence

Run focused stdlib unit tests with the experiment environment:

```sh
python -B -m unittest discover -s experiments/work-journey -p test_replay.py -v
```

The unit tests exercise adapter failure handling with a mocked replayer and inspect the actual
plugin configuration; synthetic event objects in those tests are not real replay evidence.
On 2026-09-23, all 8 focused tests passed with the pinned experiment dependencies on CPython 3.12.
The integrated disposable fixture now calls `await verify_history_replay(history)` on real
waiting-for-approval and completed histories, then asserts unchanged complete business snapshot and all independent HTTP counters. Histories
stay in memory. The mTLS PostgreSQL run passed waiting (41 events) and completed (78 events)
positive replay plus deliberate command-mismatch rejection. The same run passed all eight public
journeys after stopped CA rotation, cold engine restore and engine/database SIGKILL. Event counts
are observations, not fixed assertions: approval polling legitimately changes history length.
These are same-code/same-SDK histories; cross-release and future-code acceptance remains open.

Integration calls the function directly; history acquisition remains the caller's responsibility:

```python
from replay import verify_history_replay

report = await verify_history_replay(await handle.fetch_history())
```

The report contains only the workflow/run IDs, event count and the two acceptance outcomes. It
contains no event payloads. Retain business revision and effect counters around this call in the
integrated probe to validate the absence of new work independently of replay's return value.

No Docker, Temporal service, model, or external tool is started by the focused tests. The reviewed
local runtime is CPython 3.12 on macOS; this alone is not platform conformance or production support.

## Unresolved questions

Representative histories across future SDK/workflow versions, payload format changes, other
capabilities/toolsets, Continue-As-New and worker-versioning rollout still require separate tests.
