"""Conversation HTTP boundary; PostgreSQL behavior is independently exercised by owned fixtures."""
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.conversations import ConversationNotFound, DirectMembershipLocked
from openbot_server.database import StoreUnavailable
from openbot_server.models import Channel
from test_app import Store, TOKEN

BOT_ID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def api():
    reads, writer = Store(), AsyncMock()
    writer.direct.return_value = Channel(id="direct", name="Bot", description="", botIds=[BOT_ID], directBotId=BOT_ID,
                                         createdAt="2030-01-01T00:00:00.000Z")
    writer.join.return_value = Channel(id="group", name="Group", description="", botIds=[BOT_ID],
                                       createdAt="2030-01-01T00:00:00.000Z")
    with TestClient(create_app(reads, owner_name="Owner", conversations=writer,
                              allowed_origins=("https://control.test",)), base_url="https://control.test") as client:
        client.headers["Origin"] = "https://control.test"
        client.cookies.set("__Host-openbot_session", TOKEN)
        yield reads, writer, client


def test_selected_routes_use_existing_envelopes_and_validated_member_input(api):
    _, writer, client = api
    result = client.post(f"/api/v1/bots/{BOT_ID}/conversation")
    assert result.status_code == 200 and result.json()["channel"]["directBotId"] == BOT_ID
    result = client.post("/api/v1/channels/group/bots", json={"botId": BOT_ID, "grants": ["ignored"]})
    assert result.status_code == 200 and result.json()["channel"]["botIds"] == [BOT_ID]
    token, channel_id, value = writer.join.call_args.args
    assert token == TOKEN and channel_id == "group"
    assert value.model_dump() == {"botId": BOT_ID}
    writer.verify_schema.assert_awaited_once()
    assert result.headers["cache-control"] == "no-store"


def test_origin_session_and_input_are_all_required_before_join(api):
    reads, writer, client = api
    assert client.post("/api/v1/channels/group/bots", json={"botId": BOT_ID}, headers={"Origin": "https://other.test"}).status_code == 403
    assert client.post("/api/v1/channels/group/bots", json={"botId": None}).status_code == 422
    client.cookies.clear()
    assert client.post("/api/v1/channels/group/bots", content="bad").status_code == 401
    assert client.post(f"/api/v1/bots/{BOT_ID}/conversation").status_code == 401
    writer.join.assert_not_called()
    writer.direct.assert_not_called()


@pytest.mark.parametrize("error,status", [(AuthenticationRequired(), 401), (ConversationNotFound(), 404),
                                         (DirectMembershipLocked(), 422), (StoreUnavailable("PRIVATE"), 503)])
def test_transaction_outcomes_do_not_leak_storage_details(api, error, status):
    _, writer, client = api
    writer.join.side_effect = error
    response = client.post("/api/v1/channels/group/bots", json={"botId": BOT_ID})
    assert response.status_code == status and "PRIVATE" not in response.text


def test_other_mutations_remain_disabled_and_schema_requires_owner(api):
    _, writer, client = api
    assert client.delete(f"/api/v1/channels/group/bots/{BOT_ID}").status_code == 405
    assert client.post("/api/v1/channels/group/messages", json={"content": "test"}).status_code == 405
    schema = client.get("/openapi.json").json()
    for path in ("/api/v1/bots/{bot_id}/conversation", "/api/v1/channels/{channel_id}/bots"):
        assert schema["paths"][path]["post"]["security"] == [{"OwnerSession": []}]
