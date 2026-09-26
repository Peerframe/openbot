"""Real singleton and membership transactions in the Node-owned synthetic database."""
import asyncio
import json
import os
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.conversations import PostgresConversationStore, parse_join
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.identity_inputs import parse_bot_create, parse_channel_create
from openbot_server.identity_store import PostgresIdentityStore
from test_auth_postgres import authentication


def api(fixture):
    return create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"],
                      secure_cookies=False, allowed_origins=("http://control.test",),
                      conversations=PostgresConversationStore(fixture["dsn"]))


def test_concurrent_direct_requests_create_one_channel_and_exact_audit(fixture):
    async def check():
        identity = PostgresIdentityStore(fixture["dsn"])
        bot = await identity.create_bot(fixture["token"], parse_bot_create({"name": "Python direct singleton", "role": "test"}))
        store = PostgresConversationStore(fixture["dsn"])
        channels = await asyncio.gather(*(store.direct(fixture["token"], bot.id) for _ in range(8)))
        assert len({channel.id for channel in channels}) == 1
        assert all(channel.directBotId == bot.id and channel.botIds == [bot.id] for channel in channels)
        assert all(channel == channels[0] for channel in channels)
        return bot, channels[0]
    bot, channel = asyncio.run(check())
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM channels WHERE direct_bot_id=%s", (bot.id,)).fetchone() == (1,)
        rows = connection.execute("SELECT type,payload FROM run_events WHERE channel_id=%s ORDER BY type", (channel.id,)).fetchall()
        assert rows == [("BOT_JOINED_CHANNEL", {}), ("CHANNEL_CREATED", {"name": bot.name, "directBotId": bot.id})]
    with os.fdopen(os.open(fixture["conversationResult"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump({"channel": channel.model_dump(exclude_none=True)}, output)


def test_parallel_duplicate_joins_only_add_one_membership_and_event(fixture):
    async def check():
        identity = PostgresIdentityStore(fixture["dsn"])
        channel = await identity.create_channel(fixture["token"], parse_channel_create({"name": "Python parallel join"}))
        bot_id = fixture["expected"]["/api/v1/bots"]["bots"][0]["id"]
        store = PostgresConversationStore(fixture["dsn"])
        result = await asyncio.gather(*(store.join(fixture["token"], channel.id, parse_join({"botId": bot_id})) for _ in range(8)))
        assert all(row.botIds == [bot_id] for row in result)
        return channel.id, bot_id
    channel_id, bot_id = asyncio.run(check())
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM channel_bots WHERE channel_id=%s", (channel_id,)).fetchone() == (1,)
        assert connection.execute("SELECT count(*) FROM run_events WHERE channel_id=%s AND type='BOT_JOINED_CHANNEL'", (channel_id,)).fetchone() == (1,)


def test_asgi_rejects_unknown_ids_direct_changes_and_revoked_sessions(fixture):
    direct = next(value for value in fixture["expected"]["/api/v1/channels"]["channels"] if "directBotId" in value)
    group = next(value for value in fixture["expected"]["/api/v1/channels"]["channels"] if "directBotId" not in value)
    bot_id = fixture["expected"]["/api/v1/bots"]["bots"][0]["id"]
    with TestClient(api(fixture), base_url="http://control.test") as client:
        client.headers["Origin"] = "http://control.test"
        client.cookies.set("openbot_session", fixture["token"])
        assert client.post(f"/api/v1/bots/{uuid4()}/conversation").status_code == 404
        assert client.post(f"/api/v1/channels/{uuid4()}/bots", json={"botId": bot_id}).status_code == 404
        assert client.post(f"/api/v1/channels/{group['id']}/bots", json={"botId": str(uuid4())}).status_code == 404
        assert client.post(f"/api/v1/channels/{direct['id']}/bots", json={"botId": bot_id}).status_code == 422
        assert client.post(f"/api/v1/bots/{direct['directBotId']}/conversation").json() == {"channel": direct}
        issued = asyncio.run(authentication(fixture).login(fixture["ownerPassword"], "192.0.2.75"))
        assert asyncio.run(authentication(fixture).logout(issued.token))
        client.cookies.clear()
        client.cookies.set("openbot_session", issued.token)
        assert client.post(f"/api/v1/bots/{bot_id}/conversation").status_code == 401
        assert client.post(f"/api/v1/channels/{group['id']}/bots", json={"botId": bot_id}).status_code == 401


def test_audit_failure_rolls_back_direct_creation_and_join(fixture):
    async def prepare():
        identity = PostgresIdentityStore(fixture["dsn"])
        bot = await identity.create_bot(fixture["token"], parse_bot_create({"name": "Python conversation failure", "role": "test"}))
        channel = await identity.create_channel(fixture["token"], parse_channel_create({"name": "Python join failure"}))
        return bot, channel
    bot, channel = asyncio.run(prepare())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("CREATE FUNCTION control_test_reject_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                           "IF NEW.type='BOT_JOINED_CHANNEL' THEN RAISE EXCEPTION 'private audit failure'; END IF; RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER control_test_reject_conversation BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION control_test_reject_conversation()")
    try:
        async def attempt():
            store = PostgresConversationStore(fixture["dsn"])
            with pytest.raises(StoreUnavailable):
                await store.direct(fixture["token"], bot.id)
            with pytest.raises(StoreUnavailable):
                await store.join(fixture["token"], channel.id, parse_join({"botId": bot.id}))
        asyncio.run(attempt())
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM channels WHERE direct_bot_id=%s", (bot.id,)).fetchone() == (0,)
            assert connection.execute("SELECT count(*) FROM channel_bots WHERE channel_id=%s", (channel.id,)).fetchone() == (0,)
            assert connection.execute("SELECT count(*) FROM run_events WHERE payload->>'directBotId'=%s", (bot.id,)).fetchone() == (0,)
    finally:
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("DROP TRIGGER control_test_reject_conversation ON run_events")
            connection.execute("DROP FUNCTION control_test_reject_conversation()")


def test_existing_malformed_direct_membership_is_rejected_without_repair(fixture):
    async def prepare():
        identity = PostgresIdentityStore(fixture["dsn"])
        bot = await identity.create_bot(fixture["token"], parse_bot_create({"name": "Python malformed direct", "role": "test"}))
        channel = await PostgresConversationStore(fixture["dsn"]).direct(fixture["token"], bot.id)
        return bot, channel
    bot, channel = asyncio.run(prepare())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("DELETE FROM channel_bots WHERE channel_id=%s", (channel.id,))
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresConversationStore(fixture["dsn"]).direct(fixture["token"], bot.id))
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM channel_bots WHERE channel_id=%s", (channel.id,)).fetchone() == (0,)
            assert connection.execute("SELECT count(*) FROM run_events WHERE channel_id=%s", (channel.id,)).fetchone() == (2,)
    finally:
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("INSERT INTO channel_bots (channel_id,bot_id) VALUES (%s,%s)", (channel.id,bot.id))
