"""OpenBot bounded Python execution unit.

The unit drives one real ``pydantic-ai`` agent loop through four ports supplied by
a trusted host adapter:

``authority``
    Mandatory Server guard. Awaited before and after every awaited boundary and
    before a result is returned. There is no permissive fallback: a missing port,
    or one that answers synchronously, fails the run closed.
``model``
    Awaited for **every** SDK model step. It receives bounded messages, the tool
    descriptions actually offered and the step index, and returns a
    ``pydantic_ai`` ``ModelResponse``. The Server adapter owns real step authority
    and usage persistence here.
``tool``
    Awaited for each admitted tool call with its name, schema-validated arguments
    and the SDK call identifier. The identifier is correlation data only: it is
    never authority and never an exactly-once (replay-proof) key. The unit performs
    no local effects.
``corrections`` / ``progress``
    Optional. Non-durable: the unit stores nothing and claims no durable state.

The unit returns bounded final text plus the correction identifiers it actually
applied. It never returns or writes Run status, usage, artifacts, approvals,
credentials or database handles — those stay with the Server.

A normal Python process is not an OS sandbox: nothing here isolates files,
network or processes, and the process boundary is not treated as a capability.
"""

from __future__ import annotations

from .catalog import ToolCatalog
from .contracts import (
    AuthorityPort,
    Correction,
    CorrectionsPort,
    ModelStepPort,
    ModelStepRequest,
    ProgressPort,
    ProgressStage,
    RuntimeLimits,
    RuntimePorts,
    RuntimeRequest,
    RuntimeResult,
    ToolCallRequest,
    ToolDescriptor,
    ToolPort,
    validate_deadline,
)
from .errors import SERVER_FAILURE_HINT, FailureReason, RuntimeFailure
from .executor import BoundedExecutor, build_sdk_agent, execute_runtime
from .guard import RunGuard
from .sdk_ports import PORT_MODEL_NAME, PortModel, PortToolset

__all__ = [
    "AuthorityPort",
    "BoundedExecutor",
    "Correction",
    "CorrectionsPort",
    "FailureReason",
    "ModelStepPort",
    "ModelStepRequest",
    "PORT_MODEL_NAME",
    "PortModel",
    "PortToolset",
    "ProgressPort",
    "ProgressStage",
    "RunGuard",
    "RuntimeFailure",
    "RuntimeLimits",
    "RuntimePorts",
    "RuntimeRequest",
    "RuntimeResult",
    "SERVER_FAILURE_HINT",
    "ToolCallRequest",
    "ToolCatalog",
    "ToolDescriptor",
    "ToolPort",
    "build_sdk_agent",
    "execute_runtime",
    "validate_deadline",
]
