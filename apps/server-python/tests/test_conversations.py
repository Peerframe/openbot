"""Focused regression tests for the direct-conversation and member-join adapter.

The adapter is exercised against a fake authority context and a recording connection, so these cases
prove the SQL parameters, the statement sequence and the returned projection. They deliberately claim
nothing about real row locks, real commits or real rollback: those are Root's database and HTTP
acceptance. No loopback server, no database and no environment fixture is used here.
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import UUID

import psycopg
import pytest
from pydantic import ValidationError

from openbot_server import conversations, identity_inputs
from openbot_server.authority import AuthenticationRequired, OwnerTransactions
from openbot_server.database import StoreUnavailable

BOT_ID = "1f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
OTHER_BOT_ID = "2f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
NIL_ID = "00000000-0000-0000-0000-000000000000"
CHANNEL_ID = "9c1d6f2a-7b44-4a3e-8d21-5f0e7c9b1a33"
TOKEN = "t" * 43
CREATED = datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=timezone.utc)
EARLIER = datetime(2025, 12, 31, 23, 59, 59, 999999, tzinfo=timezone.utc)
DSN = "postgresql://owner@127.0.0.1:1/openbot_control"


class FakeCursor:
    def __init__(self, rows):
        self._rows = list(rows)

    async def fetchone(self):
        return self._rows.pop(0) if self._rows else None

    async def fetchall(self):
        rows, self._rows = self._rows, []
        return rows


class FakeConnection:
    """Records every statement and replays one queued result set per execution."""

    def __init__(self, *results):
        self.statements = []
        self._results = list(results)

    async def execute(self, sql, params=None):
        self.statements.append((sql, params))
        return FakeCursor(self._results.pop(0))


class FakeTransactions:
    def __init__(self, connection):
        self.connection = connection
        self.tokens = []
        self.schema_checked = False

    @asynccontextmanager
    async def transaction(self, token):
        self.tokens.append(token)
        yield self.connection

    async def verify_schema(self):
        self.schema_checked = True


def store_for(connection):
    transactions = FakeTransactions(connection)
    store = conversations.PostgresConversationStore(DSN)
    store._transactions = transactions
    return store, transactions


def read_rows(*bot_ids, channel_id=CHANNEL_ID, name="Round Bot", description="", direct_bot_id=None,
              created_at=CREATED):
    return [{"id": channel_id, "name": name, "description": description, "direct_bot_id": direct_bot_id,
             "created_at": created_at, "bot_id": bot_id} for bot_id in bot_ids]


def run(coroutine):
    return asyncio.run(coroutine)


def inserted(connection):
    return [(sql, params) for sql, params in connection.statements if sql.startswith("INSERT")]


def events(connection):
    return [(sql, params) for sql, params in connection.statements if "run_events" in sql]


# ---------------------------------------------------------------------------
# The join input reuses the accepted public alias
# ---------------------------------------------------------------------------


def test_the_join_input_reuses_the_public_channel_bot_id_alias():
    schema = conversations.JoinChannelInput.model_json_schema()
    assert schema["required"] == ["botId"]
    assert set(conversations.JoinChannelInput.model_fields) == {"botId"}
    # The alias's own constraint and description, not a re-written copy of them.
    assert schema["properties"]["botId"]["pattern"] == identity_inputs._UUID_PATTERN_TEXT
    assert "RFC 9562/4122 UUID" in schema["properties"]["botId"]["description"]
    assert conversations.parse_join({"botId": BOT_ID, "extra": 1}).botId == BOT_ID
    assert conversations.JoinChannelInput.model_config["extra"] == "ignore"


def test_the_join_input_rejects_null_missing_and_non_uuid_values():
    for value in (BOT_ID.upper(), NIL_ID, "1f8b0f1e-5e3d-8f8a-9c2b-7d6e5f4a3b2c"):
        assert conversations.parse_join({"botId": value}).botId == value
    for value in ({}, {"botId": None}, {"botId": "nope"}, {"botId": 5}, {"botId": [BOT_ID]},
                  {"botId": BOT_ID[:-1]}, "nope", 5, None, [BOT_ID]):
        with pytest.raises(ValidationError):
            conversations.parse_join(value)


# ---------------------------------------------------------------------------
# direct: the singleton conversation
# ---------------------------------------------------------------------------


def test_direct_creates_the_singleton_with_its_exact_statements():
    connection = FakeConnection(
        [{"id": BOT_ID, "name": "Round Bot"}],  # bots FOR UPDATE
        [],                                     # no direct row yet
        [{"created_at": CREATED}],              # channels INSERT RETURNING
        [],                                     # channel_bots INSERT
        [],                                     # CHANNEL_CREATED
        [],                                     # BOT_JOINED_CHANNEL
        read_rows(BOT_ID, direct_bot_id=BOT_ID),
    )
    store, transactions = store_for(connection)
    channel = run(store.direct(TOKEN, BOT_ID))

    assert transactions.tokens == [TOKEN]
    assert len(connection.statements) == 7
    lock_sql, lock_params = connection.statements[0]
    assert "FROM bots" in lock_sql and lock_sql.endswith("FOR UPDATE")
    assert lock_params == (BOT_ID,)
    assert connection.statements[1][1] == (BOT_ID,)

    insert_sql, insert_params = connection.statements[2]
    assert "direct_bot_id" in insert_sql and "''" in insert_sql
    channel_id, name, direct_bot_id = insert_params
    assert UUID(channel_id).version == 4
    assert (name, direct_bot_id) == ("Round Bot", BOT_ID)

    membership_sql, membership_params = connection.statements[3]
    assert "channel_bots" in membership_sql
    assert membership_params == (channel_id, BOT_ID, CREATED)

    created_sql, created_params = connection.statements[4]
    assert "CHANNEL_CREATED" in created_sql
    assert created_params[1] == channel_id and created_params[0] != channel_id
    assert created_params[2].obj == {"name": "Round Bot", "directBotId": BOT_ID}

    joined_sql, joined_params = connection.statements[5]
    assert "BOT_JOINED_CHANNEL" in joined_sql and "'{}'::jsonb" in joined_sql
    assert joined_params[1:] == (channel_id, BOT_ID)

    assert channel.model_dump(mode="json", exclude_none=True) == {
        "id": CHANNEL_ID, "name": "Round Bot", "description": "", "botIds": [BOT_ID],
        "directBotId": BOT_ID, "createdAt": "2026-01-02T03:04:05.123Z"}


def test_direct_returns_the_existing_identity_without_writing():
    connection = FakeConnection(
        [{"id": BOT_ID, "name": "Renamed Bot"}],  # the Bot was renamed after the conversation existed
        [{"id": CHANNEL_ID}],
        read_rows(BOT_ID, direct_bot_id=BOT_ID, name="Round Bot", created_at=EARLIER),
    )
    store, _ = store_for(connection)
    channel = run(store.direct(None, BOT_ID))

    assert inserted(connection) == []
    assert len(connection.statements) == 3
    assert channel.model_dump(mode="json", exclude_none=True) == {
        "id": CHANNEL_ID, "name": "Round Bot", "description": "", "botIds": [BOT_ID],
        "directBotId": BOT_ID, "createdAt": "2025-12-31T23:59:59.999Z"}


def test_direct_rejects_a_missing_bot_before_any_write():
    connection = FakeConnection([])
    store, _ = store_for(connection)
    with pytest.raises(conversations.ConversationNotFound):
        run(store.direct(None, BOT_ID))
    assert len(connection.statements) == 1
    assert inserted(connection) == []


def test_direct_refuses_to_repair_a_malformed_existing_membership():
    for members in ((BOT_ID, OTHER_BOT_ID), (OTHER_BOT_ID,), ()):
        connection = FakeConnection(
            [{"id": BOT_ID, "name": "Round Bot"}],
            [{"id": CHANNEL_ID}],
            read_rows(*members, direct_bot_id=BOT_ID),
        )
        store, _ = store_for(connection)
        with pytest.raises(StoreUnavailable):
            run(store.direct(None, BOT_ID))
        assert inserted(connection) == [], members


def test_direct_refuses_an_oversized_membership_instead_of_truncating_it():
    connection = FakeConnection(
        [{"id": BOT_ID, "name": "Round Bot"}],
        [{"id": CHANNEL_ID}],
        read_rows(*([BOT_ID] * 10001), direct_bot_id=BOT_ID),
    )
    store, _ = store_for(connection)
    with pytest.raises(StoreUnavailable):
        run(store.direct(None, BOT_ID))
    assert "LIMIT 10001" in connection.statements[2][0]


# ---------------------------------------------------------------------------
# join: one member, one event
# ---------------------------------------------------------------------------


def test_join_inserts_one_member_and_writes_one_event_with_exact_parameters():
    connection = FakeConnection(
        [{"direct_bot_id": None}],   # channels FOR UPDATE
        [{"id": BOT_ID}],            # bots FOR KEY SHARE
        [{"bot_id": BOT_ID}],        # INSERT returned a new row
        [],                          # BOT_JOINED_CHANNEL
        read_rows(BOT_ID, OTHER_BOT_ID),
    )
    store, transactions = store_for(connection)
    channel = run(store.join(TOKEN, CHANNEL_ID, conversations.parse_join({"botId": BOT_ID})))

    assert transactions.tokens == [TOKEN]
    assert len(connection.statements) == 5
    channel_sql, channel_params = connection.statements[0]
    assert "direct_bot_id" in channel_sql and channel_sql.endswith("FOR UPDATE")
    assert channel_params == (CHANNEL_ID,)
    bot_sql, bot_params = connection.statements[1]
    assert "FROM bots" in bot_sql and bot_sql.endswith("FOR KEY SHARE")
    assert bot_params == (BOT_ID,)

    insert_sql, insert_params = connection.statements[2]
    assert "ON CONFLICT DO NOTHING" in insert_sql and "RETURNING bot_id" in insert_sql
    assert insert_params == (CHANNEL_ID, BOT_ID)

    event_sql, event_params = events(connection)[0]
    assert "BOT_JOINED_CHANNEL" in event_sql
    assert event_params[1:] == (CHANNEL_ID, BOT_ID)

    read_sql, read_params = connection.statements[4]
    assert "ORDER BY cb.joined_at, cb.bot_id" in read_sql
    assert "WHERE c.id=%s" in read_sql
    assert read_params == (CHANNEL_ID,)
    assert channel.botIds == [BOT_ID, OTHER_BOT_ID]
    assert channel.createdAt == "2026-01-02T03:04:05.123Z"


def test_a_repeated_join_writes_no_event():
    connection = FakeConnection(
        [{"direct_bot_id": None}],
        [{"id": BOT_ID}],
        [],                          # ON CONFLICT DO NOTHING returned nothing
        read_rows(BOT_ID),
    )
    store, _ = store_for(connection)
    channel = run(store.join(None, CHANNEL_ID, conversations.parse_join({"botId": BOT_ID})))

    assert events(connection) == []
    assert len(connection.statements) == 4
    assert channel.botIds == [BOT_ID]


def test_join_rejects_a_missing_channel_before_touching_the_bot():
    connection = FakeConnection([])
    store, _ = store_for(connection)
    with pytest.raises(conversations.ConversationNotFound):
        run(store.join(None, CHANNEL_ID, conversations.parse_join({"botId": BOT_ID})))
    assert len(connection.statements) == 1
    assert inserted(connection) == []


def test_join_refuses_a_direct_conversation_before_touching_the_bot():
    connection = FakeConnection([{"direct_bot_id": BOT_ID}])
    store, _ = store_for(connection)
    with pytest.raises(conversations.DirectMembershipLocked):
        run(store.join(None, CHANNEL_ID, conversations.parse_join({"botId": OTHER_BOT_ID})))
    assert len(connection.statements) == 1
    assert inserted(connection) == []


def test_join_rejects_a_missing_bot_before_any_write():
    connection = FakeConnection([{"direct_bot_id": None}], [])
    store, _ = store_for(connection)
    with pytest.raises(conversations.ConversationNotFound):
        run(store.join(None, CHANNEL_ID, conversations.parse_join({"botId": BOT_ID})))
    assert len(connection.statements) == 2
    assert inserted(connection) == []


# ---------------------------------------------------------------------------
# Authority reuse and the fixed failure code
# ---------------------------------------------------------------------------


class BrokenConnection:
    def __init__(self, error):
        self.error = error

    async def execute(self, sql, params=None):
        raise self.error


@pytest.mark.parametrize("error", [psycopg.OperationalError("connection lost"), TimeoutError()])
def test_storage_and_timeout_failures_map_to_one_fixed_code(error):
    store, _ = store_for(BrokenConnection(error))
    with pytest.raises(StoreUnavailable) as raised:
        run(store.direct(None, BOT_ID))
    assert raised.value.args == ("conversation_storage_unavailable",)
    with pytest.raises(StoreUnavailable) as raised:
        run(store.join(None, CHANNEL_ID, conversations.parse_join({"botId": BOT_ID})))
    assert raised.value.args == ("conversation_storage_unavailable",)


def test_the_store_reuses_the_shared_authority_instead_of_its_own():
    store = conversations.PostgresConversationStore(DSN)
    assert isinstance(store._transactions, OwnerTransactions)
    assert store._transactions._application_name == "openbot-control-conversations"

    # An unreachable DSN plus a malformed token: AuthenticationRequired can only come from the shared
    # context refusing the cookie shape before it ever connects.
    with pytest.raises(AuthenticationRequired):
        run(store.direct("short", BOT_ID))

    fake = FakeTransactions(FakeConnection())
    store._transactions = fake
    run(store.verify_schema())
    assert fake.schema_checked is True
