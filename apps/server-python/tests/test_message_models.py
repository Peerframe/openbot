"""Focused tests for the public message projection in ``openbot_server.message_models``.

The expected payloads follow ``Message`` in ``packages/domain/src/index.ts`` and ``toMessage`` in
``apps/server/src/postgres-task-records.ts``: optional identifiers are omitted rather than null, and
``createdAt`` is an ISO string. Every assertion is made on the serialized public payload
(``model_dump(mode="json", exclude_none=True)``).

These tests say nothing about SQL, ordering, the 100-row window being *selected* correctly,
authorization, the 4 MiB body bound or HTTP; the projection receives rows that are already
authorized, already ordered and already bounded. They also do not compare against the running
TypeScript code.
"""
import copy
import json
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from openbot_server import message_models

MESSAGE_PUBLIC_FIELDS = {"id", "channelId", "authorType", "authorId", "replyToMessageId", "runId",
                         "content", "createdAt"}
OPTIONAL_PUBLIC_FIELDS = {"authorId", "replyToMessageId", "runId"}
MESSAGE_REQUIRED_FIELDS = MESSAGE_PUBLIC_FIELDS - OPTIONAL_PUBLIC_FIELDS
MANDATORY_COLUMNS = ("id", "channel_id", "author_type", "content", "created_at")
OPTIONAL_COLUMNS = {"author_id": "authorId", "reply_to_message_id": "replyToMessageId",
                    "run_id": "runId"}
MESSAGE_DB_COLUMNS = (*MANDATORY_COLUMNS, *OPTIONAL_COLUMNS)


def public_json(messages):
    """The exact body the read route hands to the client."""
    return message_models.MessagesResponse(messages=messages).model_dump(mode="json",
                                                                        exclude_none=True)


def message_row(**overrides):
    """A ``messages`` row as a snake_case PostgreSQL mapping."""
    row = {
        "id": "msg-1",
        "channel_id": "chan-1",
        "author_type": "human",
        "author_id": "owner",
        "reply_to_message_id": None,
        "run_id": None,
        "content": "巡检完成 ✅",
        "created_at": datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=timezone.utc),
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# The projected payload
# ---------------------------------------------------------------------------


def test_projects_every_field_for_every_author_type_with_unicode_and_utc_millis():
    """All three stored author types, non-UTC input, sub-millisecond truncation, unicode content."""
    for author_type in ("human", "bot", "system"):
        rows = [message_row(author_type=author_type, author_id=f"author-{author_type}",
                            reply_to_message_id="msg-0", run_id="run-7",
                            content="emoji 😀 astral 𠮷 \"quoted\"\nline",
                            created_at=datetime(2026, 1, 2, 11, 4, 5, 999999,
                                                tzinfo=timezone(timedelta(hours=8))))]
        expected = {"id": "msg-1", "channelId": "chan-1", "authorType": author_type,
                    "authorId": f"author-{author_type}", "replyToMessageId": "msg-0",
                    "runId": "run-7", "content": "emoji 😀 astral 𠮷 \"quoted\"\nline",
                    "createdAt": "2026-01-02T03:04:05.999Z"}
        payload = public_json(message_models.project_messages(rows))
        assert payload == {"messages": [expected]}, author_type
        assert json.loads(json.dumps(payload, ensure_ascii=False))["messages"][0] == expected


def test_public_field_set_is_exactly_the_domain_message_contract():
    """A field added to the model would silently widen the public API, so pin the sets."""
    fields = message_models.Message.model_fields
    assert set(fields) == MESSAGE_PUBLIC_FIELDS
    assert {name for name, field in fields.items() if field.is_required()} == MESSAGE_REQUIRED_FIELDS
    assert list(fields) == ["id", "channelId", "authorType", "authorId", "replyToMessageId",
                            "runId", "content", "createdAt"]
    assert set(message_models.MessagesResponse.model_fields) == {"messages"}
    assert message_models.MAX_PROJECTED_MESSAGES == 100


def test_empty_rows_project_to_an_empty_envelope():
    assert public_json(message_models.project_messages([])) == {"messages": []}


# ---------------------------------------------------------------------------
# Optional identifiers
# ---------------------------------------------------------------------------


def test_null_optional_ids_are_omitted_and_never_serialized_as_null():
    """A null column and an absent column mean the same thing, exactly as in ``toMessage``."""
    present_null = message_row(author_id=None, reply_to_message_id=None, run_id=None)
    absent = {column: value for column, value in present_null.items() if column not in OPTIONAL_COLUMNS}
    for label, row in (("explicit null", present_null), ("column absent", absent)):
        payload = public_json(message_models.project_messages([row]))
        assert set(payload["messages"][0]) == MESSAGE_REQUIRED_FIELDS, label
        assert payload["messages"][0]["content"] == "巡检完成 ✅", label
        assert "null" not in json.dumps(payload), label


def test_each_optional_id_is_carried_through_when_present():
    for column, public in OPTIONAL_COLUMNS.items():
        row = message_row(**{name: None for name in OPTIONAL_COLUMNS})
        row[column] = f"value-of-{column}"
        payload = public_json(message_models.project_messages([row]))["messages"][0]
        assert payload[public] == f"value-of-{column}", column
        assert set(payload) == MESSAGE_REQUIRED_FIELDS | {public}, column


# ---------------------------------------------------------------------------
# Column whitelist, strict typing and corruption
# ---------------------------------------------------------------------------


def test_unknown_private_columns_never_reach_the_public_payload():
    row = message_row(author_id=None)
    row.update({"internal_note": "secret", "tenant_id": 7, "embedding": [0.1], "deleted_at": None})
    payload = public_json(message_models.project_messages([row]))["messages"][0]
    assert set(payload) == MESSAGE_REQUIRED_FIELDS
    assert "secret" not in json.dumps(payload)


def test_stored_values_are_never_coerced_replaced_or_repaired():
    """Wrong column types and corrupt timestamps raise instead of being coerced or defaulted."""
    wrongly_typed = [
        ("author_type unknown literal", {"author_type": "robot"}),
        ("author_type integer", {"author_type": 1}),
        ("author_type bool", {"author_type": True}),
        ("id integer", {"id": 3}),
        ("channel_id null", {"channel_id": None}),
        ("content integer", {"content": 5}),
        ("content null", {"content": None}),
        ("author_id integer", {"author_id": 9}),
        ("reply_to_message_id integer", {"reply_to_message_id": 2}),
        ("run_id array", {"run_id": ["run-1"]}),
    ]
    for label, override in wrongly_typed:
        try:
            message_models.project_messages([message_row(**override)])
        except ValidationError:
            continue
        pytest.fail(f"{label} was accepted instead of raising ValidationError")

    # ``(row.createdAt ?? new Date())`` in TS would fabricate a time here; this fails closed.
    corrupt_timestamps = [
        ("naive datetime", datetime(2026, 1, 2, 3, 4, 5)),
        ("ISO string", "2026-01-02T03:04:05.000Z"),
        ("null", None),
        ("epoch integer", 1767323045),
    ]
    for label, created_at in corrupt_timestamps:
        try:
            message_models.project_messages([message_row(created_at=created_at)])
        except ValueError:
            continue
        pytest.fail(f"{label} createdAt was accepted instead of raising")


def test_a_missing_mandatory_column_raises_instead_of_skipping_the_record():
    for column in MANDATORY_COLUMNS:
        row = {name: value for name, value in message_row().items() if name != column}
        try:
            message_models.project_messages([row])
        except (KeyError, ValueError):
            continue
        pytest.fail(f"missing column {column} was accepted instead of raising")


def test_one_corrupt_row_fails_the_whole_batch_instead_of_being_dropped():
    rows = [message_row(id="ok-1"), message_row(id="ok-2", author_type="robot"),
            message_row(id="ok-3")]
    with pytest.raises(ValidationError):
        message_models.project_messages(rows)


# ---------------------------------------------------------------------------
# Order, non-mutation and the batch bound
# ---------------------------------------------------------------------------


def test_input_order_is_preserved_even_when_timestamps_are_out_of_order():
    """Ordering belongs to SQL; the projection must not re-sort or reverse what it is given."""
    created_at = message_row()["created_at"]
    rows = [message_row(id=f"m{index}", created_at=created_at - timedelta(minutes=index))
            for index in range(5)]
    rows.reverse()
    expected = ["m4", "m3", "m2", "m1", "m0"]
    assert [message.id for message in message_models.project_messages(rows)] == expected
    assert [item["id"] for item in public_json(message_models.project_messages(rows))["messages"]] == expected


def test_long_content_is_preserved_verbatim_and_rows_are_not_mutated():
    content = "字" * 20000 + "😀"
    rows = [message_row(id="long", content=content)]
    snapshot = copy.deepcopy(rows)
    messages = message_models.project_messages(rows)
    assert messages[0].content == content
    assert len(messages[0].content) == len(content)
    assert rows == snapshot
    assert set(rows[0]) == set(MESSAGE_DB_COLUMNS)


def test_exactly_one_hundred_rows_are_projected_and_one_hundred_and_one_raise():
    rows = [message_row(id=f"m{index}") for index in range(100)]
    assert len(message_models.project_messages(rows)) == 100
    with pytest.raises(ValueError, match="At most 100 messages"):
        message_models.project_messages(rows + [message_row(id="m100")])
