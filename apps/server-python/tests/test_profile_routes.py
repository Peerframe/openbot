"""Profile PATCH authorization, strict input and fixed error categories."""
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import StoreUnavailable
from openbot_server.profile_details import (ProfileMutationResult, ProfileConflict,
                                           ProfileNotFound, ProfileUnchanged)
from test_app import Store, TOKEN


@pytest.fixture
def api():
    reads, writer = Store(), AsyncMock()
    writer.update.return_value = ProfileMutationResult.model_validate({
        "employee": {"id": "bot", "name": "Bot", "role": "new", "status": "idle", "computerProfile": "none", "createdAt": "2030-01-01T00:00:00.000Z"},
        "details": {"description": "", "revision": 2, "updatedAt": "2030-01-02T00:00:00.000Z"},
        "evolution": {"id": "event", "botId": "bot", "type": "role_changed", "title": "Employee role updated",
                      "summary": "Owner updated: role.", "source": "manual", "evidence": [], "createdAt": "2030-01-02T00:00:00.000Z"},
    })
    with TestClient(create_app(reads, owner_name="Owner", profiles=writer, allowed_origins=("https://control.test",)),
                    base_url="https://control.test") as client:
        client.cookies.set("__Host-openbot_session", TOKEN)
        client.headers["Origin"] = "https://control.test"
        yield reads, writer, client


def test_profile_patch_normalizes_and_describes_its_contract(api):
    _, writer, client = api
    response = client.patch("/api/v1/bots/bot/profile", json={"role": " new ", "description": "  ", "expectedRevision": 1.0})
    assert response.status_code == 200 and response.json()["details"]["revision"] == 2
    assert writer.update.call_args.args[2].model_dump() == {"role": "new", "description": "", "expectedRevision": 1}
    assert response.headers["cache-control"] == "no-store"
    schema = client.get("/openapi.json").json()
    operation = schema["paths"]["/api/v1/bots/{bot_id}/profile"]["patch"]
    assert operation["security"] == [{"OwnerSession": []}]
    assert operation["requestBody"]["content"]["application/json"]["schema"]["additionalProperties"] is False
    assert client.post("/api/v1/bots/bot/profile", json={}).status_code == 405
    assert client.get("/api/v1/bots/bot/profile").status_code == 405


def test_profile_patch_authenticates_before_body_and_rejects_extra_authority(api):
    _, writer, client = api
    value = {"role": "new", "description": "", "expectedRevision": 1}
    assert client.patch("/api/v1/bots/bot/profile", json=value, headers={"Origin": "null"}).status_code == 403
    assert client.patch("/api/v1/bots/bot/profile", json={**value, "grants": ["all"]}).status_code == 422
    client.cookies.clear()
    assert client.patch("/api/v1/bots/bot/profile", content=b"invalid").status_code == 401
    writer.update.assert_not_called()


def test_profile_body_limit_accepts_maximum_unicode_fields_and_bounds_actual_bytes(api):
    _, writer, client = api
    # HTTPX emits Unicode directly, so this also detects an accidental old 8 KiB body limit.
    response = client.patch("/api/v1/bots/bot/profile", json={"role": "😀" * 160, "description": "🧪" * 2000, "expectedRevision": 1})
    assert response.status_code == 200
    assert len(writer.update.call_args.args[2].description) == 2000
    response = client.patch("/api/v1/bots/bot/profile", content=b"x" * 32769, headers={"Content-Type": "application/json"})
    assert response.status_code == 413


@pytest.mark.parametrize("error,status", [(AuthenticationRequired(), 401), (ProfileNotFound(), 404),
                                         (ProfileConflict(), 409), (ProfileUnchanged(), 422), (StoreUnavailable("PRIVATE"), 503)])
def test_profile_transaction_outcomes_are_fixed_and_not_successes(api, error, status):
    _, writer, client = api
    writer.update.side_effect = error
    response = client.patch("/api/v1/bots/bot/profile", json={"role": "new", "description": "", "expectedRevision": 1})
    assert response.status_code == status and "PRIVATE" not in response.text
