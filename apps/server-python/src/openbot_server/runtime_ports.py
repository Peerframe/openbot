"""Trusted control ports: no authority-bearing object is serialized to the runtime worker."""
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .execution_values import FAILURE_MESSAGES
from .task_models import ModelProviderId, RunUsage


class RuntimeDenied(Exception):
    """Closed control-layer refusal; raw provider/tool exceptions never become public messages."""
    CODES = frozenset(FAILURE_MESSAGES)

    def __init__(self, code: str):
        if code not in self.CODES:
            raise ValueError("Unknown runtime refusal.")
        self.code = code
        super().__init__("Runtime operation refused.")


@dataclass(slots=True)
class RuntimeBudget:
    steps: int = 0
    tools: int = 0
    web: int = 0
    usage: RunUsage | None = None


@dataclass(frozen=True, slots=True)
class ModelIdentity:
    provider: ModelProviderId
    model: str


@dataclass(frozen=True, slots=True)
class ModelRequest:
    instructions: str
    messages: list[dict]
    tools: list[dict]
    max_output_tokens: int
    max_retries: int = 0
    store_response: bool = False
    telemetry: bool = False


@dataclass(frozen=True, slots=True)
class ModelStep:
    text: str
    tools: list[dict]
    finish_reason: str
    input_tokens: Any = None
    output_tokens: Any = None


@dataclass(frozen=True, slots=True)
class ToolContext:
    call_id: str
    messages: list[dict]


@dataclass(frozen=True, slots=True)
class RuntimeTool:
    name: str
    description: str
    input_schema: dict
    validate: Callable[[dict], Awaitable[dict]]
    execute: Callable[[dict, ToolContext], Awaitable[Any]]
    web: bool
    maximum_result_bytes: int


@dataclass(frozen=True, slots=True)
class RuntimePorts:
    """Trusted, bounded callbacks that cooperate with cancellation.

    Effect adapters still own transactional authority/approval at dispatch. Host checks before and
    after awaiting a callback cannot undo an external effect or make that effect atomic.
    """
    identity: ModelIdentity
    generate: Callable[[ModelRequest, Callable[[str], Awaitable[None]]], Awaitable[ModelStep]]
    assert_active: Callable[[], Awaitable[None]]
    corrections: Callable[[], Awaitable[list[dict]]]
    save_usage: Callable[[RunUsage], Awaitable[None]]
    progress: Callable[[str, str], Awaitable[None]]
    tools: tuple[RuntimeTool, ...] = ()
    output: Callable[[str, bool], None] | None = None
