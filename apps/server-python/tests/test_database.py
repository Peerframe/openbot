import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from openbot_server.database import PostgresReadStore, ReadResult, StoreUnavailable, expected_history


def test_existing_history_is_loaded_without_a_second_python_journal():
    history = expected_history()
    assert len(history) >= 27
    assert all(len(digest) == 64 for _, digest in history)
    assert list(history) == sorted(history)


@pytest.mark.parametrize("token", [None, "", "not-a-session", "a" * 44, "💡" * 43])
def test_bad_cookie_never_reaches_database(token):
    store = PostgresReadStore("postgresql://fixture.invalid/unused")
    store._connect = AsyncMock(side_effect=AssertionError("Must not connect"))
    assert asyncio.run(store.read(token, "bots")) == ReadResult(None)
    store._connect.assert_not_called()


def test_unknown_projection_cannot_select_arbitrary_sql():
    store = PostgresReadStore("postgresql://fixture.invalid/unused")
    store._connect = AsyncMock(side_effect=AssertionError("Must not connect"))
    with pytest.raises(ValueError, match="Unknown"):
        asyncio.run(store.read("a" * 43, "auth_sessions"))


def test_post_projection_revocation_discards_prepared_rows():
    class Cursor:
        async def fetchall(self):
            return [{"id": "private-bot"}]

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def execute(self, *_):
            return Cursor()

    store = PostgresReadStore("postgresql://fixture.invalid/unused")
    store._connect = AsyncMock(return_value=Connection())
    store._session = AsyncMock(side_effect=[datetime.now(timezone.utc), None])
    assert asyncio.run(store.read("a" * 43, "bots")) == ReadResult(None)
    assert store._session.await_count == 2


def test_database_errors_have_fixed_public_category():
    import psycopg
    store = PostgresReadStore("postgresql://fixture.invalid/unused")
    store._connect = AsyncMock(side_effect=psycopg.OperationalError("PRIVATE DSN DETAILS"))
    with pytest.raises(StoreUnavailable, match="^storage_unavailable$") as raised:
        asyncio.run(store.read("a" * 43, "bots"))
    assert raised.value.__suppress_context__
