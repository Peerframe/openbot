"""Typed request, result and port contracts for the Python execution unit.

This is an in-process contract, not a wire format. The unit is called by a trusted
Server adapter inside the same process; subprocess framing, envelopes and method
names are deliberately out of scope and will be frozen separately.

What the unit may produce: bounded final text plus the identifiers of corrections
it actually applied. What it must never produce: Run terminal state, published
artifacts, approval decisions, credentials, database handles, usage records owed
to the Server, or any other Server write.
"""

from __future__ import annotations

import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal, Protocol, TypeAlias

from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import ModelResponse

from .errors import FailureReason, RuntimeFailure

# Reviewed Server numbers, kept as ceilings only. The Server remains the primary
# budget authority; these values exist so the unit cannot be handed a looser
# budget than the reviewed one.
MAX_STEPS_CEILING: Final = 8
MAX_TOOL_CALLS_CEILING: Final = 16
MAX_TOOL_RESULT_BYTES_CEILING: Final = 128 * 1024
"""Matches the reviewed `AgentRuntimeToolPolicy.maximumResultBytes` upper bound in
`apps/server/src/agent-runtime.ts` so the two policies cannot disagree."""

MAX_CATALOG_TOOLS_CEILING: Final = 64
MAX_CATALOG_BYTES_CEILING: Final = 64 * 1024
MAX_MESSAGE_BYTES_CEILING: Final = 256 * 1024
MAX_HISTORY_MESSAGES_CEILING: Final = 256
MAX_OUTPUT_BYTES_CEILING: Final = 64 * 1024
MAX_PROGRESS_EVENTS_CEILING: Final = 64
MAX_CORRECTIONS_CEILING: Final = 8
MAX_CORRECTION_BYTES_CEILING: Final = 16 * 1024
MAX_DEADLINE_SECONDS: Final = 3600.0
"""Runtime-local refusal of absurd deadlines. Not a claim about Server time policy."""

MAX_TOOL_NAME_CHARS: Final = 64
MAX_TOOL_DESCRIPTION_BYTES: Final = 4096

ProgressStage: TypeAlias = Literal["planning", "observation"]


@dataclass(frozen=True, slots=True)
class RuntimeLimits:
    """Bounds for one run.

    ``steps`` and ``tool_calls`` are the reviewed Server ceilings. The remaining
    fields are runtime-local shapes: the Server may tighten any of them, and the
    unit refuses any value above its ceiling rather than quietly accepting a
    looser budget.
    """

    steps: int = MAX_STEPS_CEILING
    tool_calls: int = MAX_TOOL_CALLS_CEILING
    catalog_tools: int = 32
    catalog_bytes: int = MAX_CATALOG_BYTES_CEILING
    message_bytes: int = MAX_MESSAGE_BYTES_CEILING
    history_messages: int = 64
    output_bytes: int = 16 * 1024
    tool_result_bytes: int = MAX_TOOL_RESULT_BYTES_CEILING
    progress_events: int = 32
    corrections: int = MAX_CORRECTIONS_CEILING
    correction_bytes: int = MAX_CORRECTION_BYTES_CEILING

    def validated(self) -> RuntimeLimits:
        """Return these limits, or refuse any value outside ``1..ceiling``."""
        ceilings = {
            "steps": MAX_STEPS_CEILING,
            "tool_calls": MAX_TOOL_CALLS_CEILING,
            "catalog_tools": MAX_CATALOG_TOOLS_CEILING,
            "catalog_bytes": MAX_CATALOG_BYTES_CEILING,
            "message_bytes": MAX_MESSAGE_BYTES_CEILING,
            "history_messages": MAX_HISTORY_MESSAGES_CEILING,
            "output_bytes": MAX_OUTPUT_BYTES_CEILING,
            "tool_result_bytes": MAX_TOOL_RESULT_BYTES_CEILING,
            "progress_events": MAX_PROGRESS_EVENTS_CEILING,
            "corrections": MAX_CORRECTIONS_CEILING,
            "correction_bytes": MAX_CORRECTION_BYTES_CEILING,
        }
        for name, ceiling in ceilings.items():
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool):
                raise RuntimeFailure(
                    FailureReason.INVALID_REQUEST, f"limit {name} must be an integer"
                )
            if value < 1 or value > ceiling:
                raise RuntimeFailure(
                    FailureReason.INVALID_REQUEST,
                    f"limit {name}={value} is outside 1..{ceiling}",
                )
        return self


@dataclass(frozen=True, slots=True)
class ToolDescriptor:
    """One Server-declared tool: unique name, description and JSON input schema."""

    name: str
    description: str
    input_schema: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class Correction:
    """A Server-authorised instruction adjustment for this Run.

    Supplied by the caller; the unit holds no durable copy and writes nothing.
    """

    id: str
    instruction: str


@dataclass(frozen=True, slots=True)
class RuntimeRequest:
    """One bounded execution request. All fields are data, never code."""

    instructions: str = ""
    task: str | None = None
    history: Sequence[ModelMessage] | None = None
    tools: Sequence[ToolDescriptor] = ()
    limits: RuntimeLimits = field(default_factory=RuntimeLimits)
    deadline_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class RuntimeResult:
    """What the unit hands back: bounded text and applied correction identifiers.

    Deliberately absent: run status, usage, artifacts, approval outcomes,
    credentials and any Server handle.
    """

    text: str
    applied_correction_ids: tuple[str, ...]
    steps: int
    tool_calls: int


@dataclass(frozen=True, slots=True)
class ModelStepRequest:
    """Payload for one model step. ``messages`` and ``tools`` are bounded copies."""

    step: int
    messages: tuple[ModelMessage, ...]
    tools: tuple[ToolDescriptor, ...]


@dataclass(frozen=True, slots=True)
class ToolCallRequest:
    """Payload for one tool call: name, schema-validated arguments, call identifier.

    ``call_id`` is the SDK call record's identifier, carried for correlation only.
    Its provenance is the model-invocation path: the tool-call entry of the model
    response, or an SDK-generated stand-in when the provider supplies none. It is
    therefore model-invocation data, not a value this unit minted or vouches for, and
    two consequences must not be lost by a host adapter:

    * **It is not authorisation.** Authority is the ``authority`` port, which is
      called with no call data at all and is the only thing that can deny a call. A
      well-formed or freshly chosen identifier grants nothing.
    * **It is not evidence of "exactly once".** The same name and arguments under a
      different identifier are, to this payload, a different call, so the identifier
      must never be used as an idempotency or replay-proof key. A real exactly-once
      guarantee can only be the Server's, at authorisation or at the effect itself.

    ``arguments`` are the ones this unit validated against the declared input schema;
    that is a shape check, not a permission check. The port still applies its own
    authorisation to the effect it performs.
    """

    name: str
    arguments: Mapping[str, Any]
    call_id: str


class ModelStepPort(Protocol):
    """Trusted host adapter. Called once for every SDK model step."""

    def __call__(self, request: ModelStepRequest) -> Awaitable[ModelResponse]: ...


class ToolPort(Protocol):
    """Trusted host adapter. Performs the side effect; the unit has no local effects."""

    def __call__(self, request: ToolCallRequest) -> Awaitable[Any]: ...


class AuthorityPort(Protocol):
    """Mandatory Server guard. Checked before and after every awaited boundary."""

    def __call__(self) -> Awaitable[None]: ...


class CorrectionsPort(Protocol):
    def __call__(self) -> Awaitable[Sequence[Correction]]: ...


class ProgressPort(Protocol):
    """Optional non-durable observer. Never the owner of the task or of its state."""

    def __call__(self, stage: ProgressStage, message: str) -> Awaitable[None]: ...


@dataclass(frozen=True, slots=True)
class RuntimePorts:
    """The host surface. ``authority``, ``model`` and ``tool`` are mandatory."""

    model: ModelStepPort
    tool: ToolPort
    authority: AuthorityPort
    corrections: CorrectionsPort | None = None
    progress: ProgressPort | None = None

    def validated(self) -> RuntimePorts:
        """Fail closed on a missing or non-callable mandatory port."""
        if not callable(self.authority):
            raise RuntimeFailure(
                FailureReason.AUTHORITY_MISSING,
                "an authority port is required; there is no permissive fallback",
            )
        if not callable(self.model):
            raise RuntimeFailure(
                FailureReason.MODEL_PORT_UNAVAILABLE, "a model port is required"
            )
        if not callable(self.tool):
            raise RuntimeFailure(
                FailureReason.TOOL_PORT_UNAVAILABLE, "a tool port is required"
            )
        if self.corrections is not None and not callable(self.corrections):
            raise RuntimeFailure(
                FailureReason.CORRECTION_INVALID, "corrections port must be callable"
            )
        if self.progress is not None and not callable(self.progress):
            raise RuntimeFailure(
                FailureReason.PROGRESS_PORT_ERROR, "progress port must be callable"
            )
        return self


def validate_deadline(deadline_seconds: float | None) -> float | None:
    """Refuse a non-positive, non-finite or absurd deadline."""
    if deadline_seconds is None:
        return None
    if isinstance(deadline_seconds, bool) or not isinstance(deadline_seconds, (int, float)):
        raise RuntimeFailure(FailureReason.INVALID_REQUEST, "deadline must be a number of seconds")
    value = float(deadline_seconds)
    if not math.isfinite(value) or value <= 0.0 or value > MAX_DEADLINE_SECONDS:
        raise RuntimeFailure(
            FailureReason.INVALID_REQUEST,
            f"deadline must be within 0..{MAX_DEADLINE_SECONDS} seconds",
        )
    return value


__all__ = [
    "Correction",
    "CorrectionsPort",
    "AuthorityPort",
    "MAX_CATALOG_BYTES_CEILING",
    "MAX_CATALOG_TOOLS_CEILING",
    "MAX_CORRECTIONS_CEILING",
    "MAX_CORRECTION_BYTES_CEILING",
    "MAX_DEADLINE_SECONDS",
    "MAX_HISTORY_MESSAGES_CEILING",
    "MAX_MESSAGE_BYTES_CEILING",
    "MAX_OUTPUT_BYTES_CEILING",
    "MAX_PROGRESS_EVENTS_CEILING",
    "MAX_STEPS_CEILING",
    "MAX_TOOL_CALLS_CEILING",
    "MAX_TOOL_DESCRIPTION_BYTES",
    "MAX_TOOL_NAME_CHARS",
    "MAX_TOOL_RESULT_BYTES_CEILING",
    "ModelStepPort",
    "ModelStepRequest",
    "ProgressPort",
    "ProgressStage",
    "RuntimeLimits",
    "RuntimePorts",
    "RuntimeRequest",
    "RuntimeResult",
    "ToolCallRequest",
    "ToolDescriptor",
    "ToolPort",
    "validate_deadline",
]
