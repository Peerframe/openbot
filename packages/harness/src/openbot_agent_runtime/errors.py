"""Closed failure vocabulary for the bounded Python execution unit.

Authority note: the Server owns Run terminal state and the user-visible failure
codes (``NativeFailureCode`` in ``apps/server/src/agent-observations.ts``). This
module carries runtime-local reasons only. ``SERVER_FAILURE_HINT`` is advisory
input for the Server adapter, which remains the only writer of Run state; nothing
in this package persists, publishes or reports a Run status.
"""

from __future__ import annotations

from enum import Enum
from typing import Final

MAX_DETAIL_CHARS: Final = 512
"""Failure details are diagnostic strings, never payloads, so they are truncated."""


class FailureReason(str, Enum):
    """Why the unit refused to continue. Reasons are runtime-local, not Run states."""

    # Authority port: the Server guard that decides whether this exact Run may proceed.
    AUTHORITY_MISSING = "authority_missing"
    AUTHORITY_INVALID = "authority_invalid"
    AUTHORITY_REVOKED = "authority_revoked"

    # Request / catalog shape.
    INVALID_REQUEST = "invalid_request"
    CATALOG_INVALID = "catalog_invalid"
    CATALOG_LIMIT = "catalog_limit"
    MESSAGE_LIMIT = "message_limit"

    # Secondary ceilings (the Server is the primary budget authority).
    STEP_LIMIT = "step_limit"
    TOOL_CALL_LIMIT = "tool_call_limit"
    LIMIT_EXCEEDED = "limit_exceeded"

    # Tool call admission.
    UNKNOWN_TOOL = "unknown_tool"
    INVALID_ARGUMENTS = "invalid_arguments"
    DUPLICATE_TOOL_CALL = "duplicate_tool_call"
    TOOL_CALL_UNIDENTIFIED = "tool_call_unidentified"

    # Tool result and final output shape.
    TOOL_RESULT_INVALID = "tool_result_invalid"
    TOOL_RESULT_LIMIT = "tool_result_limit"
    OUTPUT_INVALID = "output_invalid"
    OUTPUT_LIMIT = "output_limit"

    # Host ports.
    MODEL_PORT_UNAVAILABLE = "model_port_unavailable"
    MODEL_PORT_ERROR = "model_port_error"
    MODEL_RESPONSE_INVALID = "model_response_invalid"
    TOOL_PORT_UNAVAILABLE = "tool_port_unavailable"
    TOOL_PORT_ERROR = "tool_port_error"
    PROGRESS_PORT_ERROR = "progress_port_error"
    CORRECTION_INVALID = "correction_invalid"

    # Lifecycle.
    DEADLINE_EXCEEDED = "deadline_exceeded"
    CANCELLED = "cancelled"
    LATE_RESULT = "late_result"
    UNEXPECTED = "unexpected"

    # Process profile: a defensive invariant of the sequential child-request
    # channel. The profile allows at most one outstanding child request, and the
    # worker refuses rather than interleaves if two ever overlap.
    OVERLAPPING_OPERATION = "overlapping_operation"


SERVER_FAILURE_HINT: Final[dict[FailureReason, str]] = {
    FailureReason.AUTHORITY_MISSING: "invalid_target",
    FailureReason.AUTHORITY_INVALID: "invalid_target",
    FailureReason.AUTHORITY_REVOKED: "scope_revoked",
    FailureReason.INVALID_REQUEST: "invalid_target",
    FailureReason.CATALOG_INVALID: "invalid_target",
    FailureReason.CATALOG_LIMIT: "task_limit",
    FailureReason.MESSAGE_LIMIT: "task_limit",
    FailureReason.STEP_LIMIT: "task_limit",
    FailureReason.TOOL_CALL_LIMIT: "task_limit",
    FailureReason.LIMIT_EXCEEDED: "task_limit",
    FailureReason.UNKNOWN_TOOL: "tool_unavailable",
    FailureReason.INVALID_ARGUMENTS: "tool_unavailable",
    FailureReason.DUPLICATE_TOOL_CALL: "tool_unavailable",
    FailureReason.TOOL_CALL_UNIDENTIFIED: "tool_unavailable",
    FailureReason.TOOL_RESULT_INVALID: "tool_unavailable",
    FailureReason.TOOL_RESULT_LIMIT: "tool_unavailable",
    FailureReason.OUTPUT_INVALID: "execution_failed",
    FailureReason.OUTPUT_LIMIT: "task_limit",
    FailureReason.MODEL_PORT_UNAVAILABLE: "model_unavailable",
    FailureReason.MODEL_PORT_ERROR: "model_unavailable",
    FailureReason.MODEL_RESPONSE_INVALID: "model_unavailable",
    FailureReason.TOOL_PORT_UNAVAILABLE: "tool_unavailable",
    FailureReason.TOOL_PORT_ERROR: "tool_unavailable",
    FailureReason.PROGRESS_PORT_ERROR: "plugin_unavailable",
    FailureReason.CORRECTION_INVALID: "execution_failed",
    FailureReason.DEADLINE_EXCEEDED: "task_timeout",
    FailureReason.CANCELLED: "server_interrupted",
    FailureReason.LATE_RESULT: "server_interrupted",
    FailureReason.UNEXPECTED: "execution_failed",
    FailureReason.OVERLAPPING_OPERATION: "execution_failed",
}
"""Advisory mapping from a runtime reason to a Server ``NativeFailureCode``.

The Server adapter decides the final code; this table exists so the adapter does
not have to reverse-engineer intent. It is not consulted by the runtime and never
appears in a result payload.
"""


class RuntimeFailure(Exception):
    """A refusal to continue. Never a Run status, approval or artifact decision."""

    def __init__(self, reason: FailureReason, detail: str = "") -> None:
        self.reason = reason
        self.detail = detail[:MAX_DETAIL_CHARS]
        super().__init__(f"{reason.value}: {self.detail}" if self.detail else reason.value)
