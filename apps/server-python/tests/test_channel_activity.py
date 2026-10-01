"""Real Owner HTTP/SQL activity acceptance, plus independent projection bounds."""
import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore
from openbot_server.models import project_channels
from openbot_server.workspace import PostgresWorkspace


def test_preview_projection_preserves_unicode_and_excludes_private_fields():
    stamp = datetime(2026, 10, 1, tzinfo=timezone.utc)
    row = dict(id="c", name="channel", description="", direct_bot_id=None,
        created_at=stamp, bot_id=None, last_activity_at=stamp, latest_message_id="m",
        latest_author_type="bot", latest_preview="😀" * 160, latest_message_at=stamp,
        content="must never leak", metadata={"credential": "must never leak"})
    projected = project_channels([row])[0].model_dump(exclude_none=True)
    assert projected["latestMessage"] == dict(id="m", authorType="bot", preview="😀" * 160,
        createdAt="2026-10-01T00:00:00.000Z")
    assert projected["lastActivityAt"] == "2026-10-01T00:00:00.000Z"
    assert "must never leak" not in str(projected)
    with pytest.raises(ValidationError):
        project_channels([{**row, "latest_preview": "😀" * 161}])


def test_real_channel_activity_sorting_truncation_empty_and_tombstone(fixture):
    identities = sorted(str(uuid4()) for _ in range(4))
    a, b, empty, deleted = identities
    with psycopg.connect(fixture["dsn"]) as db:
        for identity in identities:
            db.execute("INSERT INTO channels(id,name,description,created_at,updated_at) "
                "VALUES (%s,%s,'','2020-01-01','2020-01-01')", (identity, "C1 " + identity))
        db.execute("UPDATE channels SET deleted_at=now() WHERE id=%s", (deleted,))
        for identity in (a, b, deleted):
            for message_id, content in [("c1-a-" + identity, "old"), ("c1-z-" + identity, "😀" * 8000)]:
                db.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) "
                    "VALUES (%s,%s,'human',%s,'2040-01-01')", (message_id, identity, content))
    try:
        app = create_app(PostgresReadStore(fixture["dsn"]), owner_name="Owner", secure_cookies=False)
        with TestClient(app) as api:
            assert api.get("/api/v1/channels").status_code == 401
            api.cookies.set("openbot_session", fixture["token"])
            response = api.get("/api/v1/channels")
            assert response.status_code == 200, response.text
            rows = response.json()["channels"]
            assert [row["id"] for row in rows[:2]] == [a, b]
            selected = {row["id"]: row for row in rows}
            assert deleted not in selected
            assert "latestMessage" not in selected[empty]
            assert selected[empty]["lastActivityAt"] == selected[empty]["createdAt"]
            for identity in (a, b):
                assert selected[identity]["latestMessage"] == dict(id="c1-z-" + identity,
                    authorType="human", preview="😀" * 160, createdAt="2040-01-01T00:00:00.000Z")
            snapshot = asyncio.run(PostgresWorkspace(fixture["dsn"]).snapshot(fixture["token"]))
            assert snapshot["channels"] == rows
    finally:
        with psycopg.connect(fixture["dsn"]) as db:
            db.execute("DELETE FROM messages WHERE channel_id=ANY(%s)", (identities,))
            db.execute("DELETE FROM channels WHERE id=ANY(%s)", (identities,))
