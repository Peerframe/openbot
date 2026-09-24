"""Disposable real-Temporal probe: one constructor-time Agent, two concurrent Runs.

Question: can a single Pydantic AI ``Agent`` built once **before** Worker startup serve two
concurrent Temporal Workflows that carry distinct serializable Run labels, using the existing
OpenBot ``PortModel``/``PortToolset``, without a global Run registry, a shared ``RunGuard`` or any
process-local routing of model/tool requests?

Second-revision design (2026-09-24). The first revision was rejected on two concrete pieces of
evidence, both removed here:

* a module-level ``pathlib.Path.resolve()`` made the Temporal workflow sandbox refuse to validate
  the Workflow (``RuntimeError: Failed validating workflow MultirunPortProbeWorkflow`` with
  ``__call__ on pathlib.Path.resolve restricted``). Repository-relative paths are now computed with
  pure ``Path.parent``/``parents`` only, and the OpenBot runtime imports run inside
  ``workflow.unsafe.imports_passed_through()`` as in the reviewed ``workflow_worker.py``. The
  sandbox is not disabled.
* the first revision kept a ``_RUNS`` dictionary of mutable ``RunGuard``/``PortModel``/
  ``PortToolset`` state and routed model requests through a prompt marker / ``model_settings``. That
  is global Run state and would not survive a Worker restart or a second process. It is gone.

Revised composition:

* exactly one Agent is built at import with ``TemporalDurability``, a constructor-time
  ``DynamicToolset(id='openbot-ports')`` and the pinned public ``ResolveModelId`` capability;
* each model activity resolves its ``PortModel`` from the serialized ``RunDeps.label`` through
  ``ResolveModelId(ctx, model_id)``; the resolver reads only ``ctx.deps`` and the construction-time
  model id, never prompt text, ``model_settings`` or a process-local ``current Run``;
* each tool activity builds its ``PortToolset`` from ``RunContext.deps`` in the DynamicToolset
  factory;
* every activity builds a fresh ``RunGuard``/``ToolCatalog``/``RuntimeLimits``; no guard is shared
  between Runs or between activities;
* the scripted model decides its behavior from the message history it receives, never from a
  process-local step counter, so an activity retry re-derives the same answer;
* a bounded, label-keyed observation log is written by the ports only so a separate activity can
  read back what each Run observed. It is measurement-only: it never selects a model/toolset and
  never authorizes an effect.

Known limits: whole-Run guard counters are **not** proven durable here, because each activity owns a
fresh guard. A production budget must be control-owned and durable; this probe cannot supply that.
The bounded dsh sandbox could not execute nested shell commands, so the integrator ran this probe
against pinned pydantic-ai 2.47.0 and Temporal 1.33.0 in an owned disposable Temporal environment.
That run passed and measured overlapping tool intervals; it did not exercise restart or replay.
See ``docs/research/work-temporal-journey.md``.
"""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from datetime import timedelta
from importlib.metadata import PackageNotFoundError, version
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time

from pydantic_ai import Agent
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin, TemporalDurability
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.usage import RequestUsage, UsageLimits
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy, WorkflowIDReusePolicy
from temporalio.worker import Worker

try:  # Public location on the reviewed release; fallback keeps the failure diagnostic readable.
    from pydantic_ai.capabilities import ResolveModelId
except ImportError:  # pragma: no cover - only reached if the pinned layout moved the class
    from pydantic_ai.capabilities.resolve_model_id import ResolveModelId

try:  # Public location on the reviewed release; fallback keeps the failure diagnostic readable.
    from pydantic_ai.toolsets import DynamicToolset
except ImportError:  # pragma: no cover - only reached if the pinned layout moved the class
    from pydantic_ai.toolsets._dynamic import DynamicToolset

# Repository paths without pathlib.Path.resolve(): the Temporal workflow sandbox refuses
# `Path.resolve` while validating this module (observed failure evidence in REVIEW-01.md).
_HERE = Path(__file__).parent
_SRC = str(_HERE.parents[1] / 'apps' / 'agent-runtime-python' / 'src')
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

with workflow.unsafe.imports_passed_through():
    # The reviewed runtime package is imported outside the workflow sandbox. It pulls compiled
    # extensions (jsonschema_rs) and is non-deterministic by construction, so the sandbox must not
    # re-execute it; this mirrors the reviewed `workflow_worker.py` composition.
    from openbot_agent_runtime.catalog import ToolCatalog
    from openbot_agent_runtime.contracts import (
        ModelStepRequest,
        RuntimeLimits,
        ToolCallRequest,
        ToolDescriptor,
    )
    from openbot_agent_runtime.errors import FailureReason, RuntimeFailure
    from openbot_agent_runtime.guard import RunGuard
    from openbot_agent_runtime.sdk_ports import (
        PORT_MODEL_NAME,
        PortModel,
        PortToolset,
        silence_sdk_startup_banner,
    )

PROBE_ID = 'openbot-multirun-port-probe'
PROBE_MODEL_ID = PORT_MODEL_NAME
"""The one Agent's construction-time model id; ResolveModelId maps it per Run from Run deps."""
TOOL_NAME = 'read_observation'
TOOL_SCHEMA = {
    'type': 'object',
    'properties': {'label': {'type': 'string'}},
    'required': ['label'],
    'additionalProperties': False,
}
RUN_LABEL_PATTERN = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
RUN_DEADLINE_SECONDS = 30.0
TOOL_OVERLAP_SECONDS = 0.6
PROBE_LABELS = ('run-a', 'run-b')
ACTIVITY_CONFIG = {
    'start_to_close_timeout': timedelta(seconds=15),
    'retry_policy': RetryPolicy(maximum_attempts=2, initial_interval=timedelta(seconds=1)),
}
MODEL_ACTIVITY_CONFIG = {'heartbeat_timeout': timedelta(seconds=4)}


def _expected_observation(label: str) -> str:
    """The tool observation this Run must produce; the model verifies it before answering."""
    return f'{label}:verified'


@dataclass(frozen=True)
class RunDeps:
    """Serializable per-Run identity. Every model/tool activity receives its own; nothing is shared.

    This is the only channel through which a model activity learns which Run it serves. It carries
    no authority and no budget: it is identity for composition, not a permission.
    """

    label: str


# ---------------------------------------------------------------------------
# Test-only measurement log.
#
# This is the only mutable worker-side state in the probe. It exists solely so a separate trusted
# activity can read back what each Run's scripted ports observed, independently of the Workflow
# result. It is never read by `_resolve_port_model`, `_dynamic_toolset`, `_build_port_model` or
# `_build_toolset`, and it never grants authority: the scripted ports return the same observation
# whether or not an entry was recorded.
# ---------------------------------------------------------------------------

_OBSERVATIONS: dict[str, list[dict[str, object]]] = {}
_OBSERVATION_LIMIT_PER_LABEL = 8


def _record(run_label: str, kind: str, **detail: object) -> None:
    """Append one bounded measurement entry. Overflow is recorded, never raised."""
    entries = _OBSERVATIONS.setdefault(run_label, [])
    if len(entries) < _OBSERVATION_LIMIT_PER_LABEL:
        entries.append({'kind': kind, **detail})
    elif not any(entry.get('kind') == 'overflow' for entry in entries):
        entries.append({'kind': 'overflow'})


# ---------------------------------------------------------------------------
# Per-activity composition. Every builder below is called inside an activity, builds its own
# guard/catalog/limits, and closes over exactly one Run label taken from serialized deps.
# ---------------------------------------------------------------------------


def _new_catalog() -> ToolCatalog:
    return ToolCatalog(
        (
            ToolDescriptor(
                name=TOOL_NAME,
                description='Return the run-scoped verified observation.',
                input_schema=TOOL_SCHEMA,
            ),
        ),
        max_tools=4,
        max_bytes=4096,
    )


def _new_limits() -> RuntimeLimits:
    return RuntimeLimits().validated()


async def _authority() -> None:
    """The probe's authority port: trusted scripted code, no external call and no fallback."""
    return None


async def _progress(stage: str, message: str) -> None:
    """The probe's optional progress port. Deliberately non-durable and unused for control."""
    return None


def _new_guard() -> RunGuard:
    """A fresh guard for exactly one activity.

    Guard counters are per-activity on purpose. This probe does **not** establish that a whole-Run
    step/tool budget is durable across activities or Worker restarts; a production budget must be
    control-owned. The limits are wide enough for the one model step or one tool call this activity
    performs and are the enforcing layer for that activity only.
    """
    return RunGuard(
        authority=_authority,
        progress=_progress,
        steps_limit=1,
        tool_calls_limit=1,
        progress_events_limit=4,
        deadline_seconds=RUN_DEADLINE_SECONDS,
    )


def _deps_label(ctx: object) -> str:
    """Read the Run label from serialized Run deps, never from process-local state."""
    deps = getattr(ctx, 'deps', None)
    label = getattr(deps, 'label', None)
    if not isinstance(label, str) or not RUN_LABEL_PATTERN.match(label):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            'Run deps did not carry a bounded lowercase [a-z0-9-] Run label',
        )
    return label


def _make_step_port(label: str, guard: RunGuard):
    """Build the scripted model step port for one activity.

    Behavior is derived entirely from the message history: a history without this Run's tool
    observation asks for one tool call; a history carrying the exact verified observation answers
    with it. No process-local counter and no prompt marker participates.
    """

    async def step_port(request: ModelStepRequest) -> ModelResponse:
        parts = [part for message in request.messages for part in message.parts]
        saw_tool_return = any(isinstance(part, ToolReturnPart) for part in parts)
        _record(
            label,
            'model',
            label=label,
            guardSteps=guard.steps,
            step=request.step,
            sawToolReturn=saw_tool_return,
        )
        observed = {
            part.tool_name: part.content
            for part in parts
            if isinstance(part, ToolReturnPart)
        }
        if TOOL_NAME not in observed:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        TOOL_NAME,
                        {'label': label},
                        tool_call_id=f'{label}-call-1',
                    )
                ],
                usage=RequestUsage(input_tokens=1, output_tokens=1),
                model_name=PORT_MODEL_NAME,
            )
        expected = _expected_observation(label)
        value = observed.get(TOOL_NAME)
        if value != expected:
            # A model-visible observation that is not this Run's verified value must never become
            # an answer. Fail closed instead of accepting an inline or crossed observation.
            raise RuntimeFailure(
                FailureReason.MODEL_RESPONSE_INVALID,
                f'{label}: observation {value!r} is not the verified {expected!r}',
            )
        return ModelResponse(
            parts=[TextPart(expected)],
            usage=RequestUsage(input_tokens=1, output_tokens=1),
            model_name=PORT_MODEL_NAME,
        )

    return step_port


def _make_tool_port(label: str, guard: RunGuard):
    """Build the scripted tool port for one activity. It performs no external effect."""

    async def tool_port(request: ToolCallRequest) -> str:
        if request.name != TOOL_NAME or request.arguments.get('label') != label:
            raise RuntimeFailure(
                FailureReason.INVALID_ARGUMENTS,
                f'{label}: unexpected tool request {request.name!r}',
            )
        entered_at = time.monotonic()
        # Hold the activity open and measure actual overlap in one worker process.
        await asyncio.sleep(TOOL_OVERLAP_SECONDS)
        exited_at = time.monotonic()
        _record(
            label,
            'tool',
            label=label,
            name=request.name,
            callId=request.call_id,
            guardSteps=guard.steps,
            guardToolCalls=guard.tool_calls,
            enteredAt=entered_at,
            exitedAt=exited_at,
        )
        return _expected_observation(label)

    return tool_port


def _build_port_model(label: str) -> PortModel:
    """Build the real OpenBot PortModel for one model activity, with its own fresh guard."""
    guard = _new_guard()
    return PortModel(
        step_port=_make_step_port(label, guard),
        catalog=_new_catalog(),
        guard=guard,
        limits=_new_limits(),
    )


def _build_toolset(label: str) -> PortToolset:
    """Build the real OpenBot PortToolset for one tool activity, with its own fresh guard."""
    guard = _new_guard()
    return PortToolset(
        catalog=_new_catalog(),
        tool_port=_make_tool_port(label, guard),
        guard=guard,
        limits=_new_limits(),
    )


def _resolve_port_model(ctx: object, model_id: str | None) -> Model | None:
    """Resolve the single Agent's model for one model activity.

    The pinned public resolver signature is ``(ModelResolutionContext, model_id) -> Model | None``.
    The only inputs used are the construction-time model id (or ``None`` when the durable hook
    leaves it unset) and the serialized ``ctx.deps`` Run label; no prompt text, ``model_settings``
    value or global registry is consulted. Any other id is declined with ``None`` so the SDK's own
    fallback decides, rather than this probe silently serving a model it was not asked for.
    """
    if model_id not in (PROBE_MODEL_ID, None):
        return None
    return _build_port_model(_deps_label(ctx))


def _dynamic_toolset(ctx: object) -> PortToolset:
    """Constructor-time DynamicToolset factory, keyed by the activity's own Run deps."""
    return _build_toolset(_deps_label(ctx))


def build_single_agent() -> Agent[RunDeps]:
    """Build the one Agent before any Worker exists.

    ``build_sdk_agent`` in the runtime composes an Agent per request; this probe deliberately does
    not use it, because the question is whether one constructor-time Agent is sufficient.
    """
    agent: Agent[RunDeps] = Agent(
        PROBE_MODEL_ID,
        deps_type=RunDeps,
        name=PROBE_ID,
        toolsets=[DynamicToolset(_dynamic_toolset, id='openbot-ports')],
        output_type=str,
        instructions='Return the verified run-scoped observation.',
        retries=0,
        capabilities=[
            TemporalDurability(
                activity_config=ACTIVITY_CONFIG,
                model_activity_config=MODEL_ACTIVITY_CONFIG,
            ),
            ResolveModelId(_resolve_port_model),
        ],
    )
    agent.instrument = False
    return agent


SINGLE_AGENT = build_single_agent()
"""The only Agent in this process. Two Workflows share it and must still stay separated."""


@activity.defn
async def openbot_read_run_log(label: str) -> dict:
    """Trusted readback of the measurement log, so a Workflow cannot report its own success.

    This activity reads no control state and grants nothing. It executes in the worker process, so
    it is only meaningful when one Worker serves both Runs, as this single-process probe does.
    """
    if not isinstance(label, str) or not RUN_LABEL_PATTERN.match(label):
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            'Run label must be 1..32 characters of lowercase [a-z0-9-]',
        )
    return {'label': label, 'entries': [dict(entry) for entry in _OBSERVATIONS.get(label, ())]}


@workflow.defn
class MultirunPortProbeWorkflow:
    """One Workflow definition serving two concurrent Runs with distinct inputs."""

    __pydantic_ai_agents__ = [SINGLE_AGENT]

    @workflow.run
    async def run(self, identity: dict) -> dict:
        label = identity.get('label') if isinstance(identity, dict) else None
        if not isinstance(label, str) or not RUN_LABEL_PATTERN.match(label):
            raise ValueError('Run label must be 1..32 characters of lowercase [a-z0-9-]')
        result = await SINGLE_AGENT.run(
            'Return the verified observation for this Run.',
            deps=RunDeps(label=label),
            usage_limits=UsageLimits(request_limit=3),
        )
        log = await workflow.execute_activity(openbot_read_run_log, label, **ACTIVITY_CONFIG)
        return {
            'label': label,
            'output': result.output,
            'runLog': log,
            'engineRunId': workflow.info().run_id,
        }


def _bucket(activity_name: str) -> str:
    lowered = activity_name.lower()
    for marker in ('model_request', 'call_tool', 'get_tools'):
        if marker in lowered:
            return marker
    return lowered


def _activity_counts(history) -> dict:
    """Count scheduled/completed activity types in a real workflow history."""
    scheduled: dict[int, str] = {}
    for event in history.events:
        if event.HasField('activity_task_scheduled_event_attributes'):
            scheduled[event.event_id] = (
                event.activity_task_scheduled_event_attributes.activity_type.name
            )
    counts: dict[str, dict[str, int]] = {}

    def bucket(name: str) -> dict[str, int]:
        return counts.setdefault(_bucket(name), {'scheduled': 0, 'completed': 0})

    for name in scheduled.values():
        bucket(name)['scheduled'] += 1
    for event in history.events:
        if event.HasField('activity_task_completed_event_attributes'):
            name = scheduled.get(
                event.activity_task_completed_event_attributes.scheduled_event_id
            )
            if name is not None:
                bucket(name)['completed'] += 1
    return counts


async def _run(args: argparse.Namespace) -> dict:
    client = await Client.connect(
        args.address,
        namespace=args.namespace,
        plugins=[PydanticAIPlugin()],
    )
    suffix = secrets.token_hex(4)
    async with Worker(
        client,
        task_queue=args.task_queue,
        workflows=[MultirunPortProbeWorkflow],
        activities=[openbot_read_run_log],
    ):
        handles = {}
        for label in PROBE_LABELS:
            handles[label] = await client.start_workflow(
                MultirunPortProbeWorkflow.run,
                {'label': label},
                id=f'{PROBE_ID}-{suffix}-{label}',
                task_queue=args.task_queue,
                execution_timeout=timedelta(seconds=90),
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
        evidence: dict[str, dict] = {}
        for label in PROBE_LABELS:
            # Both starts have already been issued, so the two Runs execute concurrently; the
            # tool activity's short hold makes their overlap observable in the two histories.
            result = await asyncio.wait_for(handles[label].result(), timeout=args.timeout)
            evidence[label] = {
                'result': result,
                'activities': _activity_counts(await handles[label].fetch_history()),
            }
        return evidence


def _collect_problems(evidence: dict) -> list[str]:
    problems: list[str] = []
    labels = sorted(evidence)
    if labels != sorted(PROBE_LABELS):
        problems.append(f'expected labels {sorted(PROBE_LABELS)}, observed {labels}')
    outputs: list[str] = []
    engine_runs: list[str] = []
    tool_intervals: dict[str, tuple[float, float]] = {}
    for label in labels:
        record = evidence[label]
        result = record.get('result', {})
        log = result.get('runLog', {})
        entries = [entry for entry in log.get('entries', []) if isinstance(entry, dict)]
        outputs.append(result.get('output'))
        engine_runs.append(result.get('engineRunId'))
        if result.get('label') != label:
            problems.append(f'{label}: workflow reported label {result.get("label")!r}')
        expected = _expected_observation(label)
        if result.get('output') != expected:
            problems.append(f'{label}: output {result.get("output")!r} != {expected!r}')
        if log.get('label') != label:
            problems.append(f'{label}: trusted readback label {log.get("label")!r}')
        # The measurement log is label-keyed and every entry carries its own label. A crossed
        # entry means one Run's port observed another Run's work and must fail the probe.
        if any(entry.get('label') != label for entry in entries):
            problems.append(f"{label}: measurement log contains another Run's observation")
        models = [entry for entry in entries if entry.get('kind') == 'model']
        tools = [entry for entry in entries if entry.get('kind') == 'tool']
        if len(models) != 2:
            problems.append(f'{label}: model activities observed {len(models)}, expected 2')
        if len(tools) != 1:
            problems.append(f'{label}: tool activities observed {len(tools)}, expected 1')
        if [entry.get('sawToolReturn') for entry in models] != [False, True]:
            problems.append(
                f'{label}: model history flags {[entry.get("sawToolReturn") for entry in models]}, '
                'expected [False, True]'
            )
        # Each model activity must have held its own fresh guard; this is per-activity evidence,
        # not a durable whole-Run budget claim.
        if any(entry.get('guardSteps') != 1 for entry in models):
            problems.append(f'{label}: a model activity did not hold its own fresh guard')
        if tools:
            if tools[0].get('callId') != f'{label}-call-1' or tools[0].get('name') != TOOL_NAME:
                problems.append(f'{label}: tool observation {tools[0]!r} is not the expected call')
            if tools[0].get('guardToolCalls') != 1:
                problems.append(
                    f'{label}: tool activity guard counted {tools[0].get("guardToolCalls")} calls'
                )
            entered, exited = tools[0].get('enteredAt'), tools[0].get('exitedAt')
            if (type(entered) not in (int, float) or type(exited) not in (int, float)
                    or entered >= exited):
                problems.append(f'{label}: tool activity interval missing or invalid')
            else:
                tool_intervals[label] = (float(entered), float(exited))
        counts = record.get('activities', {})
        for marker, minimum, exact in (
            ('model_request', 2, None),
            ('call_tool', 1, 1),
            ('get_tools', 1, None),
        ):
            completed = counts.get(marker, {}).get('completed', 0)
            if completed < minimum or (exact is not None and completed != exact):
                problems.append(
                    f'{label}: history {marker} completed={completed}, '
                    f'expected >= {minimum}' + (f' and == {exact}' if exact is not None else '')
                )
    if len(set(outputs)) != len(labels):
        problems.append('outputs are not distinct across Runs')
    if len({run for run in engine_runs if run}) != len(labels):
        problems.append('engine Run IDs are not distinct across Runs')
    if len(tool_intervals) == len(PROBE_LABELS):
        if max(start for start, _ in tool_intervals.values()) >= min(
                end for _, end in tool_intervals.values()):
            problems.append('tool activities did not actually overlap in the worker')
    return problems


def _compact(evidence: dict) -> dict:
    return {
        label: {
            'output': record.get('result', {}).get('output'),
            'observations': record.get('result', {}).get('runLog', {}).get('entries'),
            'history': record.get('activities'),
        }
        for label, record in evidence.items()
    }


def _assert_pins() -> None:
    try:
        temporal = version('temporalio')
    except PackageNotFoundError:
        raise SystemExit('temporalio is not installed; install the pinned 1.33.0 environment first')
    pydantic_ai_version = None
    for distribution in ('pydantic-ai-slim', 'pydantic-ai'):
        try:
            pydantic_ai_version = version(distribution)
            break
        except PackageNotFoundError:
            continue
    if temporal != '1.33.0' or pydantic_ai_version != '2.47.0':
        raise SystemExit(
            f'pinned environment required: temporalio==1.33.0 and pydantic-ai-slim==2.47.0, '
            f'observed temporalio=={temporal} pydantic-ai=={pydantic_ai_version}'
        )


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--address',
        default=os.environ.get('OPENBOT_TEMPORAL_ADDRESS') or os.environ.get('TEMPORAL_ADDRESS'),
        help='Disposable Temporal frontend address (or OPENBOT_TEMPORAL_ADDRESS/TEMPORAL_ADDRESS)',
    )
    parser.add_argument(
        '--namespace',
        default=os.environ.get('OPENBOT_TEMPORAL_NAMESPACE') or 'default',
    )
    parser.add_argument(
        '--task-queue',
        default=os.environ.get('OPENBOT_TEMPORAL_TASK_QUEUE') or PROBE_ID,
    )
    parser.add_argument(
        '--timeout',
        type=float,
        default=75.0,
        help='Bound on each Workflow result, in seconds',
    )
    args = parser.parse_args(argv)
    if not args.address:
        parser.error('a disposable Temporal address is required via --address or env')
    return args


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    _assert_pins()
    silence_sdk_startup_banner()
    if getattr(MultirunPortProbeWorkflow, '__pydantic_ai_agents__', None) != [SINGLE_AGENT]:
        print(json.dumps({'case': PROBE_ID, 'status': 'FAIL', 'problem': 'not exactly one Agent'}))
        return 1
    try:
        evidence = asyncio.run(_run(args))
    except Exception as exc:  # bounded diagnostic only; no payloads or private output
        print(
            json.dumps(
                {
                    'case': PROBE_ID,
                    'status': 'FAIL',
                    'stage': 'execution',
                    'error': f'{type(exc).__name__}: {exc}'[:400],
                }
            )
        )
        return 1
    problems = _collect_problems(evidence)
    report = {
        'case': PROBE_ID,
        'status': 'FAIL' if problems else 'PASS',
        'evidence': _compact(evidence),
    }
    if problems:
        report['problems'] = problems
    print(json.dumps(report))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
