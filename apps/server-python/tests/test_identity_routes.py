"""HTTP guards for explicitly selected identity writes; real transactions are tested separately."""
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.database import StoreUnavailable
from openbot_server.identity_store import AuthenticationRequired, IdentityConflict, UnknownMembers
from openbot_server.models import Bot, Channel
from test_app import Store, TOKEN


@pytest.fixture
def api():
    reads = Store()
    writer = AsyncMock()
    writer.create_bot.return_value = Bot(id="bot-created", name="研究员", role="核查", status="idle",
                                         computerProfile="none", createdAt="2030-01-01T00:00:00.000Z")
    writer.create_channel.return_value = Channel(id="channel-created", name="项目", description="", botIds=[],
                                                 createdAt="2030-01-01T00:00:00.000Z")
    with TestClient(create_app(reads, owner_name="Owner", identity=writer,
                              allowed_origins=("https://control.test",)), base_url="https://control.test") as client:
        client.cookies.set("__Host-openbot_session", TOKEN)
        client.headers["Origin"] = "https://control.test"
        yield reads, writer, client


def test_creations_use_existing_envelopes_and_strip_unknown_inputs(api):
    _, writer, client = api
    response = client.post("/api/v1/bots", json={"name": " 研究员 ", "role": " 核查 ", "grants": ["admin"]})
    assert response.status_code == 201
    assert set(response.json()) == {"bot"} and "appearance" not in response.json()["bot"]
    token, payload = writer.create_bot.call_args.args
    assert token == TOKEN
    assert payload.model_dump(exclude_none=True) == {"name": "研究员", "role": "核查", "computerProfile": "none"}
    response = client.post("/api/v1/channels", json={"name": "项目"})
    assert response.status_code == 201 and response.json()["channel"]["botIds"] == []
    assert response.headers["cache-control"] == "no-store"
    writer.verify_schema.assert_awaited_once()


@pytest.mark.parametrize("origin", ["https://unlisted.test", "null", ""])
def test_origin_cannot_gain_writer_authority(api, origin):
    _, writer, client = api
    assert client.post("/api/v1/bots", headers={"Origin": origin}, json={"name": "x", "role": "x"}).status_code == 403
    writer.create_bot.assert_not_called()


def test_authentication_precedes_input_errors_and_plain_cookie_never_falls_back(api):
    reads, writer, client = api
    client.cookies.clear()
    client.cookies.set("openbot_session", TOKEN)
    assert client.post("/api/v1/bots", content=b"invalid").status_code == 401
    client.cookies.set("__Host-openbot_session", TOKEN)
    reads.revoked = True
    assert client.post("/api/v1/channels", json={"name": "x"}).status_code == 401
    writer.create_channel.assert_not_called()
    writer.create_bot.assert_not_called()


@pytest.mark.parametrize("payload", [{"name": "", "role": "x"}, {"name": 3, "role": "x"},
                                     {"name": "x", "role": "x", "appearance": None}])
def test_invalid_creation_never_reaches_transaction(api, payload):
    _, writer, client = api
    response = client.post("/api/v1/bots", json=payload)
    assert response.status_code == 422
    writer.create_bot.assert_not_called()


def test_body_limit_and_error_inputs_are_sanitized(api):
    _, writer, client = api
    response = client.post("/api/v1/bots", content=b'{"private":"' + b'x' * 8200 + b'"}',
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 413 and "private" not in response.text
    response = client.post("/api/v1/bots", json={"name": {"private": "submitted material"}})
    assert response.status_code == 422 and "submitted" not in response.text
    writer.create_bot.assert_not_called()


@pytest.mark.parametrize("error,status", [(AuthenticationRequired(), 401), (IdentityConflict("Name conflict."), 409),
                                        (UnknownMembers(), 422), (StoreUnavailable("PRIVATE DSN"), 503)])
def test_transaction_recheck_and_failures_cannot_become_success(api, error, status):
    _, writer, client = api
    writer.create_channel.side_effect = error
    response = client.post("/api/v1/channels", json={"name": "项目"})
    assert response.status_code == status and "PRIVATE" not in response.text


def test_only_selected_identity_routes_are_enabled_and_schema_refs_resolve(api):
    _, _, client = api
    assert client.post("/api/v1/auth/login", json={"password": "unused"}).status_code == 405
    assert client.post("/api/v1/runs", json={}).status_code == 405
    assert client.patch("/api/v1/bots", json={}).status_code == 405
    schema = client.get("/openapi.json").json()
    assert schema["paths"]["/api/v1/bots"]["post"]["security"] == [{"OwnerSession": []}]
    def resolve(node):
        if isinstance(node, dict):
            if "$ref" in node:
                assert node["$ref"].startswith("#/components/schemas/")
                assert node["$ref"].rsplit("/", 1)[-1] in schema["components"]["schemas"]
            for value in node.values():
                resolve(value)
        elif isinstance(node, list):
            for value in node:
                resolve(value)
    resolve(schema)


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_nonstandard_json_constants_cannot_hide_in_stripped_fields(api, constant):
    _, writer, client = api
    response = client.post("/api/v1/bots", content='{"name":"x","role":"x","ignored":' + constant + '}',
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    writer.create_bot.assert_not_called()
