"""Run, model-usage and submission projections.

Ported from ``postgres-task-records.ts`` (``toRun``) and ``agent-observations.ts``
(``runModelUsageSchema``). Three behaviours are deliberate rather than accidental:

* ``status``/``execution_profile`` are validated, not cast. Current PostgreSQL CHECK constraints
  already restrict both columns. This adapter additionally rejects malformed in-memory/read-port
  values; the TypeScript projection uses casts. No corrupt-current-database parity is claimed.
* Optional fields reproduce ``toRun`` exactly, including the difference between its ``?.`` and
  truthiness spreads: ``error_code`` is dropped when empty, ``source_message_id`` is kept.
* ``model_usage`` is reported evidence, never a grant or a bill. An unreadable value is omitted
  instead of failing the whole Run, while explicit ``null`` token counts inside a valid usage are
  preserved even though every route dumps with ``exclude_none=True``.
"""
import math
from collections.abc import Mapping, Sequence
from typing import Annotated, Any, Literal

from pydantic import BeforeValidator, Field, ValidationError, model_serializer
from pydantic.functional_serializers import SerializerFunctionWrapHandler

from .message_models import Message
from .models import Bot, PublicModel, iso_timestamp

# ``modelProviderIds`` of ``packages/domain/src/model-providers.ts``, in declaration order.
ModelProviderId = Literal["openai", "anthropic", "gemini", "deepseek", "moonshot", "openrouter",
                          "siliconflow", "dashscope", "zai", "minimax", "ark"]

# ``RunStatus`` of ``packages/domain/src/index.ts``.
RunStatus = Literal["queued", "assigned", "running", "waiting_approval", "blocked", "completed",
                    "failed", "cancelled"]

# ``Bot["computerProfile"]``; the same alias ``task_routing`` derives from the shared Bot contract.
ExecutionProfile = Bot.model_fields["computerProfile"].annotation

# ``runModelUsageSchema``: ``model`` is ``owner[/name]`` made of [A-Za-z0-9._:-] segments.
_MODEL_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9][A-Za-z0-9._:-]*)?$"

# The read window ``listRuns`` selects; a larger batch is a caller defect, not a larger page.
MAX_PROJECTED_RUNS = 50

_TOKEN_CEILING = 1_000_000_000


def _mathematical_integer(value: Any) -> Any:
    """Zod has one number type: ``1.0`` is the integer 1, while ``true`` and ``"1"`` are not numbers.

    ``math.isfinite`` also covers the ``1e400`` literal, which decodes to infinity before any bound
    could reject it.
    """
    if isinstance(value, bool):
        raise ValueError("Boolean is not a counting number")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError("Expected a finite integer")
        return int(value)
    return value


_TokenCount = Annotated[int, Field(ge=0, le=_TOKEN_CEILING), BeforeValidator(_mathematical_integer)]


class RunUsage(PublicModel):
    """``RunModelUsage``: provider-reported counts for the observed steps of one Run.

    ``inputTokens``/``outputTokens`` are required and nullable by contract — ``null`` means at least
    one count was unavailable, which is different from "not reported".
    """

    provider: ModelProviderId = Field(description="Provider that reported these steps.")
    model: Annotated[str, Field(min_length=1, max_length=128, pattern=_MODEL_PATTERN,
                                description="Provider model identifier, optionally owner-qualified.")]
    steps: Annotated[int, Field(ge=1, le=8), BeforeValidator(_mathematical_integer)]
    inputTokens: _TokenCount | None
    outputTokens: _TokenCount | None

    @model_serializer(mode="wrap")
    def _keep_explicit_null_tokens(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        """Re-add ``null`` token counts that an ``exclude_none=True`` dump would have dropped.

        The null is part of the contract ("at least one count was unavailable"), so it must survive
        the same serialization that legitimately omits every other null optional field.
        """
        data = handler(self)
        for name in ("inputTokens", "outputTokens"):
            if getattr(self, name) is None:
                data[name] = None
        return data


class Run(PublicModel):
    """``Run`` in ``packages/domain/src/index.ts``, in declaration order.

    Optional fields are ``None`` when absent and are omitted, not serialized as ``null``, because
    every read route answers with ``exclude_none=True``.
    """

    id: str
    parentRunId: str | None = None
    rootRunId: str | None = None
    delegatedByBotId: str | None = None
    channelId: str
    botId: str
    sourceMessageId: str | None = None
    nodeId: str | None = None
    executionProfile: ExecutionProfile
    instruction: str
    title: str
    status: RunStatus
    resultSummary: str | None = None
    errorMessage: str | None = None
    errorCode: str | None = None
    modelUsage: RunUsage | None = None
    createdAt: str
    updatedAt: str


class RunsResponse(PublicModel):
    """Body of a channel run read: the latest window, in stored order."""

    runs: list[Run]


class SubmitTaskResult(PublicModel):
    """Body of ``POST /api/v1/channels/{channelId}/messages``.

    ``runs`` is present only when the caller named recipients explicitly (``botIds``); a single
    addressed task answers with ``run`` alone.
    """

    message: Message
    run: Run
    runs: list[Run] | None = None


# ``toRun`` spreads some optional columns on truthiness and others on null-ness. Both are reproduced.
_TRUTHY_COLUMNS = {"parent_run_id": "parentRunId", "root_run_id": "rootRunId",
                   "delegated_by_bot_id": "delegatedByBotId", "error_code": "errorCode"}
_PRESENT_COLUMNS = {"source_message_id": "sourceMessageId", "node_id": "nodeId",
                    "result_summary": "resultSummary", "error_message": "errorMessage"}


def project_run(row: Mapping[str, object]) -> Run:
    """Reshape one stored row. Required columns are indexed so a missing one raises ``KeyError``.

    Only whitelisted snake_case columns are read, so any other column a row carries stays storage
    detail instead of becoming public JSON.
    """
    usage = None
    if row.get("model_usage") is not None:
        try:
            usage = RunUsage.model_validate(row.get("model_usage"))
        except ValidationError:
            usage = None
    instruction = row.get("instruction")
    values: dict[str, object] = {
        "id": row["id"],
        "channelId": row["channel_id"],
        "botId": row["bot_id"],
        "executionProfile": row["execution_profile"],
        "instruction": row["title"] if instruction is None else instruction,
        "title": row["title"],
        "status": row["status"],
        "modelUsage": usage,
        "createdAt": iso_timestamp(row["created_at"]),
        "updatedAt": iso_timestamp(row["updated_at"]),
    }
    for column, public in _TRUTHY_COLUMNS.items():
        values[public] = row.get(column) or None
    for column, public in _PRESENT_COLUMNS.items():
        values[public] = row.get(column)
    return Run(**values)


def project_runs(rows: Sequence[Mapping[str, object]]) -> list[Run]:
    """Project already-authorized, already-ordered rows, preserving their order verbatim."""
    if len(rows) > MAX_PROJECTED_RUNS:
        raise ValueError(f"At most {MAX_PROJECTED_RUNS} runs may be projected at once.")
    return [project_run(row) for row in rows]
