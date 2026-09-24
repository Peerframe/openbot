"""Shared public work projections; SDK history and engine internals are not client authority."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator

from .work_values import text


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


class RequestReconciliation(StrictModel):
    intentDigest: str = Field(pattern='^[0-9a-f]{64}$')
    requestKey: str = Field(min_length=1, max_length=128)
    expectedSequence: int = Field(ge=0, le=64)
    reason: str = Field(min_length=1, max_length=512)


class RequestCorrection(StrictModel):
    runId: str = Field(min_length=1, max_length=128)
    instruction: str = Field(min_length=1, max_length=4096)
    requestKey: str = Field(min_length=1, max_length=128)
    expectedSequence: int = Field(ge=0, le=8)

    @field_validator('runId', 'requestKey', 'instruction')
    @classmethod
    def bounded_text(cls, value, info):
        return text(value, 4096 if info.field_name == 'instruction' else 128)


class WorkCorrection(StrictModel):
    id: str
    taskId: str
    runId: str
    sequence: int = Field(ge=1, le=8)
    requestedBy: Literal['owner']
    instruction: str = Field(min_length=1, max_length=4096)
    generation: int = Field(ge=1)
    createdAt: str

    @field_validator('instruction')
    @classmethod
    def bounded_instruction(cls, value):
        return text(value, 4096)


class WorkReconciliation(StrictModel):
    id: str
    actionId: str
    sequence: int
    requestedBy: Literal['owner']
    reason: str
    createdAt: str
    delivered: bool
    outcome: Literal['resolved', 'unresolved'] | None


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
    status: Literal['proposed', 'admitted', 'unknown', 'applied', 'not_applied', 'superseded']
    expiresAt: str
    reservedTokens: int
    actualTokens: int | None
    evidence: dict[str, str] | None
    reconciliation: WorkReconciliation | None = None


class WorkEvent(StrictModel):
    revision: int
    kind: str
    payload: dict[str, JsonValue]


class WorkArtifact(StrictModel):
    id: str
    runId: str
    name: str
    mediaType: str
    sha256: str
    sizeBytes: int
    downloadUrl: str


class WorkSnapshot(StrictModel):
    id: str
    botId: str
    objective: str
    status: Literal['queued', 'open', 'completed', 'cancelled', 'failed']
    revision: int
    resultSummary: str | None
    artifacts: list[WorkArtifact]
    authorityActive: bool
    cancelRequested: bool
    attention: Literal['approval', 'reconciliation', 'budget'] | None
    usage: WorkUsage
    runs: list[WorkRun]
    actions: list[WorkAction]
    events: list[WorkEvent]
    eventsTruncated: bool
