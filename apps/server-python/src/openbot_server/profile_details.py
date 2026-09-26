"""Optimistic Owner edits of the descriptive Employee profile fields.

Only ``role`` and ``description`` are editable, and every write must name the revision it expects, so
an edit that lost the race is rejected by the ``profile_revision`` predicate instead of an in-process
lock. The Bot row lock, the compare-and-set ``UPDATE``, the evolution row and the
``EMPLOYEE_PROFILE_UPDATED`` run event all commit together: the shared
:class:`~openbot_server.authority.OwnerTransactions` context owns session validation, expiry and
commit/rollback, and a projection or audit failure rolls the profile back with it.

Out of scope here: the aggregate profile read (skills/memory/records), realtime invalidation, retries,
model dispatch and any HTTP status mapping.
"""
import math
from typing import Annotated, Any, Literal
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from .authority import OwnerTransactions
from .database import StoreUnavailable
from .identity_inputs import _bounded_text
from .models import Bot, PublicModel, iso_timestamp, project_bot

_STORAGE_UNAVAILABLE = "profile_storage_unavailable"
_CONFLICT = ("The Employee profile changed while it was being edited. "
             "Reload and review the current values.")
# Zod's z.number().int() is Number.isSafeInteger, so the ceiling is 2**53 - 1.
_MAX_SAFE_INTEGER = 2**53 - 1
_TRIM_NOTE = "Trimmed with ECMAScript String.prototype.trim, then bounded in Unicode code points."

# Same shared text helper as the creation inputs: one whitespace set, one trimming rule.
ProfileRole = _bounded_text(1, 160, required_message="Employee role is required.",
                            description=f"Employee role. {_TRIM_NOTE}")
ProfileDescription = _bounded_text(0, 2000,
                                   description=f"Employee description; required but may trim to empty. {_TRIM_NOTE}")


def _mathematical_integer(value: Any) -> Any:
    """Zod has one number type, so the JSON token ``1.0`` is the integer 1 for this field."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Expected a mathematical integer.")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("Expected a mathematical integer.")
        return int(value)
    return value


ExpectedRevision = Annotated[
    int,
    # ``Field`` must precede the validator: after one, pydantic dumps the bounds verbatim as
    # ``ge``/``le`` instead of emitting the ``minimum``/``maximum`` JSON Schema keywords.
    Field(ge=1, le=_MAX_SAFE_INTEGER,
          description="Revision the caller last read; rejected if the profile moved on."),
    BeforeValidator(_mathematical_integer),
]


class ProfileDetailsInput(BaseModel):
    """``updateEmployeeProfileDetailsInputSchema``: role, description, expectedRevision, strict."""

    model_config = ConfigDict(extra="forbid", strict=True)

    role: ProfileRole
    description: ProfileDescription
    expectedRevision: ExpectedRevision


def parse_profile_details(value: object) -> ProfileDetailsInput:
    """Validate an edit payload; raises ``pydantic.ValidationError`` where Zod would fail."""
    return ProfileDetailsInput.model_validate(value)


class ProfileNotFound(Exception):
    """The Bot does not exist; the message is fixed and deliberately generic."""


class ProfileConflict(Exception):
    """``expectedRevision`` is no longer current, so the caller must reload before editing."""


class ProfileUnchanged(Exception):
    """Neither editable field differs from the stored value."""


class ProfileDetails(PublicModel):
    description: str
    revision: int
    updatedAt: str


class ProfileEvolution(PublicModel):
    """``EmployeeEvolutionEvent`` for a manual edit: always ``evidence: []`` and no ``sourceId``."""

    id: str
    botId: str
    type: Literal["role_changed", "configuration_changed"]
    title: str
    summary: str
    source: Literal["manual"]
    evidence: list[dict] = Field(default_factory=list, max_length=0)
    createdAt: str


class ProfileMutationResult(PublicModel):
    employee: Bot
    details: ProfileDetails
    evolution: ProfileEvolution


class PostgresProfileStore:
    """One transaction per edit: lock, compare, update, then write both audit rows."""

    def __init__(self, dsn: str):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-profile")

    async def verify_schema(self) -> None:
        await self._transactions.verify_schema()

    async def update(self, token: str | None, bot_id: str,
                     value: ProfileDetailsInput) -> ProfileMutationResult:
        try:
            async with self._transactions.transaction(token) as connection:
                cursor = await connection.execute(
                    "SELECT role, description, profile_revision FROM bots WHERE id=%s FOR UPDATE",
                    (bot_id,))
                current = await cursor.fetchone()
                if current is None:
                    raise ProfileNotFound("Bot not found.")
                if current["profile_revision"] != value.expectedRevision:
                    raise ProfileConflict(_CONFLICT)
                changed = [field for field, stored in (("role", current["role"]),
                                                       ("description", current["description"]))
                           if stored != getattr(value, field)]
                if not changed:
                    raise ProfileUnchanged("At least one Employee profile field must change.")
                cursor = await connection.execute(
                    "UPDATE bots SET role=%s, description=%s, profile_revision=profile_revision+1, "
                    "updated_at=date_trunc('milliseconds', statement_timestamp()) "
                    "WHERE id=%s AND profile_revision=%s RETURNING *",
                    (value.role, value.description, bot_id, value.expectedRevision))
                updated = await cursor.fetchone()
                if updated is None:
                    # The row lock already serialized this edit; a lost row is still a conflict.
                    raise ProfileConflict(_CONFLICT)
                revision = updated["profile_revision"]
                # One timestamp for the profile and both audit rows, exactly as TS reuses ``now``.
                updated_at = updated["updated_at"]
                role_changed = "role" in changed
                cursor = await connection.execute(
                    "INSERT INTO employee_evolution_events "
                    "(id, bot_id, type, title, summary, source, evidence, created_at) "
                    "VALUES (%s, %s, %s, %s, %s, 'manual', '[]'::jsonb, %s) RETURNING *",
                    (str(uuid4()), bot_id,
                     "role_changed" if role_changed else "configuration_changed",
                     "Employee role updated" if role_changed else "Profile updated",
                     f"Owner updated: {', '.join(changed)}.", updated_at))
                evolution = await cursor.fetchone()
                if evolution is None:
                    raise StoreUnavailable(_STORAGE_UNAVAILABLE)
                await connection.execute(
                    "INSERT INTO run_events (id, bot_id, type, payload, created_at) "
                    "VALUES (%s, %s, 'EMPLOYEE_PROFILE_UPDATED', %s, %s)",
                    (str(uuid4()), bot_id, Jsonb({"changedFields": changed, "revision": revision}),
                     updated_at))
                return ProfileMutationResult(
                    employee=project_bot(updated),
                    details=ProfileDetails(description=updated["description"], revision=revision,
                                           updatedAt=iso_timestamp(updated_at)),
                    evolution=ProfileEvolution(
                        id=evolution["id"], botId=evolution["bot_id"], type=evolution["type"],
                        title=evolution["title"], summary=evolution["summary"],
                        source=evolution["source"], evidence=evolution["evidence"],
                        createdAt=iso_timestamp(evolution["created_at"])),
                )
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            # Projection failures are storage failures; business and authority errors pass through.
            raise StoreUnavailable(_STORAGE_UNAVAILABLE) from None
