"""Creation inputs compatible with the installed Zod 4.6.2 oracle.

Trim and code-point limits precede output projection; omission differs from null. Schema limits
refer to normalized text because JSON Schema cannot describe trimming. UUID source attribution
and the complete MIT notice are in this package's THIRD_PARTY_NOTICES.md; the detailed contract
and reuse decision are in docs/research/python-identity-inputs.md.
"""

import re
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, create_model, field_validator

from pydantic.json_schema import SkipJsonSchema

from .models import Bot, BotAppearance

# ECMAScript WhiteSpace + LineTerminator, exactly the characters String.prototype.trim removes.
# TAB 0009, LF 000A, VT 000B, FF 000C, CR 000D, SP 0020, NBSP 00A0, OGHAM 1680, 2000-200A,
# LS 2028, PS 2029, NNBSP 202F, MMSP 205F, IDEO 3000, BOM FEFF.
_ECMASCRIPT_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

# The UUID acceptance set of the installed Zod's z.string().uuid(): RFC 9562 §4.1 layout restricted to
# versions 1-8 and variants 8/9/a/b, plus the Nil (§5.9) and Max (§5.10) literals. The text coincides
# with Zod's own pattern (node_modules/zod/src/v4/core/regexes.ts:33, MIT — Copyright (c) 2025 Colin
# McDonnell, full notice retained in THIRD_PARTY_NOTICES.md); it is not claimed to be independently
# derived. Anchors are part of the string because this single text is used twice: as the JSON Schema
# ``pattern`` keyword, where matching is unanchored, and as a ``fullmatch`` pattern here.
_UUID_PATTERN_TEXT = (
    r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
    r"|0{8}-0{4}-0{4}-0{4}-0{12}"
    r"|f{8}-f{4}-f{4}-f{4}-f{12})$"
)
_UUID_PATTERN = re.compile(_UUID_PATTERN_TEXT)

# Zod checks the entry count on the raw array, before the de-duplicating transform.
_BOT_ID_CAP = 32


def _bounded_text(
    minimum: int,
    maximum: int,
    *,
    description: str,
    required_message: str | None = None,
) -> Any:
    """One Zod ``.trim().min().max()`` chain: validate as Zod does, and describe it in JSON Schema.

    ``minimum``/``maximum`` drive both the validator and the emitted ``minLength``/``maxLength``, since
    ``AfterValidator`` emits no keywords on its own.
    """

    def validate(value: str) -> str:
        trimmed = value.strip(_ECMASCRIPT_WHITESPACE)
        if minimum > 0 and trimmed == "":
            raise ValueError(required_message or f"Too small: expected string to have >={minimum} characters")
        if len(trimmed) > maximum:
            raise ValueError(f"Too big: expected string to have <={maximum} characters")
        return trimmed

    keywords: dict[str, Any] = {"maxLength": maximum}
    if minimum > 0:
        keywords["minLength"] = minimum
    return Annotated[str, Field(description=description, json_schema_extra=keywords), AfterValidator(validate)]


def _uuid(value: str) -> str:
    """Keep the caller's spelling; Zod validates but never normalises case."""
    if _UUID_PATTERN.fullmatch(value) is None:
        raise ValueError("Invalid UUID")
    return value


def _bot_ids(value: list[str]) -> list[str]:
    """Zod checks ``max(32)`` on the raw array, then transforms with ``[...new Set(ids)]``."""
    if len(value) > _BOT_ID_CAP:
        raise ValueError(f"Too big: expected array to have <={_BOT_ID_CAP} items")
    return list(dict.fromkeys(value))


def _appearance_model() -> type[BaseModel]:
    """Build the input appearance model from the published enums, adding Zod's key stripping."""
    return create_model(
        "CreateBotAppearance",
        __module__=__name__,
        __config__=ConfigDict(extra="ignore", strict=True),
        **{name: (field.annotation, ...) for name, field in BotAppearance.model_fields.items()},
    )


CreateBotAppearance = _appearance_model()
ComputerProfile = Bot.model_fields["computerProfile"].annotation

_TRIM_NOTE = "Trimmed with ECMAScript String.prototype.trim, then bounded in Unicode code points."

BotName = _bounded_text(
    1, 64, required_message="Bot name is required.", description=f"Bot name. {_TRIM_NOTE}"
)
BotRole = _bounded_text(
    1, 160, required_message="Bot role is required.", description=f"Bot role. {_TRIM_NOTE}"
)
ChannelName = _bounded_text(
    1, 80, required_message="Channel name is required.", description=f"Channel name. {_TRIM_NOTE}"
)
ChannelDescription = _bounded_text(
    0, 500, description=f"Optional channel description; may trim to empty. {_TRIM_NOTE}"
)
ChannelBotId = Annotated[
    str,
    Field(
        description=(
            "RFC 9562/4122 UUID: version 1-8 and variant 8/9/a/b, plus the Nil and Max literals. "
            "Validated as given; case is never normalised."
        ),
        json_schema_extra={"pattern": _UUID_PATTERN_TEXT},
    ),
    AfterValidator(_uuid),
]


def _omit_default(schema: dict) -> None:
    # None is an internal omission sentinel, not an accepted JSON value or advertised default.
    schema.pop("default", None)


class CreateBotInput(BaseModel):
    """``createBotInputSchema``: name, role, computerProfile (default 'none'), optional appearance."""

    model_config = ConfigDict(extra="ignore", strict=True)

    name: BotName
    role: BotRole
    computerProfile: ComputerProfile = "none"
    appearance: CreateBotAppearance | SkipJsonSchema[None] = Field(default=None, json_schema_extra=_omit_default)

    @field_validator("appearance", mode="before")
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        """Only an absent key is an omission; Zod rejects ``appearance: null``."""
        if value is None:
            raise ValueError("Explicit null is not an omission; omit the key instead.")
        return value


class CreateChannelInput(BaseModel):
    """``createChannelInputSchema``: name, description (default ''), botIds (default [])."""

    model_config = ConfigDict(extra="ignore", strict=True)

    name: ChannelName
    description: ChannelDescription = ""
    botIds: Annotated[list[ChannelBotId], AfterValidator(_bot_ids)] = Field(
        default_factory=list,
        description=(
            "Bots to link. At most 32 entries, counted before de-duplication; duplicates are dropped "
            "case-sensitively in first-occurrence order."
        ),
        json_schema_extra={"maxItems": _BOT_ID_CAP},
    )

    @field_validator("botIds", mode="before")
    @classmethod
    def _fresh_default_list(cls, value: Any) -> Any:
        """Copy the caller's list so no parsed model aliases its input (Zod returns a fresh array)."""
        if value is None:
            raise ValueError("Explicit null is not an omission; omit the key instead.")
        return list(value) if isinstance(value, list) else value


def parse_bot_create(value: object) -> CreateBotInput:
    """Validate a Bot creation payload; raises ``pydantic.ValidationError`` when Zod would fail."""
    return CreateBotInput.model_validate(value)


def parse_channel_create(value: object) -> CreateChannelInput:
    """Validate a channel creation payload; raises ``pydantic.ValidationError`` when Zod would fail."""
    return CreateChannelInput.model_validate(value)
