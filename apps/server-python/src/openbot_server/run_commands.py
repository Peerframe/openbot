"""The two Owner commands about one Run: a steering instruction and a cancellation.

Both responses confirm a command that was accepted; neither invents lifecycle. Whether a Run may
still be steered or cancelled, whether the caller holds authority, and how the command is stored
belong to the trusted store and the routes. This module answers only what the released Zod schemas
answer:

* ``steerNativeRunInputSchema`` (``packages/protocol/src/index.ts``) and ``steeringInstructionSchema``
  (``apps/server/src/agent-steering.ts``) are the same chain, ``z.string().trim().min(1).max(4000)``,
  wrapped in ``z.object(...).strict()``. One shared alias is used for both the request field and the
  stored payload, so the two cannot drift apart.
* cancellation carries no fields at all: ``z.object({}).strict()``.

Python strings and escaped JSON can contain lone surrogates. The pure parser preserves the Zod
value contract; the trusted command store separately rejects text that cannot be encoded as UTF-8.
"""
from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict

from .identity_inputs import _TRIM_NOTE, _bounded_text
from .models import PublicModel, iso_timestamp
from .task_models import Run


# ``z.string().trim().min(1).max(4000)``. The published ``minLength``/``maxLength`` describe the
# normalized text — JSON Schema cannot express trimming — and are the same numbers the validator
# enforces, which is what ``test_the_published_bounds_are_the_bounds_it_enforces`` pins.
SteeringInstructionText = _bounded_text(
    1,
    4000,
    required_message="An Owner instruction is required.",
    description=f"Owner instruction for the active Run. {_TRIM_NOTE}",
)


class SteerRunInput(BaseModel):
    """``steerNativeRunInputSchema``: the bounded instruction, and no other key."""

    model_config = ConfigDict(extra="forbid", strict=True)

    instruction: SteeringInstructionText


def parse_steering(value: object) -> SteerRunInput:
    """Validate a steering request body; raises ``pydantic.ValidationError`` where Zod would fail."""
    return SteerRunInput.model_validate(value)


class CancelRunInput(BaseModel):
    """``z.object({}).strict()``: a cancellation names nothing, because the path already does."""

    model_config = ConfigDict(extra="forbid", strict=True)


def parse_cancel(value: object) -> CancelRunInput:
    """Validate a cancellation body; raises ``pydantic.ValidationError`` where Zod would fail."""
    return CancelRunInput.model_validate(value)


class _StoredSteeringEvent(BaseModel):
    """The stored ``RUN_STEERING_SUBMITTED`` payload, as the reference reads it back.

    The reference validates it with a *non-strict* ``z.object({instruction})``, so the audit
    ``actor`` written beside the instruction is legal and stripped rather than rejected. The
    instruction is re-checked with the very alias the request used.
    """

    model_config = ConfigDict(extra="ignore", strict=True)

    instruction: SteeringInstructionText


class SteeringInstruction(PublicModel):
    """One accepted Owner correction, in the shape the reference returns it."""

    id: str
    runId: str
    channelId: str
    botId: str
    instruction: str
    createdAt: str


class SteeringResponse(PublicModel):
    """Body of an accepted steering command: the instruction that was recorded."""

    steering: SteeringInstruction


class CancelRunResponse(PublicModel):
    """Body of an accepted cancellation: the Run as it stood when the command was accepted."""

    run: Run


def project_steering(row: Mapping[str, object]) -> SteeringInstruction:
    """Project one stored ``RUN_STEERING_SUBMITTED`` row onto the six public fields.

    The row is re-validated rather than trusted: a payload that is not an object, or one whose
    ``instruction`` is absent or no longer a bounded non-blank string, fails closed. Every extra
    column and every extra payload key stays storage detail instead of becoming public JSON.
    """
    payload = _StoredSteeringEvent.model_validate(row["payload"])
    return SteeringInstruction(
        id=row["id"],
        runId=row["run_id"],
        channelId=row["channel_id"],
        botId=row["bot_id"],
        instruction=payload.instruction,
        createdAt=iso_timestamp(row["created_at"]),
    )
