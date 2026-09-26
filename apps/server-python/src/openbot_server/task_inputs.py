"""Task submission input compatible with the installed Zod 4.6.2 oracle.

``createMessageInputSchema`` is a non-strict ``z.object``: unknown keys are stripped, and every
optional field distinguishes an absent key from an explicit ``null``. Recipient rules live at two
levels on purpose — the schema rejects a contradictory or duplicated set, and
``task_routing.select_assignees`` re-derives them so a hand-built input cannot bypass them.

The content/UUID adapters are the accepted ones from ``identity_inputs`` rather than a second
normalization implementation. Only the array-length keywords come from ``Field`` instead of Zod's
own message text; the route maps every ``ValidationError`` to one fixed 422 body, so no client sees
a different error shape.
"""
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.json_schema import SkipJsonSchema

from .identity_inputs import _TRIM_NOTE, ChannelBotId, _bounded_text, _omit_default

# ``createMessageInputSchema``: ``botIds: z.array(uuid).min(1).max(6).optional()``.
_RECIPIENTS_MIN = 1
_RECIPIENTS_MAX = 6

MessageContent = _bounded_text(
    1,
    8000,
    required_message="Message is required.",
    description=f"Task text. {_TRIM_NOTE}",
)


class CreateMessageInput(BaseModel):
    """``createMessageInputSchema``: content, one Bot or 1..6 unique Bots, optional reply target."""

    model_config = ConfigDict(extra="ignore", strict=True)

    content: MessageContent
    botId: ChannelBotId | SkipJsonSchema[None] = Field(default=None, json_schema_extra=_omit_default)
    botIds: Annotated[list[ChannelBotId], Field(min_length=_RECIPIENTS_MIN, max_length=_RECIPIENTS_MAX)] \
        | SkipJsonSchema[None] = Field(default=None, json_schema_extra=_omit_default)
    replyToMessageId: ChannelBotId | SkipJsonSchema[None] = Field(default=None, json_schema_extra=_omit_default)

    @field_validator("botId", "botIds", "replyToMessageId", mode="before")
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        """Only an absent key is an omission; ``null`` is a type error for every optional field.

        Zod's ``.optional()`` accepts ``undefined`` and never ``null``. Absent keys never reach a
        field validator, so this runs only when the caller spelled the key out.
        """
        if value is None:
            raise ValueError("Explicit null is not an omission; omit the key instead.")
        return list(value) if isinstance(value, list) else value

    @model_validator(mode="after")
    def _recipients_are_unambiguous(self) -> "CreateMessageInput":
        """The two ``refine`` checks of ``createMessageInputSchema``, in declaration order."""
        if self.botId is not None and self.botIds is not None:
            raise ValueError("Choose botId or botIds, not both.")
        if self.botIds is not None and len(set(self.botIds)) != len(self.botIds):
            raise ValueError("Bot recipients must be unique.")
        return self


def parse_message(value: object) -> CreateMessageInput:
    """Validate a submission payload; raises ``pydantic.ValidationError`` where Zod would fail."""
    return CreateMessageInput.model_validate(value)
