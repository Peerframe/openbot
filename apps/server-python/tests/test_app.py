from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.database import ReadResult, StoreUnavailable

TOKEN = "s" * 43
EXPIRES = datetime(2030, 1, 2, 3, 4, 5, 678000, timezone.utc)


class Store:
    def __init__(self):
        self.revoked = False
        self.verified = False
        self.failure = False

    async def verify_schema(self):
        self.verified = True
        if self.failure:
            raise StoreUnavailable("schema_history_mismatch")

    async def read(self, token, projection):
        if self.failure:
            raise StoreUnavailable("PRIVATE DATABASE DETAILS")
        if token != TOKEN or self.revoked:
            return ReadResult(None)
        if projection == "bots":
            return ReadResult(EXPIRES, ({
                "id": "bot-一", "name": "研究员", "role": "research", "status": "idle",
                "computer_profile": "none", "configuration": {"private": "NEVER PUBLIC"},
                "created_at": EXPIRES,
            },))
        if projection == "channels":
            return ReadResult(EXPIRES, ({
                "id": "channel-一", "name": "项目", "description": "材料核对",
                "direct_bot_id": None, "bot_id": "bot-一", "created_at": EXPIRES,
            },))
        return ReadResult(EXPIRES)


@pytest.fixture
def api():
    store = Store()
    with TestClient(create_app(store, owner_name="Owner", allowed_origins=("https://web.test",)),
                    base_url="https://control.test") as client:
        yield store, client


def authenticate(client):
    client.cookies.set("__Host-openbot_session", TOKEN)


def test_session_and_identity_reads_use_existing_envelopes_without_private_config(api):
    store, client = api
    assert store.verified
    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}
    assert client.get("/api/v1/bots").status_code == 401
    authenticate(client)
    session = client.get("/api/v1/auth/session")
    assert session.json() == {"authenticated": True, "owner": {"id": "owner", "name": "Owner"},
                              "expiresAt": "2030-01-02T03:04:05.678Z"}
    bots = client.get("/api/v1/bots")
    assert bots.json()["bots"][0]["name"] == "研究员"
    assert "appearance" not in bots.json()["bots"][0]
    assert "NEVER PUBLIC" not in bots.text
    assert "configuration" not in bots.text
    assert bots.headers["cache-control"] == "no-store"
    channel = client.get("/api/v1/channels").json()["channels"][0]
    assert channel["botIds"] == ["bot-一"]
    assert "directBotId" not in channel
    store.revoked = True
    assert client.get("/api/v1/bots").status_code == 401
    assert client.get("/api/v1/auth/session").json() == {"authenticated": False}


def test_secure_cookie_has_no_plain_cookie_fallback(api):
    _, client = api
    client.cookies.set("openbot_session", TOKEN)
    assert client.get("/api/v1/channels").status_code == 401


def test_mutations_and_unqualified_origins_do_not_gain_authority(api):
    _, client = api
    authenticate(client)
    for path in ("/api/v1/auth/login", "/api/v1/channels", "/api/v1/runs/anything/cancel"):
        assert client.post(path, json={"password": "synthetic"}).status_code == 405
    allowed = client.get("/api/v1/channels", headers={"Origin": "https://web.test"})
    assert allowed.headers["access-control-allow-origin"] == "https://web.test"
    blocked = client.get("/api/v1/channels", headers={"Origin": "https://unlisted.test"})
    assert "access-control-allow-origin" not in blocked.headers


def test_storage_failure_is_sanitized_and_never_becomes_empty_success(api):
    store, client = api
    authenticate(client)
    store.failure = True
    response = client.get("/api/v1/channels")
    assert response.status_code == 503
    assert "PRIVATE" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_bad_schema_prevents_lifespan_start():
    store = Store()
    store.failure = True
    with pytest.raises(StoreUnavailable):
        with TestClient(create_app(store, owner_name="Owner")):
            pytest.fail("Startup should not accept incompatible history")


def test_openapi_declares_cookie_and_read_only_contract(api):
    _, client = api
    schema = client.get("/openapi.json").json()
    assert schema["components"]["securitySchemes"]["OwnerSession"]["name"] == "__Host-openbot_session"
    assert schema["paths"]["/api/v1/bots"]["get"]["security"] == [{"OwnerSession": []}]
    assert set(schema["paths"]) == {"/health", "/api/v1/auth/session", "/api/v1/bots", "/api/v1/channels",
                                    "/api/v1/channels/{channel_id}/messages"}
    assert client.get("/docs").status_code == 404


def test_application_identity_does_not_leak_between_instances():
    with TestClient(create_app(Store(), owner_name="first")) as first:
        with TestClient(create_app(Store(), owner_name="second")) as second:
            authenticate(first)
            authenticate(second)
            assert first.get("/api/v1/auth/session").json()["owner"]["name"] == "first"
            assert second.get("/api/v1/auth/session").json()["owner"]["name"] == "second"
            assert first.get("/api/v1/auth/session").json()["owner"]["name"] == "first"
