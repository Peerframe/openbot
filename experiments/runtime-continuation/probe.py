#!/usr/bin/env python3
"""Cross-process pause/resume of one runtime segment on the pinned SDK.

What this measures
------------------
OpenBot's Runtime is a bounded execution unit: the control service admits a segment, the Runtime
proposes actions, and continuation belongs to the control service
(``docs/WORK_EXECUTION_CONTRACT.md``). This probe asks one narrow question: can the pinned SDK's
**released** stop-the-world interface carry a segment across a process boundary?

A scripted in-process ``Model`` requests two tools that are declared external, so the run ends with
the SDK's own ``DeferredToolRequests`` output and no side effect of any kind happens. The SDK's own
message history is serialized with ``ModelMessagesTypeAdapter`` into a synthetic checkpoint, the
process exits, and a **fresh** interpreter restores the checkpoint and supplies control-provided
completed outcomes through ``Agent.run(deferred_tool_results=...)``.

Nothing here is a production checkpoint format, an approval store, a budget ledger or a claim about
durability. The scripted model is a fixture: it makes the run deterministic and keeps every provider
and credential out of the experiment. See ``docs/research/runtime-continuation.md``.

Run with the package-local interpreter, from anywhere:

    apps/agent-runtime-python/.venv/bin/python experiments/runtime-continuation/probe.py

Exit code 0 means every case produced the outcome recorded in ``EXPECTED`` below. The parent owns
that table and re-checks the child-written observations, so a child cannot declare its own success.
``--keep`` keeps the temporary directory for independent inspection.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import fnmatch
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import warnings
from pathlib import Path
from typing import Any, Callable

PINNED_PACKAGE = "pydantic-ai-slim"
PINNED_VERSION = "2.47.0"
# Tag `v2.47.0` of pydantic/pydantic-ai, the revision already reviewed in
# apps/agent-runtime-python/RESEARCH.md section 1. Recorded in the checkpoint envelope so a version
# change requires an explicit compatibility/migration choice, never silent Task loss.
PINNED_COMMIT = "77d5fce751ab8ab04bd5db4ed6acc1131a4baed6"

ENVELOPE_FORMAT = "openbot-runtime-continuation-probe/1"

# Bounds. The Runtime already measures the payload handed to its model port; this probe applies the
# same discipline to the checkpoint and to the resumed request, so an unbounded payload fails closed.
MAX_CHECKPOINT_BYTES = 256 * 1024
MAX_REQUEST_BYTES = 64 * 1024
MAX_OUTPUT_CHARS = 4096
# One bounded run per segment. There is deliberately no retry loop: the experiment must never look
# like an indefinite whole-loop activity, and a hung run has to be an observed failure, not a wait.
RUN_TIMEOUT_SECONDS = 20.0
CHILD_TIMEOUT_SECONDS = 90.0

PROMOTED = "Fix row 7"
FINAL_REPORT = "report:2"
CONTROL_READ_RESULT = {"value": "row-7"}
CONTROL_WRITE_RESULT = "applied"

CALL_READ = "c-read"
CALL_WRITE = "c-write"

# The parent fills this before dispatching a child; a child reads `--work` and stores it here.
WORK: dict[str, str] = {}
# Populated only inside a child, so the parent never has to import the SDK.
SDK: dict[str, Any] = {}


# --------------------------------------------------------------------------------------------------
# Ledger: cross-process, append-only observation log. Counters are deliberately not kept in memory so
# that "the model was called once more" and "a completed tool ran again" are counted the same way on
# both sides of the process boundary.
# --------------------------------------------------------------------------------------------------


class Ledger:
    def __init__(self, path: Path, scope: str) -> None:
        self._path = path
        self._scope = scope

    def record(self, kind: str, **fields: Any) -> None:
        entry = {"scope": self._scope, "kind": kind, "at": round(time.monotonic(), 6), **fields}
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True, default=str) + "\n")


class ProbeFailure(RuntimeError):
    """A fixture invariant broke; the case must end as an observed failure, never as a pass."""


# --------------------------------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------------------------------


def load_sdk() -> dict[str, Any]:
    """Import the pinned SDK and fail loudly if the interpreter or the pin is wrong.

    Never install, never fall back to another version, never import a provider SDK.
    """
    import pydantic_ai

    if pydantic_ai.__version__ != PINNED_VERSION:
        raise SystemExit(
            f"expected {PINNED_PACKAGE}=={PINNED_VERSION} in this interpreter, found "
            f"{pydantic_ai.__version__} at {pydantic_ai.__file__}. Run this probe with "
            "apps/agent-runtime-python/.venv/bin/python; the probe never installs anything."
        )
    # The SDK prints a startup banner to stdout on the first run, and stdout carries this probe's own
    # channel. Same public switch the runtime uses (RESEARCH.md 3a.6).
    pydantic_ai.BANNER_ENABLED = False

    from pydantic_ai import (
        Agent,
        ApprovalRequiredToolset,
        DeferredToolRequests,
        DeferredToolResults,
        ToolDenied,
    )
    from pydantic_ai.messages import (
        ModelMessagesTypeAdapter,
        ModelResponse,
        TextPart,
        ToolCallPart,
    )
    from pydantic_ai.models import Model
    from pydantic_ai.tools import ToolDefinition
    from pydantic_ai.toolsets import ExternalToolset, FunctionToolset
    from pydantic_ai.usage import RunUsage, UsageLimits

    return {
        "Agent": Agent,
        "ApprovalRequiredToolset": ApprovalRequiredToolset,
        "DeferredToolRequests": DeferredToolRequests,
        "DeferredToolResults": DeferredToolResults,
        "ToolDenied": ToolDenied,
        "ModelMessagesTypeAdapter": ModelMessagesTypeAdapter,
        "ModelResponse": ModelResponse,
        "TextPart": TextPart,
        "ToolCallPart": ToolCallPart,
        "Model": Model,
        "ToolDefinition": ToolDefinition,
        "ExternalToolset": ExternalToolset,
        "FunctionToolset": FunctionToolset,
        "RunUsage": RunUsage,
        "UsageLimits": UsageLimits,
    }


def ScriptedModel(ledger: Ledger, script: list[Any], tag: str) -> Any:  # noqa: N802 - factory
    """A ``Model`` whose steps are fixed, so the run needs no provider, network or credential.

    It also applies the probe's request-size bound and records, for every step, what the SDK actually
    handed it. The recorded last-message part kinds are the evidence that a resumed step receives tool
    observations instead of a reissued original request.
    """
    model_base = SDK["Model"]
    adapter = SDK["ModelMessagesTypeAdapter"]

    class _Scripted(model_base):  # type: ignore[misc, valid-type]
        def __init__(self) -> None:
            super().__init__()
            self._script = list(script)
            self._index = 0

        @property
        def model_name(self) -> str:
            return "probe-scripted"

        @property
        def system(self) -> str:
            return "openbot"

        async def request(self, messages: list[Any], model_settings: Any, parameters: Any) -> Any:
            payload = adapter.dump_json(messages)
            if len(payload) > MAX_REQUEST_BYTES:
                raise ProbeFailure(
                    f"model request is {len(payload)} bytes, above the probe bound of "
                    f"{MAX_REQUEST_BYTES}"
                )
            index = self._index
            self._index += 1
            last_parts = [type(part).__name__ for part in messages[-1].parts] if messages else []
            ledger.record(
                "model_request",
                tag=tag,
                step=index + 1,
                request_bytes=len(payload),
                history_messages=len(messages),
                last_message_parts=last_parts,
            )
            if index >= len(self._script):
                raise ProbeFailure(f"script for {tag!r} exhausted at step {index + 1}")
            return self._script[index]

    return _Scripted()


def CountingExternalToolset(ledger: Ledger, tool_defs: list[Any]) -> Any:  # noqa: N802 - factory
    """An ``ExternalToolset`` that records every attempted local invocation before refusing.

    The SDK documents that an external tool's result is produced outside the run. If the SDK ever
    invoked it locally, this counter would move and the case would fail.
    """
    base = SDK["ExternalToolset"]

    class _Counting(base):  # type: ignore[misc, valid-type]
        def __init__(self) -> None:
            super().__init__(tool_defs, id="probe-external")

        async def call_tool(self, name: str, tool_args: dict[str, Any], ctx: Any, tool: Any) -> Any:
            ledger.record("deferred_tool_local_attempt", name=name, call_id=ctx.tool_call_id)
            return await super().call_tool(name, tool_args, ctx, tool)

    return _Counting()


def external_tool_definitions() -> list[Any]:
    definition = SDK["ToolDefinition"]
    key_schema = {
        "type": "object",
        "properties": {"key": {"type": "string"}},
        "required": ["key"],
        "additionalProperties": False,
    }
    write_schema = {
        "type": "object",
        "properties": {"key": {"type": "string"}, "value": {"type": "string"}},
        "required": ["key", "value"],
        "additionalProperties": False,
    }
    return [
        definition(name="external_read", parameters_json_schema=key_schema, description="read a row"),
        definition(
            name="external_write", parameters_json_schema=write_schema, description="update a row"
        ),
    ]


def observation_tool(ledger: Ledger) -> Any:
    """A read-only local tool that is genuinely executed by the SDK inside the run."""

    def probe_observation(name: str) -> str:
        ledger.record("local_tool_body", name="probe_observation", call_site="sdk")
        return f"observed:{name}"

    return probe_observation


def local_artifact_tool(ledger: Ledger, artifact: Path) -> Any:
    """A local function tool that performs a real filesystem effect.

    It exists to measure one thing: whether the SDK executes a locally declared effect without any
    control handshake. It is not a model of the Runtime's tool port (the port calls the Server and
    adds ``assertScope``); it is the hazard the port exists to prevent.
    """

    def local_effect(value: str) -> str:
        ledger.record("local_tool_body", name="local_effect", call_site="sdk")
        artifact.write_text(value, encoding="utf-8")
        return "written"

    return local_effect


def guarded_artifact_tool(ledger: Ledger, artifact: Path) -> Any:
    def guarded_write(value: str) -> str:
        ledger.record("local_tool_body", name="guarded_write", call_site="sdk")
        artifact.write_text(value, encoding="utf-8")
        return "written"

    return guarded_write


def approval_wrapped(tool: Any) -> Any:
    return SDK["ApprovalRequiredToolset"](SDK["FunctionToolset"]([tool]))


def build_agent(model: Any, *, tools: tuple[Any, ...] = (), toolsets: tuple[Any, ...] = ()) -> Any:
    """Build a bounded agent: explicit output types, no retries, no telemetry, no guessed defaults."""
    agent = SDK["Agent"](
        model,
        output_type=[str, SDK["DeferredToolRequests"]],
        tools=list(tools),
        toolsets=list(toolsets),
        retries=0,
    )
    # 2.47.0 has no `instrument=` keyword; `Agent.instrument` is the public switch. The SDK default is
    # already off, so this asserts intent instead of relying on it.
    agent.instrument = False
    assert agent.instrument is False
    return agent


def response(*parts: Any) -> Any:
    return SDK["ModelResponse"](parts=list(parts))


def tool_call(name: str, args: dict[str, Any], call_id: str) -> Any:
    return SDK["ToolCallPart"](name, args, tool_call_id=call_id)


def text(value: str) -> Any:
    return SDK["TextPart"](value)


def two_call_response() -> Any:
    return response(
        tool_call("external_read", {"key": "row-7"}, CALL_READ),
        tool_call("external_write", {"key": "row-7", "value": "fixed"}, CALL_WRITE),
    )


def usage_limits(**kwargs: Any) -> Any:
    """Explicit, tight limits. The SDK's default `request_limit` is 50; this probe never uses it."""
    return SDK["UsageLimits"](**kwargs)


async def bounded(coro_factory: Callable[[], Any]) -> Any:
    """One bounded run. There is no retry and no open-ended wait."""
    return await asyncio.wait_for(coro_factory(), RUN_TIMEOUT_SECONDS)


async def capture(coro_factory: Callable[[], Any]) -> tuple[Any, str | None, str | None]:
    """Return ``(value, error_type, error_message)`` without letting a failure abort the case."""
    try:
        return await bounded(coro_factory), None, None
    except Exception as exc:  # the SDK signals contract violations with ordinary exceptions
        return None, type(exc).__name__, str(exc)


def dump_history(messages: list[Any]) -> bytes:
    payload = SDK["ModelMessagesTypeAdapter"].dump_json(messages)
    if len(payload) > MAX_CHECKPOINT_BYTES:
        raise ProbeFailure(
            f"checkpoint is {len(payload)} bytes, above the probe bound of {MAX_CHECKPOINT_BYTES}"
        )
    return payload


def load_history(payload: bytes) -> list[Any]:
    return SDK["ModelMessagesTypeAdapter"].validate_json(payload)


# --------------------------------------------------------------------------------------------------
# Checkpoint envelope
#
# The probe writes the shape it believes the control service must own. It is a proposal backed by the
# measurements in this file, not a production format: the point is which facts the SDK does *not*
# carry.
# --------------------------------------------------------------------------------------------------


def build_envelope(
    *,
    history: bytes,
    messages: list[Any],
    deferred: Any,
    run_id: str,
    conversation_id: str,
    usage: Any,
) -> dict[str, Any]:
    return {
        "format": ENVELOPE_FORMAT,
        "sdk": {"package": PINNED_PACKAGE, "version": PINNED_VERSION, "commit": PINNED_COMMIT},
        "strategy": {"id": "probe-scripted-model", "output_types": ["str", "DeferredToolRequests"]},
        "message_schema": {"adapter": "ModelMessagesTypeAdapter", "version": 1},
        "run_id": run_id,
        "conversation_id": conversation_id,
        "history": {
            "messages": len(messages),
            "bytes": len(history),
            "sha256": hashlib.sha256(history).hexdigest(),
        },
        "recorded_usage": dataclasses.asdict(usage),
        "deferred": {
            "calls": [
                {"tool_call_id": call.tool_call_id, "tool_name": call.tool_name, "args": call.args}
                for call in deferred.calls
            ],
            "approvals": [
                {"tool_call_id": call.tool_call_id, "tool_name": call.tool_name, "args": call.args}
                for call in deferred.approvals
            ],
        },
        # Facts a real envelope would also have to pin. Listed here so the gap between "the SDK
        # serialized messages" and "OpenBot knows what happened" stays explicit.
        "control_facts_not_in_sdk_payload": [
            "Task/Run/Action identity (a model tool-call id is only correlation)",
            "authority/scope and its revocation state",
            "approval decision bound to the exact Action intent",
            "budget reservation and settled usage",
            "artifact registration and digests",
        ],
    }


# --------------------------------------------------------------------------------------------------
# Cases. Every child writes one report; the parent re-checks it against EXPECTED.
# --------------------------------------------------------------------------------------------------


def case_dir(name: str) -> Path:
    directory = Path(WORK["dir"]) / name
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def ledger_for(scope: str) -> Ledger:
    return Ledger(Path(WORK["dir"]) / "events.jsonl", scope)


def report(case: str, observations: dict[str, Any], error: dict[str, Any] | None = None) -> None:
    directory = Path(WORK["dir"]) / "reports"
    directory.mkdir(parents=True, exist_ok=True)
    payload = {"case": case, "observations": observations, "error": error}
    (directory / f"{case}.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def external_stack(ledger: Ledger) -> tuple[Any, Any, Any]:
    """The tool surface every case shares: one external toolset and one scripted model factory."""
    external = CountingExternalToolset(ledger, external_tool_definitions())

    def model(script: list[Any], tag: str) -> Any:
        return ScriptedModel(ledger, script, tag)

    def tool() -> Any:
        return observation_tool(ledger)

    return external, model, tool


def case_continuation_first() -> dict[str, Any]:
    """Segment 1: provoke two deferred calls, checkpoint the SDK's own history, then exit."""
    directory = case_dir("continuation")
    ledger = ledger_for("continuation/first")
    run_id, conversation_id = "probe-run-1", "probe-conversation"
    external, model, tool = external_stack(ledger)

    model_with_script = model(
        [response(tool_call("probe_observation", {"name": "row-7"}, "c-obs")), two_call_response()],
        "first",
    )
    agent = build_agent(model_with_script, tools=(tool(),), toolsets=(external,))

    async def run() -> Any:
        return await agent.run(
            PROMOTED,
            run_id=run_id,
            conversation_id=conversation_id,
            usage_limits=usage_limits(request_limit=6, tool_calls_limit=6),
        )

    result, error_type, error_message = asyncio.run(capture(run))
    if result is None:
        return {"output_type": None, "error_type": error_type, "error_message": error_message}

    output = result.output
    history = result.all_messages()
    history_bytes = dump_history(history)
    (directory / "history.json").write_bytes(history_bytes)
    envelope = build_envelope(
        history=history_bytes,
        messages=history,
        deferred=output,
        run_id=result.run_id,
        conversation_id=result.conversation_id,
        usage=result.usage,
    )
    (directory / "envelope.json").write_text(
        json.dumps(envelope, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    # The deferred call descriptions are deliberately *not* inside the message payload: the SDK
    # serializes messages, and a `DeferredToolRequests` is a separate output object. Persisting them
    # is the control service's job, so the probe keeps them beside the history and says so.
    deferred_payload = {
        "calls": [
            {"tool_call_id": call.tool_call_id, "tool_name": call.tool_name, "args": call.args}
            for call in output.calls
        ],
        "approvals": [
            {"tool_call_id": call.tool_call_id, "tool_name": call.tool_name, "args": call.args}
            for call in output.approvals
        ],
    }
    (directory / "deferred.json").write_text(
        json.dumps(deferred_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    return {
        "output_type": type(output).__name__,
        "deferred_call_names": [call.tool_name for call in output.calls],
        "deferred_call_ids": [call.tool_call_id for call in output.calls],
        "deferred_approval_count": len(output.approvals),
        "history_message_kinds": [type(message).__name__ for message in history],
        "checkpoint_bytes": len(history_bytes),
        "envelope_history_digest_matches": hashlib.sha256(
            (directory / "history.json").read_bytes()
        ).hexdigest()
        == envelope["history"]["sha256"],
        "envelope_format": envelope["format"],
        "envelope_sdk_version": envelope["sdk"]["version"],
        "recorded_usage_requests": result.usage.requests,
        "run_id": result.run_id,
        "last_error": error_type,
    }


def case_continuation_resume() -> dict[str, Any]:
    """Segment 2 in a fresh interpreter: restore, validate, supply control outcomes, finish."""
    directory = case_dir("continuation")
    ledger = ledger_for("continuation/resume")
    history_bytes = (directory / "history.json").read_bytes()
    envelope = json.loads((directory / "envelope.json").read_text(encoding="utf-8"))
    control_results = json.loads((directory / "control-results.json").read_text(encoding="utf-8"))
    observations: dict[str, Any] = {}

    # Control-side validation 1: integrity. The SDK adapter validates shape, not authenticity, so a
    # mutated-but-well-formed checkpoint loads happily. The digest has to be checked here.
    observations["integrity_digest_matches"] = (
        hashlib.sha256(history_bytes).hexdigest() == envelope["history"]["sha256"]
    )
    if not observations["integrity_digest_matches"]:
        raise ProbeFailure("checkpoint digest does not match the envelope; refusing to resume")

    # Control-side validation 2: the pinned versions still match, otherwise the checkpoint is stale.
    import pydantic_ai

    observations["sdk_version_matches"] = (
        envelope["sdk"]["version"] == PINNED_VERSION == pydantic_ai.__version__
        and envelope["sdk"]["commit"] == PINNED_COMMIT
    )
    observations["envelope_format_matches"] = envelope["format"] == ENVELOPE_FORMAT

    history = load_history(history_bytes)

    # Control-side validation 3: correlation. Only the last response's call ids may be answered, all
    # eligible ids must be answered, and nothing may be answered twice.
    last_response = next(
        message for message in reversed(history) if type(message).__name__ == "ModelResponse"
    )
    response_ids = [part.tool_call_id for part in last_response.parts if hasattr(part, "tool_call_id")]
    deferred = json.loads((directory / "deferred.json").read_text(encoding="utf-8"))
    deferred_ids = [entry["tool_call_id"] for entry in deferred["calls"]]
    observations["response_call_ids"] = sorted(response_ids)
    observations["deferred_call_ids"] = sorted(deferred_ids)
    observations["result_ids_are_exactly_deferred_ids"] = sorted(control_results) == sorted(deferred_ids)
    observations["no_duplicate_call_ids"] = len(set(response_ids)) == len(response_ids)
    observations["deferred_ids_match_last_response"] = sorted(deferred_ids) == sorted(response_ids)

    # Control-side validation 4: the budget carries. A fresh `usage` object silently resets the SDK's
    # own counter, which would let a resume spend budget the previous segment already consumed.
    run_usage = SDK["RunUsage"](**envelope["recorded_usage"])
    recorded_requests = run_usage.requests

    external, model, tool = external_stack(ledger)
    agent = build_agent(model([response(text(FINAL_REPORT))], "resume"), tools=(tool(),), toolsets=(external,))
    results = SDK["DeferredToolResults"](calls=dict(control_results))

    async def run() -> Any:
        return await agent.run(
            message_history=history,
            deferred_tool_results=results,
            # A follow-up run needs its own id; the SDK refuses to reuse a run id found in the
            # history. Pause/resume correlation is `conversation_id`.
            run_id="probe-run-2",
            conversation_id=envelope["conversation_id"],
            usage=run_usage,
            usage_limits=usage_limits(request_limit=recorded_requests + 2, tool_calls_limit=4),
        )

    result, error_type, error_message = asyncio.run(capture(run))
    if result is None:
        return {
            **observations,
            "output": None,
            "error_type": error_type,
            "error_message": error_message,
        }

    output = result.output
    if not isinstance(output, str):
        raise ProbeFailure(f"resumed run ended with {type(output).__name__}, expected str")
    observations.update(
        {
            "output": output,
            "output_type": type(output).__name__,
            "output_chars_bounded": len(output) <= MAX_OUTPUT_CHARS,
            "resumed_run_id_differs": result.run_id != envelope["run_id"],
            "conversation_id_preserved": result.conversation_id == envelope["conversation_id"],
            "recorded_usage_requests": recorded_requests,
            "final_usage_requests": result.usage.requests,
            "last_error": error_type,
        }
    )
    return observations


def _resume_failure(
    scope: str, results: Any, *, run_id: str, history: list[Any] | None = None
) -> tuple[str | None, str | None, Any]:
    """Run one resume that is expected to fail, and report how it failed."""
    directory = case_dir("continuation")
    ledger = ledger_for(scope)
    external, model, tool = external_stack(ledger)
    agent = build_agent(
        model([response(text("unreachable"))], scope), tools=(tool(),), toolsets=(external,)
    )
    payload = history if history is not None else load_history((directory / "history.json").read_bytes())

    async def run() -> Any:
        return await agent.run(
            message_history=payload,
            deferred_tool_results=results,
            run_id=run_id,
            usage_limits=usage_limits(request_limit=2),
        )

    return asyncio.run(capture(run))


def case_missing_result() -> dict[str, Any]:
    """One of two outcomes is missing: fail closed before the model is asked anything."""
    results = SDK["DeferredToolResults"](calls={CALL_READ: CONTROL_READ_RESULT})
    _, error_type, error_message = _resume_failure("missing-result", results, run_id="probe-missing")
    return {
        "error_type": error_type,
        "error_message": error_message,
        "message_names_expected_and_got": bool(error_message)
        and "Expected:" in error_message
        and "got:" in error_message,
    }


def case_unknown_result_id() -> dict[str, Any]:
    """An outcome id that matches nothing: an unknown external result must not become a fact."""
    results = SDK["DeferredToolResults"](
        calls={CALL_READ: CONTROL_READ_RESULT, CALL_WRITE: CONTROL_WRITE_RESULT, "c-ghost": "invented"}
    )
    _, error_type, error_message = _resume_failure("unknown-id", results, run_id="probe-unknown")
    return {
        "error_type": error_type,
        "error_message": error_message,
        "rejects_unknown_id": bool(error_message) and "c-ghost" in error_message,
    }


def case_wrong_kind_result() -> dict[str, Any]:
    """An approval supplied for an external call: the SDK tries to execute the tool after all."""
    results = SDK["DeferredToolResults"](
        approvals={CALL_READ: True}, calls={CALL_WRITE: CONTROL_WRITE_RESULT}
    )
    _, error_type, error_message = _resume_failure("wrong-kind", results, run_id="probe-wrong-kind")
    return {"error_type": error_type, "error_message": error_message}


def case_already_completed_result() -> dict[str, Any]:
    """A result for a call the SDK already executed locally. Reports whether the body ran again."""
    directory = case_dir("already-completed")
    ledger = ledger_for("already-completed")
    external, model, tool = external_stack(ledger)
    first_agent = build_agent(
        model(
            [
                response(tool_call("probe_observation", {"name": "row-7"}, "c-obs")),
                response(tool_call("external_read", {"key": "row-7"}, CALL_READ)),
            ],
            "already-completed-first",
        ),
        tools=(tool(),),
        toolsets=(external,),
    )

    async def first() -> Any:
        return await first_agent.run(
            PROMOTED, run_id="probe-already-1", usage_limits=usage_limits(request_limit=6)
        )

    first_result, first_error, first_message = asyncio.run(capture(first))
    if first_result is None:
        return {
            "replay_error_type": None,
            "first_error_type": first_error,
            "first_error_message": first_message,
        }

    history = load_history(dump_history(first_result.all_messages()))
    results = SDK["DeferredToolResults"](calls={"c-obs": "replayed", CALL_READ: CONTROL_READ_RESULT})
    _, replay_error, replay_message = _resume_failure(
        "already-completed-replay", results, run_id="probe-already-2", history=history
    )
    return {
        "replay_error_type": replay_error,
        "replay_error_message": replay_message,
        "first_error_type": None,
    }


def case_duplicate_call_ids() -> dict[str, Any]:
    """A response carrying the same tool-call id twice: correlation would be ambiguous."""
    ledger = ledger_for("duplicate-id")
    external, model, _ = external_stack(ledger)
    agent = build_agent(
        model(
            [
                response(
                    tool_call("external_read", {"key": "row-7"}, "c-dup"),
                    tool_call("external_write", {"key": "row-7", "value": "fixed"}, "c-dup"),
                )
            ],
            "duplicate-id",
        ),
        toolsets=(external,),
    )

    async def run() -> Any:
        return await agent.run("duplicate", run_id="probe-dup", usage_limits=usage_limits(request_limit=2))

    _, error_type, error_message = asyncio.run(capture(run))
    return {"error_type": error_type, "error_message": error_message}


def case_corrupt_checkpoint() -> dict[str, Any]:
    """Truncation, id mutation and an empty history: which of them does the SDK actually refuse?"""
    directory = case_dir("continuation")
    ledger = ledger_for("corrupt-checkpoint")
    original = (directory / "history.json").read_bytes()
    envelope = json.loads((directory / "envelope.json").read_text(encoding="utf-8"))
    adapter = SDK["ModelMessagesTypeAdapter"]
    observations: dict[str, Any] = {}

    try:
        adapter.validate_json(original[:40])
        observations["truncated_error_type"] = None
    except Exception as exc:
        observations["truncated_error_type"] = type(exc).__name__

    mutated = original.replace(b'"c-read"', b'"c-r3ad"')
    observations["mutation_changed_bytes"] = mutated != original
    observations["mutated_digest_matches_envelope"] = (
        hashlib.sha256(mutated).hexdigest() == envelope["history"]["sha256"]
    )
    try:
        loaded = adapter.validate_json(mutated)
        observations["mutated_accepted_by_sdk"] = True
        observations["mutated_ids_visible_to_sdk"] = sorted(
            part.tool_call_id
            for message in loaded
            if type(message).__name__ == "ModelResponse"
            for part in message.parts
            if hasattr(part, "tool_call_id")
        )
    except Exception as exc:
        observations["mutated_accepted_by_sdk"] = False
        observations["mutated_error_type"] = type(exc).__name__

    try:
        empty = adapter.validate_json(b"[]")
        observations["empty_history_accepted_by_sdk"] = True
        observations["empty_history_length"] = len(empty)
    except Exception as exc:
        observations["empty_history_accepted_by_sdk"] = False
        observations["empty_history_error_type"] = type(exc).__name__

    results = SDK["DeferredToolResults"](calls={CALL_READ: CONTROL_READ_RESULT})
    _, empty_error, empty_message = _resume_failure(
        "corrupt-empty", results, run_id="probe-empty", history=[]
    )
    observations["empty_history_resume_error_type"] = empty_error
    observations["empty_history_resume_message"] = empty_message

    # The probe's own control-side reference check, for contrast with the adapter.
    observations["digest_guard_would_reject_mutation"] = (
        hashlib.sha256(mutated).hexdigest() != envelope["history"]["sha256"]
    )
    return observations


def case_final_text() -> dict[str, Any]:
    """A segment that needs no tools at all: a plain final text run."""
    ledger = ledger_for("final-text")
    agent = build_agent(ScriptedModel(ledger, [response(text("nothing to do"))], "final-text"))

    async def run() -> Any:
        return await agent.run(
            "no tools here", run_id="probe-final-text", usage_limits=usage_limits(request_limit=2)
        )

    result, error_type, error_message = asyncio.run(capture(run))
    if result is None:
        return {"output_type": None, "error_type": error_type, "error_message": error_message}
    return {
        "output": result.output,
        "output_type": type(result.output).__name__,
        "is_deferred_requests": type(result.output).__name__ == "DeferredToolRequests",
        "last_error": error_type,
    }


def case_local_execution() -> dict[str, Any]:
    """Attempted runtime tool execution before control consent, for a local function tool."""
    directory = case_dir("local-execution")
    ledger = ledger_for("local-execution")
    unguarded_artifact = directory / "unguarded-effect.txt"
    guarded_artifact = directory / "guarded-effect.txt"

    unguarded_agent = build_agent(
        ScriptedModel(
            ledger,
            [
                response(tool_call("local_effect", {"value": "no consent asked"}, "c-unguarded")),
                response(text("done")),
            ],
            "local-execution-unguarded",
        ),
        tools=(local_artifact_tool(ledger, unguarded_artifact),),
    )

    async def unguarded() -> Any:
        return await unguarded_agent.run(
            "perform the effect", run_id="probe-local-1", usage_limits=usage_limits(request_limit=3)
        )

    unguarded_result, unguarded_error, unguarded_message = asyncio.run(capture(unguarded))

    guarded_agent = build_agent(
        ScriptedModel(
            ledger,
            [response(tool_call("guarded_write", {"value": "needs approval"}, "c-guarded"))],
            "local-execution-guarded",
        ),
        toolsets=(approval_wrapped(guarded_artifact_tool(ledger, guarded_artifact)),),
    )

    async def guarded() -> Any:
        return await guarded_agent.run(
            "perform the effect", run_id="probe-local-2", usage_limits=usage_limits(request_limit=3)
        )

    guarded_result, guarded_error, guarded_message = asyncio.run(capture(guarded))

    observations: dict[str, Any] = {
        "unguarded_output": getattr(unguarded_result, "output", None),
        "unguarded_error_type": unguarded_error,
        "unguarded_error_message": unguarded_message,
        "unguarded_artifact_written": unguarded_artifact.exists(),
        "guarded_output_type": type(guarded_result.output).__name__ if guarded_result else None,
        "guarded_error_type": guarded_error,
        "guarded_artifact_written": guarded_artifact.exists(),
    }
    if guarded_result is not None and type(guarded_result.output).__name__ == "DeferredToolRequests":
        observations["guarded_approval_ids"] = [
            call.tool_call_id for call in guarded_result.output.approvals
        ]
    else:
        observations["guarded_approval_ids"] = None
    return observations


def _approval_case(scope: str, resume_run_id: str, approval: Any) -> tuple[Any, str | None, str | None, Path]:
    directory = case_dir(scope)
    ledger = ledger_for(scope)
    artifact = directory / f"{scope}-effect.txt"
    toolset = approval_wrapped(guarded_artifact_tool(ledger, artifact))
    first_agent = build_agent(
        ScriptedModel(
            ledger,
            [response(tool_call("guarded_write", {"value": scope}, "c-guarded"))],
            f"{scope}-first",
        ),
        toolsets=(toolset,),
    )

    async def first() -> Any:
        return await first_agent.run(
            "perform the effect", run_id=f"{scope}-1", usage_limits=usage_limits(request_limit=3)
        )

    first_result, first_error, first_message = asyncio.run(capture(first))
    if first_result is None:
        return None, first_error, first_message, artifact

    history = load_history(dump_history(first_result.all_messages()))
    resumed_agent = build_agent(
        ScriptedModel(ledger, [response(text("understood"))], f"{scope}-resume"), toolsets=(toolset,)
    )
    results = SDK["DeferredToolResults"](approvals={"c-guarded": approval})

    async def resume() -> Any:
        return await resumed_agent.run(
            message_history=history,
            deferred_tool_results=results,
            run_id=resume_run_id,
            usage_limits=usage_limits(request_limit=2),
        )

    result, error_type, error_message = asyncio.run(capture(resume))
    return result, error_type, error_message, artifact


def case_denial() -> dict[str, Any]:
    """Denial: the model learns the call was refused and the body never runs."""
    result, error_type, error_message, artifact = _approval_case(
        "denial", "probe-denial-2", SDK["ToolDenied"]("not allowed")
    )
    return {
        "output": getattr(result, "output", None),
        "output_type": type(result.output).__name__ if result else None,
        "error_type": error_type,
        "error_message": error_message,
        "artifact_written": artifact.exists(),
    }


def case_approval_executes() -> dict[str, Any]:
    """Approval is not consent by itself: with `True` the SDK executes the local body on resume."""
    result, error_type, error_message, artifact = _approval_case(
        "approval-executes", "probe-approve-2", True
    )
    return {
        "output": getattr(result, "output", None),
        "output_type": type(result.output).__name__ if result else None,
        "error_type": error_type,
        "error_message": error_message,
        "artifact_content": artifact.read_text(encoding="utf-8") if artifact.exists() else None,
    }


def case_budget_carry() -> dict[str, Any]:
    """Carrying the recorded usage constrains the resume; a fresh usage object resets the counter."""
    directory = case_dir("continuation")
    ledger = ledger_for("budget-carry")
    history = load_history((directory / "history.json").read_bytes())
    envelope = json.loads((directory / "envelope.json").read_text(encoding="utf-8"))
    results = SDK["DeferredToolResults"](
        calls={CALL_READ: CONTROL_READ_RESULT, CALL_WRITE: CONTROL_WRITE_RESULT}
    )
    external, model, tool = external_stack(ledger)

    def attempt(carry: dict[str, Any] | None, request_limit: int) -> tuple[str | None, str | None]:
        agent = build_agent(
            model([response(text("ok"))], "budget-carry"), tools=(tool(),), toolsets=(external,)
        )
        kwargs: dict[str, Any] = {}
        if carry is not None:
            kwargs["usage"] = SDK["RunUsage"](**carry)

        async def run() -> Any:
            return await agent.run(
                message_history=history,
                deferred_tool_results=results,
                run_id=f"probe-budget-{request_limit}-{carry is not None}",
                usage_limits=usage_limits(request_limit=request_limit),
                **kwargs,
            )

        _, error_type, error_message = asyncio.run(capture(run))
        return error_type, error_message

    carried_error, carried_message = attempt(envelope["recorded_usage"], 1)
    fresh_error, fresh_message = attempt(None, 1)
    return {
        "recorded_requests": envelope["recorded_usage"]["requests"],
        "carried_error_type": carried_error,
        "carried_error_message": carried_message,
        "fresh_error_type": fresh_error,
        "fresh_error_message": fresh_message,
    }


def case_run_id_reuse() -> dict[str, Any]:
    """Reusing the paused run's id, as a control-layer mistake."""
    directory = case_dir("continuation")
    envelope = json.loads((directory / "envelope.json").read_text(encoding="utf-8"))
    results = SDK["DeferredToolResults"](
        calls={CALL_READ: CONTROL_READ_RESULT, CALL_WRITE: CONTROL_WRITE_RESULT}
    )
    _, error_type, error_message = _resume_failure(
        "run-id-reuse", results, run_id=envelope["run_id"]
    )
    return {"error_type": error_type, "error_message": error_message}


CHILD_CASES: dict[str, Callable[[], dict[str, Any]]] = {
    "continuation-first": case_continuation_first,
    "continuation-resume": case_continuation_resume,
    "missing-result": case_missing_result,
    "unknown-result-id": case_unknown_result_id,
    "wrong-kind-result": case_wrong_kind_result,
    "already-completed-result": case_already_completed_result,
    "duplicate-call-ids": case_duplicate_call_ids,
    "corrupt-checkpoint": case_corrupt_checkpoint,
    "final-text": case_final_text,
    "local-execution": case_local_execution,
    "denial": case_denial,
    "approval-executes": case_approval_executes,
    "budget-carry": case_budget_carry,
    "run-id-reuse": case_run_id_reuse,
}

CASE_ORDER = list(CHILD_CASES)

# The parent owns the expectations. A child that reports something else makes the probe fail, so a
# child cannot widen its own result.
EXPECTED: dict[str, dict[str, Any]] = {
    "continuation-first": {
        "output_type": "DeferredToolRequests",
        "deferred_call_names": ["external_read", "external_write"],
        "deferred_call_ids": [CALL_READ, CALL_WRITE],
        "deferred_approval_count": 0,
        "history_message_kinds": ["ModelRequest", "ModelResponse", "ModelRequest", "ModelResponse"],
        "envelope_history_digest_matches": True,
        "envelope_format": ENVELOPE_FORMAT,
        "envelope_sdk_version": PINNED_VERSION,
        "recorded_usage_requests": 2,
        "last_error": None,
    },
    "continuation-resume": {
        "integrity_digest_matches": True,
        "sdk_version_matches": True,
        "envelope_format_matches": True,
        "response_call_ids": [CALL_READ, CALL_WRITE],
        "deferred_call_ids": [CALL_READ, CALL_WRITE],
        "result_ids_are_exactly_deferred_ids": True,
        "no_duplicate_call_ids": True,
        "deferred_ids_match_last_response": True,
        "output": FINAL_REPORT,
        "output_type": "str",
        "output_chars_bounded": True,
        "resumed_run_id_differs": True,
        "conversation_id_preserved": True,
        "last_error": None,
    },
    "missing-result": {
        "error_type": "UserError",
        "message_names_expected_and_got": True,
    },
    "unknown-result-id": {
        "error_type": "UserError",
        "rejects_unknown_id": True,
    },
    "wrong-kind-result": {
        "error_type": "RuntimeError",
    },
    "already-completed-result": {
        "replay_error_type": "UserError",
        "first_error_type": None,
    },
    "duplicate-call-ids": {
        "error_type": "UnexpectedModelBehavior",
    },
    "corrupt-checkpoint": {
        "truncated_error_type": "ValidationError",
        "mutation_changed_bytes": True,
        # The SDK validates shape, not authenticity: a rewritten tool-call id loads cleanly and an
        # empty list is a valid history. Only the control-side digest catches the rewrite.
        "mutated_accepted_by_sdk": True,
        "mutated_digest_matches_envelope": False,
        "empty_history_accepted_by_sdk": True,
        "empty_history_length": 0,
        "empty_history_resume_error_type": "UserError",
        "digest_guard_would_reject_mutation": True,
    },
    "final-text": {
        "output": "nothing to do",
        "output_type": "str",
        "is_deferred_requests": False,
        "last_error": None,
    },
    "local-execution": {
        # A locally declared effect runs as soon as the model asks for it: no consent, no admission.
        "unguarded_output": "done",
        "unguarded_error_type": None,
        "unguarded_artifact_written": True,
        # Wrapping the same tool defers the call and does not run the body.
        "guarded_output_type": "DeferredToolRequests",
        "guarded_error_type": None,
        "guarded_artifact_written": False,
        "guarded_approval_ids": ["c-guarded"],
    },
    "denial": {
        "output": "understood",
        "output_type": "str",
        "error_type": None,
        "artifact_written": False,
    },
    "approval-executes": {
        "output": "understood",
        "output_type": "str",
        "error_type": None,
        "artifact_content": "approval-executes",
    },
    "budget-carry": {
        "carried_error_type": "UsageLimitExceeded",
        "fresh_error_type": None,
    },
    "run-id-reuse": {
        "error_type": "UserError",
    },
}

# Cross-process counters, aggregated by the parent from the append-only ledger. `continuation/*` is the
# two-process journey; the other scopes are single-process negative cases and only corroborate.
#
# `probe_observation` is a read-only local tool executed by the SDK during the first segment. If a
# resume replayed it, the total would be 2. `deferred_tool_local_attempt` must stay 0 in the journey:
# an external tool is never called locally, in either process.
EXPECTED_TOTALS: list[dict[str, Any]] = [
    {"label": "model steps in segment 1", "expected": 2, "scope": "continuation/first", "kind": "model_request"},
    {"label": "model steps in segment 2", "expected": 1, "scope": "continuation/resume", "kind": "model_request"},
    {
        "label": "probe_observation executions in segment 1",
        "expected": 1,
        "scope": "continuation/first",
        "kind": "local_tool_body",
        "name": "probe_observation",
    },
    {
        "label": "probe_observation executions in segment 2 (a completed tool must not run again)",
        "expected": 0,
        "scope": "continuation/resume",
        "kind": "local_tool_body",
        "name": "probe_observation",
    },
    {
        "label": "probe_observation executions across the whole journey",
        "expected": 1,
        "scope": "continuation/*",
        "kind": "local_tool_body",
        "name": "probe_observation",
    },
    {
        "label": "local invocations of a deferred tool during the journey",
        "expected": 0,
        "scope": "continuation/*",
        "kind": "deferred_tool_local_attempt",
    },
    {
        "label": (
            "toolset invocations for the wrongly-approved external call "
            "(the SDK refuses at the tool-manager level, before the toolset)"
        ),
        "expected": 0,
        "scope": "wrong-kind",
        "kind": "deferred_tool_local_attempt",
    },
]


# Contract-invalid continuations must fail before another model request or local tool invocation.
# Read counters, not just the child's exception label, so a late refusal cannot pass this assertion.
for refused_scope in ("missing-result", "unknown-id", "wrong-kind", "already-completed-replay", "run-id-reuse"):
    for refused_kind in ("model_request", "local_tool_body", "deferred_tool_local_attempt"):
        EXPECTED_TOTALS.append({"label": f"{refused_scope}: {refused_kind} before refusal",
                                "expected": 0, "scope": refused_scope, "kind": refused_kind})


# --------------------------------------------------------------------------------------------------
# Parent orchestration
# --------------------------------------------------------------------------------------------------


def run_child(case: str, work_dir: Path) -> dict[str, Any]:
    command = [sys.executable, str(Path(__file__).resolve()), "--child", case, "--work", str(work_dir)]
    environment = {
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        # No telemetry, no provider keys, no inherited configuration.
        "PYDANTIC_AI_NO_BANNER": "1",
        "TMPDIR": str(work_dir),
    }
    outcome = subprocess.run(
        command, capture_output=True, text=True, timeout=CHILD_TIMEOUT_SECONDS, env=environment
    )
    report_path = work_dir / "reports" / f"{case}.json"
    if not report_path.exists():
        raise ProbeFailure(
            f"case {case!r} wrote no report (exit {outcome.returncode})\n"
            f"stdout:\n{outcome.stdout}\nstderr:\n{outcome.stderr}"
        )
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    payload["exit_code"] = outcome.returncode
    payload["stderr"] = outcome.stderr
    return payload


def aggregate_ledger(path: Path) -> dict[str, dict[str, int]]:
    """Return ``{scope: {kind-or-kind:name: count}}`` so the parent can slice any way it needs."""
    totals: dict[str, dict[str, int]] = {}
    if not path.exists():
        return totals
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        counts = totals.setdefault(entry["scope"], {})
        kind = entry["kind"]
        counts[kind] = counts.get(kind, 0) + 1
        name = entry.get("name")
        if name:
            counts[f"{kind}:{name}"] = counts.get(f"{kind}:{name}", 0) + 1
    return totals


def select_count(totals: dict[str, dict[str, int]], scope: str, kind: str, name: str | None) -> int:
    key = f"{kind}:{name}" if name else kind
    return sum(
        counts.get(key, 0) for candidate, counts in totals.items() if fnmatch.fnmatch(candidate, scope)
    )


def describe(value: Any) -> str:
    rendered = json.dumps(value, sort_keys=True, default=str)
    return rendered if len(rendered) <= 96 else rendered[:93] + "..."


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--child", choices=sorted(CHILD_CASES), help="internal: run one case")
    parser.add_argument("--work", help="internal: the owned temporary directory")
    parser.add_argument("--keep", action="store_true", help="keep the temporary directory")
    arguments = parser.parse_args(argv)

    if arguments.child:
        if not arguments.work:
            parser.error("--child requires --work")
        WORK["dir"] = arguments.work
        global SDK
        try:
            SDK = load_sdk()
        except SystemExit as exc:
            print(f"{PINNED_PACKAGE} preflight failed: {exc}", file=sys.stderr)
            return 2
        try:
            observations = CHILD_CASES[arguments.child]()
        except ProbeFailure as exc:
            print(f"{arguments.child}: fixture failure: {exc}", file=sys.stderr)
            report(arguments.child, {}, {"type": "ProbeFailure", "message": str(exc)})
            return 3
        except Exception as exc:  # noqa: BLE001 - report the failure, never hide it
            import traceback

            traceback.print_exc()
            report(arguments.child, {}, {"type": type(exc).__name__, "message": str(exc)})
            return 4
        report(arguments.child, observations)
        print(f"{arguments.child}: {describe(observations)}")
        return 0

    work_dir = Path(tempfile.mkdtemp(prefix="openbot-runtime-continuation-"))
    WORK["dir"] = str(work_dir)
    selected = CASE_ORDER

    print(f"{PINNED_PACKAGE}=={PINNED_VERSION} cross-process pause/resume probe")
    print(f"interpreter: {sys.executable}")
    print(f"work directory: {work_dir}")
    print()

    failures: list[str] = []
    reports: dict[str, dict[str, Any]] = {}
    try:
        for case in selected:
            if case == "continuation-resume":
                # The parent plays the control service between the two segments: it reads the
                # checkpoint's own deferred description, decides the outcomes, and only then lets a
                # fresh process resume.
                envelope = json.loads((work_dir / "continuation" / "envelope.json").read_text())
                control_results = {CALL_READ: CONTROL_READ_RESULT, CALL_WRITE: CONTROL_WRITE_RESULT}
                (work_dir / "continuation" / "control-results.json").write_text(
                    json.dumps(control_results, indent=2, sort_keys=True) + "\n", encoding="utf-8"
                )
                print(
                    f"  control store: resolved {len(envelope['deferred']['calls'])} proposed action(s) "
                    f"for run {envelope['run_id']}: {', '.join(sorted(control_results))}"
                )
            payload = run_child(case, work_dir)
            reports[case] = payload
            observations = payload.get("observations", {})
            case_failures: list[str] = []
            for name, want in EXPECTED.get(case, {}).items():
                got = observations.get(name, "<missing>")
                if got != want:
                    case_failures.append(f"{name}: expected {describe(want)}, observed {describe(got)}")
            if payload.get("error"):
                case_failures.append(f"child error: {describe(payload['error'])}")
            if payload.get("exit_code") != 0:
                case_failures.append(f"child exit code {payload['exit_code']}")
            status = "ok" if not case_failures else "FAIL"
            print(f"[{status}] {case}")
            for failure in case_failures:
                print(f"        {failure}")
                failures.append(f"{case}: {failure}")

        totals = aggregate_ledger(work_dir / "events.jsonl")
        print()
        print("cross-process counters (independent of the per-case reports)")
        for expectation in EXPECTED_TOTALS:
            got = select_count(
                totals,
                expectation["scope"],
                expectation["kind"],
                expectation.get("name"),
            )
            want = expectation["expected"]
            status = "ok" if got == want else "FAIL"
            print(f"[{status}] {expectation['label']}: {got} (expected {want})")
            if got != want:
                failures.append(f"counter '{expectation['label']}': expected {want}, observed {got}")

        first = reports.get("continuation-first", {}).get("observations", {})
        resume = reports.get("continuation-resume", {}).get("observations", {})
        if first and resume:
            recorded = first.get("recorded_usage_requests")
            final = resume.get("final_usage_requests")
            corroboration = {
                "the resumed segment's usage continues the recorded usage": (
                    isinstance(recorded, int) and final == recorded + 1
                ),
                "the final report is the resumed model's output, not a replayed request": (
                    resume.get("output") == FINAL_REPORT
                ),
            }
            print()
            for label, value in corroboration.items():
                status = "ok" if value else "FAIL"
                print(f"[{status}] {label}")
                if not value:
                    failures.append(label)
    finally:
        if arguments.keep:
            print(f"\nkept: {work_dir}")
        else:
            shutil.rmtree(work_dir, ignore_errors=True)

    print()
    if failures:
        print(f"RESULT: {len(failures)} failing check(s)")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"RESULT: all checks passed ({len(selected)} cases)")
    return 0


if __name__ == "__main__":
    # The SDK's serializer warns instead of raising for a near-miss payload; that warning is evidence,
    # but it must not be silently discarded either.
    warnings.simplefilter("default")
    sys.exit(main(sys.argv[1:]))
