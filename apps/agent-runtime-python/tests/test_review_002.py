"""Regressions for Codex ``REVIEW_002_EARLY``.

Each test here fixes a reproduced defect or closes a reviewed evidence gap. They are
end-to-end against the pinned SDK with synthetic ports: no network, no provider, no
database, and no paid model. The deadline tests are additionally wrapped in an outer
``asyncio.wait_for`` so that a failure to bound a boundary surfaces as a timeout of
the *test*, not as a silent pass.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic_ai.exceptions import ApprovalRequired, CallDeferred, ModelRetry, ToolFailed
from pydantic_ai.messages import ModelResponse, ToolCallPart

from openbot_agent_runtime import (
    FailureReason,
    RuntimePorts,
    ToolCallRequest,
    ToolCatalog,
    execute_runtime,
)
from openbot_agent_runtime.errors import RuntimeFailure

from support import (
    Authority,
    HangingPort,
    RecordingProgressPort,
    RecordingToolPort,
    ScriptedModelPort,
    SlowPort,
    call,
    descriptor,
    request,
    text,
)

pytestmark = pytest.mark.anyio

OUTER_LIMIT_SECONDS = 5.0
"""A deadline test that hits this has failed to bound the boundary under test."""


def _ports(
    *,
    model: Any,
    tool: Any,
    authority: Any = None,
    corrections: Any = None,
    progress: Any = None,
) -> RuntimePorts:
    return RuntimePorts(
        model=model,
        tool=tool,
        authority=Authority() if authority is None else authority,
        corrections=corrections,
        progress=progress,
    )


async def _run_deadlined(ports: RuntimePorts, *, deadline: float) -> RuntimeFailure:
    """Run under an outer bound, asserting the run's own deadline is what fired."""
    with pytest.raises(RuntimeFailure) as caught:
        await asyncio.wait_for(
            execute_runtime(request(tools=[], deadline_seconds=deadline), ports),
            OUTER_LIMIT_SECONDS,
        )
    return caught.value


# -- defect 1: one absolute monotonic deadline over the whole execution ---------


async def test_a_hanging_initial_authority_check_is_bounded_by_the_deadline() -> None:
    """The entry guard is an awaited boundary and must be inside the deadline."""
    model = ScriptedModelPort([text("never reached")])
    hang = HangingPort()

    failure = await _run_deadlined(
        _ports(model=model, tool=RecordingToolPort(), authority=hang), deadline=0.05
    )

    assert failure.reason is FailureReason.DEADLINE_EXCEEDED
    assert hang.calls == 1
    assert model.requests == []


async def test_a_hanging_corrections_read_is_bounded_by_the_deadline() -> None:
    """The corrections snapshot is an awaited boundary and must be inside the deadline."""
    model = ScriptedModelPort([text("never reached")])
    hang = HangingPort()

    failure = await _run_deadlined(
        _ports(model=model, tool=RecordingToolPort(), corrections=hang), deadline=0.05
    )

    assert failure.reason is FailureReason.DEADLINE_EXCEEDED
    assert hang.calls == 1
    assert model.requests == []


class _HangingOnCall:
    """Authority port that answers normally until a chosen call, then never returns."""

    def __init__(self, nth: int) -> None:
        self._nth = nth
        self.calls = 0

    async def __call__(self) -> None:
        self.calls += 1
        if self.calls >= self._nth:
            await asyncio.Event().wait()


async def test_a_single_step_run_checks_authority_exactly_five_times() -> None:
    """Pins the count that the final-authority deadline test hangs on.

    One entry check, three around the single model step (before progress, after
    progress, after the model port) and one before the result is returned.
    """
    authority = Authority()

    result = await execute_runtime(
        request(tools=[]), _ports(model=ScriptedModelPort([text("ok")]), tool=RecordingToolPort(), authority=authority)
    )

    assert result.text == "ok"
    assert authority.calls == 5


async def test_a_hanging_final_authority_check_is_bounded_by_the_deadline() -> None:
    """The exit guard is an awaited boundary and must be inside the deadline."""
    model = ScriptedModelPort([text("an answer")])
    authority = _HangingOnCall(nth=5)

    failure = await _run_deadlined(
        _ports(model=model, tool=RecordingToolPort(), authority=authority), deadline=0.05
    )

    assert failure.reason is FailureReason.DEADLINE_EXCEEDED
    assert authority.calls == 5, "the hang must land on the final authority check"
    assert model.requests, "the model step must have run before the exit guard"


async def test_the_deadline_covers_preparation_instead_of_being_restarted() -> None:
    """A slow corrections read alone outlasts the deadline.

    If the deadline were armed only around the model run — or restarted after
    preparation — this run would finish successfully, because the model port itself
    is instantaneous. The absolute deadline is what refuses it.
    """
    model = ScriptedModelPort([text("too late")])

    failure = await _run_deadlined(
        _ports(model=model, tool=RecordingToolPort(), corrections=SlowPort(0.3)), deadline=0.1
    )

    assert failure.reason is FailureReason.DEADLINE_EXCEEDED
    assert model.requests == []


# -- defect 2: a revocation during progress must stop the step -------------------


async def test_revocation_during_progress_stops_the_model_call() -> None:
    """Revoking while the progress event is emitted must leave the model call count at 0."""
    model = ScriptedModelPort([text("must not be produced")])
    revoked = {"value": False}
    progress = RecordingProgressPort(on_event=lambda: revoked.__setitem__("value", True))
    authority = Authority(deny_when=lambda: revoked["value"])

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]),
            _ports(model=model, tool=RecordingToolPort(), authority=authority, progress=progress),
        )

    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED
    assert model.requests == [], "the model was asked after authority was withdrawn during progress"
    assert progress.events, "the progress event must actually have been emitted"


# -- defect 3: blank output is refused and accepted text is trimmed --------------


async def test_a_whitespace_only_answer_is_refused() -> None:
    model = ScriptedModelPort([text("   \n\t  ")])

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]), _ports(model=model, tool=RecordingToolPort())
        )

    assert caught.value.reason is FailureReason.OUTPUT_INVALID


async def test_the_answer_is_trimmed_before_it_is_returned() -> None:
    """The Server trims before returning, so the unit does too."""
    model = ScriptedModelPort([text("  Widgets: 42. \n")])

    result = await execute_runtime(
        request(tools=[]), _ports(model=model, tool=RecordingToolPort())
    )

    assert result.text == "Widgets: 42."


# -- reviewed gap: argument validation must never fetch a URI --------------------


def _catalog_with(schema: dict[str, Any]) -> ToolCatalog:
    return ToolCatalog([descriptor("search", schema=schema)], max_tools=8, max_bytes=8192)


_EXTERNAL_REFERENCES = [
    pytest.param({"$ref": "https://example.invalid/schema.json"}, id="https-ref"),
    pytest.param({"$ref": "http://example.invalid/schema.json"}, id="http-ref"),
    pytest.param({"$ref": "file:///etc/hosts"}, id="file-ref"),
    pytest.param(
        {"$dynamicRef": "https://example.invalid/schema.json#anchor"}, id="https-dynamic-ref"
    ),
    pytest.param({"$dynamicRef": "file:///etc/hosts#anchor"}, id="file-dynamic-ref"),
    pytest.param({"$ref": "another-schema.json"}, id="relative-ref"),
    pytest.param({"$ref": "urn:example:schema"}, id="urn-ref"),
]


@pytest.mark.parametrize("reference", _EXTERNAL_REFERENCES)
def test_an_external_schema_reference_is_refused_and_never_resolved(
    reference: dict[str, Any],
) -> None:
    """Offline compilation refuses references before any model or tool work."""
    with pytest.raises(RuntimeFailure) as caught:
        _catalog_with({
            "type": "object",
            "properties": {"x": reference},
            "additionalProperties": False,
        })
    assert caught.value.reason is FailureReason.CATALOG_INVALID


def test_an_existing_local_schema_file_is_not_loaded(tmp_path) -> None:
    schema_file = tmp_path / "external.json"
    schema_file.write_text('{"type":"string"}')
    with pytest.raises(RuntimeFailure) as caught:
        _catalog_with({"type": "object", "properties": {"x": {"$ref": schema_file.as_uri()}}})
    assert caught.value.reason is FailureReason.CATALOG_INVALID


def test_an_internal_schema_reference_still_resolves() -> None:
    """Refusing external fetches must not break self-contained schemas."""
    catalog = _catalog_with(
        {
            "type": "object",
            "$defs": {"name": {"type": "string"}},
            "properties": {"x": {"$ref": "#/$defs/name"}},
            "additionalProperties": False,
        }
    )

    assert catalog.validate_arguments("search", {"x": "a"}) == {"x": "a"}

    with pytest.raises(RuntimeFailure) as caught:
        catalog.validate_arguments("search", {"x": 3})

    assert caught.value.reason is FailureReason.INVALID_ARGUMENTS


# -- reviewed gap: SDK control-flow exceptions must not become observations ------


_SDK_CONTROL_EXCEPTIONS = [
    pytest.param(ToolFailed("the host refused the call"), id="tool-failed"),
    pytest.param(ModelRetry("retry this"), id="model-retry"),
    pytest.param(CallDeferred(), id="call-deferred"),
    pytest.param(ApprovalRequired(), id="approval-required"),
]


@pytest.mark.parametrize("error", _SDK_CONTROL_EXCEPTIONS)
async def test_a_tool_port_raising_an_sdk_control_exception_is_wrapped(error: BaseException) -> None:
    """These are exactly the types the SDK converts into model-visible observations."""
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("recovered")])
    tools = RecordingToolPort(raise_error=error)

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(request(tools=[descriptor()]), _ports(model=model, tool=tools))

    assert caught.value.reason is FailureReason.TOOL_PORT_ERROR
    assert len(model.requests) == 1, "the failure became an observation the model continued past"


@pytest.mark.parametrize("error", _SDK_CONTROL_EXCEPTIONS)
async def test_a_model_port_raising_an_sdk_control_exception_is_wrapped(error: BaseException) -> None:
    model = ScriptedModelPort([text("x")], error=error)

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[]), _ports(model=model, tool=RecordingToolPort())
        )

    assert caught.value.reason is FailureReason.MODEL_PORT_ERROR


# -- reviewed gap: tool_call_unidentified is reachable and fails closed ----------


class _EmptyCallIdModel:
    """Returns a tool call whose identifier the SDK leaves empty."""

    async def __call__(self, step_request: Any) -> ModelResponse:
        return ModelResponse(parts=[ToolCallPart("search", {"query": "a"}, tool_call_id="")])


async def test_a_tool_call_without_an_identifier_is_refused() -> None:
    tools = RecordingToolPort()

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()]),
            _ports(model=_EmptyCallIdModel(), tool=tools),
        )

    assert caught.value.reason is FailureReason.TOOL_CALL_UNIDENTIFIED
    assert tools.calls == []


# -- reviewed item: the SDK call identifier is correlation, not authority or replay --
#
# ``tool_call_id`` has its origin in the model-invocation path: the tool-call entry of
# the model response, or an SDK-generated stand-in when the provider supplies none. It
# is therefore model data, and the three tests below pin that the unit treats it as
# correlation only — it can neither grant authority nor stand in for an exactly-once
# (replay-proof) key. The third test is a deliberate honest-limit disclosure: it
# asserts the guarantee the unit does *not* provide, so the claim cannot drift back in.


class _RecordingAuthority:
    """Authority port that records the exact arguments it was invoked with."""

    def __init__(self) -> None:
        self.observed: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    async def __call__(self, *args: Any, **kwargs: Any) -> None:
        self.observed.append((args, kwargs))


async def test_the_authority_port_never_receives_call_data() -> None:
    """Authority cannot depend on the identifier, because it is never handed one.

    Passing a call identifier (or any call data) to the authority port is what would
    let a caller reason "this identifier was approved, therefore this call is
    authorised". The structural guarantee is that the port is invoked with no
    arguments, asserted here across a run that performs a real tool call.
    """
    authority = _RecordingAuthority()
    model = ScriptedModelPort([call("search", {"query": "a"}, call_id="c1"), text("done")])

    await execute_runtime(
        request(tools=[descriptor()]),
        _ports(model=model, tool=RecordingToolPort(), authority=authority),
    )

    assert authority.observed, "the authority port must have been exercised"
    assert all(
        call_args == () and call_kwargs == {} for call_args, call_kwargs in authority.observed
    ), f"the authority port received call data: {authority.observed}"


class _RevokeAfterFirstCall:
    """Tool port that withdraws authority immediately after its first effect."""

    def __init__(self, revoked: dict[str, bool]) -> None:
        self._revoked = revoked
        self.calls: list[ToolCallRequest] = []

    async def __call__(self, tool_request: ToolCallRequest) -> Any:
        self.calls.append(tool_request)
        self._revoked["value"] = True
        return {"ok": True}


async def test_a_fresh_identifier_cannot_restore_revoked_authority() -> None:
    """A brand-new identifier must not turn a withdrawn scope back into a permission.

    The second call in the response carries an identifier the run has never seen. If
    the unit derived anything from the identifier, its novelty could be mistaken for
    permission. It is not: authority is withdrawn after the first effect and the
    second call is refused before the tool port is reached.
    """
    revoked = {"value": False}
    tools = _RevokeAfterFirstCall(revoked)
    model = ScriptedModelPort(
        [
            [
                call("search", {"query": "a"}, call_id="fresh-1"),
                call("search", {"query": "a"}, call_id="fresh-2"),
            ],
            text("never"),
        ]
    )
    authority = Authority(deny_when=lambda: revoked["value"])

    with pytest.raises(RuntimeFailure) as caught:
        await execute_runtime(
            request(tools=[descriptor()]),
            _ports(model=model, tool=tools, authority=authority),
        )

    assert caught.value.reason is FailureReason.AUTHORITY_REVOKED
    assert [item.call_id for item in tools.calls] == ["fresh-1"], (
        "the second call used a never-seen identifier and was still refused"
    )


async def test_identical_arguments_under_fresh_identifiers_are_not_deduplicated() -> None:
    """Honest limit: the unit provides **no** content-keyed replay protection.

    The same tool with the same arguments, sent twice under different identifiers,
    reaches the tool port twice. This test exists to state that limit: the identifier
    is model data, so it cannot be the basis of an exactly-once claim, and the unit
    does not pretend to be one. Idempotency belongs to the Server's tool authority,
    which observes both calls.
    """
    tools = RecordingToolPort()
    model = ScriptedModelPort(
        [
            call("search", {"query": "same"}, call_id="run-1"),
            call("search", {"query": "same"}, call_id="run-2"),
            text("done"),
        ]
    )

    result = await execute_runtime(
        request(tools=[descriptor()]), _ports(model=model, tool=tools)
    )

    assert result.tool_calls == 2
    assert [item.call_id for item in tools.calls] == ["run-1", "run-2"]
    assert tools.calls[0].name == tools.calls[1].name == "search"
    assert tools.calls[0].arguments == tools.calls[1].arguments == {"query": "same"}
