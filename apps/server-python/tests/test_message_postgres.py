"""Latest-message windows use only the owned PostgreSQL fixture and existing TS oracle."""
import asyncio
import hashlib
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore, ReadResult, StoreUnavailable
from openbot_server.message_query import MESSAGE_QUERY
from test_auth_postgres import authentication


def test_real_message_window_empty_channel_and_existence_authority(fixture):
    paths = [path for path in fixture["expected"] if path.endswith("/messages")]
    assert len(paths) == 2
    app = create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"], secure_cookies=False)
    with TestClient(app) as client:
        missing = f"/api/v1/channels/{uuid4()}/messages"
        assert client.get(missing).status_code == 401
        client.cookies.set("openbot_session", fixture["token"])
        assert client.get(missing).status_code == 404
        for path in paths:
            assert client.get(path).json() == fixture["expected"][path]
        populated = next(fixture["expected"][path]["messages"] for path in paths if fixture["expected"][path]["messages"])
        assert len(populated) == 100
        assert populated[0]["id"] == "fixture-message-5" and populated[-1]["id"] == "fixture-message-104"


def test_equal_timestamps_have_stable_order_and_other_channels_are_excluded(fixture):
    channel_id = str(uuid4())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("INSERT INTO channels(id,name,description) VALUES (%s,'Python tied messages','')", (channel_id,))
        for suffix in ("c", "a", "b"):
            connection.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) "
                               "VALUES (%s,%s,'system',%s,'2026-01-02T00:00:00Z')", (channel_id+suffix,channel_id,suffix))
    store = PostgresReadStore(fixture["dsn"])
    first = asyncio.run(store.read(fixture["token"], "messages", channel_id=channel_id))
    second = asyncio.run(store.read(fixture["token"], "messages", channel_id=channel_id))
    assert first == second
    assert [row["content"] for row in first.rows] == ["a", "b", "c"]
    assert all(row["channel_id"] == channel_id for row in first.rows)


@pytest.mark.parametrize("column", ["content", "author_id"])
def test_oversize_selected_text_is_refused_before_driver_transfer_without_mutation(fixture, column):
    channel_id, message_id = str(uuid4()), str(uuid4())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("INSERT INTO channels(id,name,description) VALUES (%s,%s,'')", (channel_id, "Python oversize " + column))
        connection.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES (%s,%s,'system','test')", (message_id,channel_id))
        # column is a fixed test parameter, never external input.
        connection.execute("UPDATE messages SET " + column + "=repeat('x',4194305) WHERE id=%s", (message_id,))
        rows = connection.execute(MESSAGE_QUERY, (channel_id,channel_id)).fetchall()
        assert len(rows) == 1 and rows[0][2] is True
        assert all(value is None for value in rows[0][3:])
    with pytest.raises(StoreUnavailable, match="projection_limit"):
        asyncio.run(PostgresReadStore(fixture["dsn"]).read(fixture["token"], "messages", channel_id=channel_id))
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT octet_length(" + column + ") FROM messages WHERE id=%s", (message_id,)).fetchone() == (4194305,)


def test_revocation_after_message_query_discards_the_loaded_window(fixture):
    issued = asyncio.run(authentication(fixture).login(fixture["ownerPassword"], "192.0.2.80"))
    digest = hashlib.sha256(issued.token.encode()).hexdigest()
    channel = next(path.split("/")[-2] for path in fixture["expected"] if path.endswith("/messages") and fixture["expected"][path]["messages"])

    class RevokedDuringRead(PostgresReadStore):
        calls = 0

        async def _session(self, connection, value):
            self.calls += 1
            if self.calls == 2:
                with psycopg.connect(fixture["dsn"]) as revoke:
                    revoke.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=%s", (digest,))
            return await super()._session(connection, value)

    result = asyncio.run(RevokedDuringRead(fixture["dsn"]).read(issued.token, "messages", channel_id=channel))
    assert result == ReadResult(None)
