"""Public projection for the bounded channel-message reads.

The row already passed authorization and ordering in SQL; this module only reshapes stored columns
into the public ``Message`` payload of ``packages/domain/src/index.ts``. It performs no query, no
ordering, no truncation and no repair: an unreadable row raises instead of being skipped.
"""
from collections.abc import Mapping, Sequence
from typing import Literal

from .models import PublicModel, iso_timestamp

# The read window the TypeScript store selects (``listMessages``: newest 100, reversed). Callers
# are expected to have applied it in SQL; a larger batch is a caller defect, not a larger page.
MAX_PROJECTED_MESSAGES = 100

# Exact snake_case column -> public camelCase key. Only these columns are read, so any other
# column a row happens to carry stays private storage detail instead of becoming public JSON.
_OPTIONAL_COLUMNS = {"author_id": "authorId", "reply_to_message_id": "replyToMessageId",
                     "run_id": "runId"}


class Message(PublicModel):
    """``Message`` in ``packages/domain/src/index.ts``.

    Optional identifiers are ``None`` when the column is null; they are omitted, not serialized as
    ``null``, because every read route builds its response with ``exclude_none=True``.
    """

    id: str
    channelId: str
    authorType: Literal["human", "bot", "system"]
    authorId: str | None = None
    replyToMessageId: str | None = None
    runId: str | None = None
    content: str
    createdAt: str


class MessagesResponse(PublicModel):
    """Body of ``GET /api/v1/channels/{channelId}/messages``."""

    messages: list[Message]


def _project_message(row: Mapping[str, object]) -> Message:
    """Reshape one stored row. Required columns are indexed so a missing one raises ``KeyError``."""
    values: dict[str, object] = {
        "id": row["id"],
        "channelId": row["channel_id"],
        "authorType": row["author_type"],
        "content": row["content"],
        "createdAt": iso_timestamp(row["created_at"]),
    }
    for column, public in _OPTIONAL_COLUMNS.items():
        values[public] = row.get(column)
    return Message(**values)


def project_messages(rows: Sequence[Mapping[str, object]]) -> list[Message]:
    """Project already-authorized, already-ordered rows, preserving their order verbatim."""
    if len(rows) > MAX_PROJECTED_MESSAGES:
        raise ValueError(f"At most {MAX_PROJECTED_MESSAGES} messages may be projected at once.")
    return [_project_message(row) for row in rows]
