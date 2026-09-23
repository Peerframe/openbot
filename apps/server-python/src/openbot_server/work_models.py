"""Shared public work projections; SDK history and engine internals are not client authority."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, JsonValue


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class CreateTask(StrictModel):
    botId: str = Field(min_length=1, max_length=128)
    objective: str = Field(min_length=1, max_length=16384)
    tokenLimit: int = Field(ge=0, le=1_000_000_000)
    requestKey: str = Field(min_length=1, max_length=128)


class DecideAction(StrictModel):
    intentDigest: str = Field(pattern='^[0-9a-f]{64}$')
    approved: bool


class EmptyCommand(StrictModel):
    pass


class WorkUsage(StrictModel):
    tokenLimit: int
    reservedTokens: int
    spentTokens: int


class WorkRun(StrictModel):
    id: str
    ordinal: int
    status: Literal['queued', 'running', 'completed', 'cancelled', 'failed']


class WorkAction(StrictModel):
    id: str
    runId: str
    intent: dict[str, JsonValue]
    intentDigest: str
    decision: Literal['not_required', 'pending', 'approved', 'denied']
    status: Literal['proposed', 'admitted', 'unknown', 'applied', 'not_applied']
    expiresAt: str
    reservedTokens: int
    actualTokens: int | None
    evidence: dict[str, str] | None


class WorkEvent(StrictModel):
    revision: int
    kind: str
    payload: dict[str, JsonValue]


class WorkSnapshot(StrictModel):
    id: str
    botId: str
    objective: str
    status: Literal['queued', 'open', 'completed', 'cancelled', 'failed']
    revision: int
    authorityActive: bool
    cancelRequested: bool
    attention: Literal['approval', 'reconciliation', 'budget'] | None
    usage: WorkUsage
    runs: list[WorkRun]
    actions: list[WorkAction]
    events: list[WorkEvent]
    eventsTruncated: bool
