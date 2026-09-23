"""Task HTTP selection/authentication and pure store boundary helpers."""
from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import ReadResult, StoreUnavailable
from openbot_server.task_models import SubmitTaskResult
from openbot_server.task_routing import TaskValidation
from openbot_server.task_store import (TaskChannelNotFound, TooManyAttachments,
                                      AttachmentReferencesUnavailable, attachment_ids, task_title)
from test_app import Store, TOKEN, EXPIRES


@pytest.fixture
def api():
    reads, writer = Store(), AsyncMock()
    writer.submit.return_value = SubmitTaskResult.model_validate({
        "message": {"id": "m", "channelId": "c", "authorType": "human", "runId": "r", "content": "task", "createdAt": "2030-01-01T00:00:00.000Z"},
        "run": {"id": "r", "channelId": "c", "botId": "b", "sourceMessageId": "m", "executionProfile": "none", "instruction": "task", "title": "task", "status": "queued", "createdAt": "2030-01-01T00:00:00.000Z", "updatedAt": "2030-01-01T00:00:00.000Z"},
    })
    with TestClient(create_app(reads, owner_name="Owner", tasks=writer, allowed_origins=("https://control.test",)),
                    base_url="https://control.test") as client:
        client.headers["Origin"] = "https://control.test"
        client.cookies.set("__Host-openbot_session", TOKEN)
        yield reads, writer, client


def test_task_submission_is_explicit_and_only_returns_committed_queue_state(api):
    _, writer, client = api
    response = client.post("/api/v1/channels/c/messages", json={"content": " task ", "status": "completed"})
    assert response.status_code == 201 and response.json()["run"]["status"] == "queued"
    assert "runs" not in response.json()
    assert writer.submit.call_args.args[2].model_dump(exclude_none=True) == {"content": "task"}
    schema = client.get("/openapi.json").json()
    assert schema["paths"]["/api/v1/channels/{channel_id}/messages"]["post"]["security"] == [{"OwnerSession": []}]
    assert client.get("/health").json()["phase"] == "s2b-task-reference"
    assert client.post("/api/v1/runs/r/cancel", json={}).status_code == 405


def test_task_auth_and_body_limits_precede_writes(api):
    _, writer, client = api
    assert client.post("/api/v1/channels/c/messages", json={"content": "x"}, headers={"Origin": "null"}).status_code == 403
    assert client.post("/api/v1/channels/c/messages", json={"content": None}).status_code == 422
    assert client.post("/api/v1/channels/c/messages", content=b"x" * 131073, headers={"Content-Type": "application/json"}).status_code == 413
    client.cookies.clear()
    assert client.post("/api/v1/channels/c/messages", content=b"invalid").status_code == 401
    writer.submit.assert_not_called()


@pytest.mark.parametrize("error,status", [(AuthenticationRequired(),401), (TaskChannelNotFound(),404),
    (TaskValidation("Invalid recipients."),422), (TooManyAttachments(),413),
    (AttachmentReferencesUnavailable(),503), (StoreUnavailable("PRIVATE"),503)])
def test_task_failures_never_become_success_or_leak_storage(api, error, status):
    _, writer, client = api
    writer.submit.side_effect = error
    response = client.post("/api/v1/channels/c/messages", json={"content": "x"})
    assert response.status_code == status and "PRIVATE" not in response.text


def test_run_reads_hide_existence_without_owner_and_fail_closed():
    store = AsyncMock()
    with TestClient(create_app(store, owner_name="Owner")) as client:
        store.read.return_value = ReadResult(None, found=False)
        assert client.get("/api/v1/channels/absent/runs").status_code == 401
        store.read.return_value = ReadResult(EXPIRES, found=False)
        assert client.get("/api/v1/channels/absent/runs").status_code == 404
        store.read.return_value = ReadResult(EXPIRES)
        assert client.get("/api/v1/channels/empty/runs").json() == {"runs": []}
        store.read.return_value = ReadResult(EXPIRES, ({"id": "private"},))
        response = client.get("/api/v1/channels/broken/runs")
        assert response.status_code == 503 and "private" not in response.text


def test_attachment_markers_preserve_case_deduplication_and_bound():
    identity = str(uuid4())
    assert attachment_ids(f"[OpenBot attachment: {identity}] [openbot ATTACHMENT: {identity.upper()}]") == [identity]
    assert attachment_ids("[OpenBot attachment: malformed] ordinary text") == []
    assert len(attachment_ids(" ".join(f"[OpenBot attachment: {uuid4()}]" for _ in range(8)))) == 8
    with pytest.raises(TooManyAttachments):
        attachment_ids(" ".join(f"[OpenBot attachment: {uuid4()}]" for _ in range(9)))


def test_task_titles_keep_utf16_limits_without_invalid_surrogates():
    assert task_title("x" * 80) == "x" * 80
    assert task_title("x" * 81) == "x" * 77 + "..."
    assert task_title("😀" * 40) == "😀" * 40
    assert task_title("😀" * 41) == "😀" * 38 + "..."
    assert task_title("x" * 76 + "😀" + "y" * 4) == "x" * 76 + "..."
