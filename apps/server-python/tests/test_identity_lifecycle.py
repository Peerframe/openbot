"""ADR-0047 rename, content deletion with tombstones, read cursors and the audit view on real PostgreSQL."""
import asyncio
import hashlib
from uuid import uuid4

import psycopg
import pytest

from openbot_server.authority import AuthenticationRequired
from openbot_server.control_errors import ControlError
from openbot_server.conversations import ConversationNotFound, PostgresConversationStore
from openbot_server.identity_lifecycle import REDACTED_CONTENT, PostgresIdentityLifecycle
from openbot_server.workspace import PostgresWorkspace
from test_automation_store import synthetic_db


@pytest.fixture
def world(synthetic_db):
    bot, peer, channel, direct = (str(uuid4()) for _ in range(4))
    suffix = bot[:8]
    with psycopg.connect(synthetic_db["dsn"]) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES (%s,%s,'Assistant','none'),(%s,%s,'Reviewer','none')",
                   (bot, "Lifecycle " + suffix, peer, "Peer " + suffix))
        db.execute("INSERT INTO channels(id,name,description) VALUES (%s,%s,'Group description')", (channel, "Group " + suffix))
        db.execute("INSERT INTO channels(id,name,direct_bot_id) VALUES (%s,%s,%s)", (direct, "Lifecycle " + suffix, bot))
        db.execute("INSERT INTO channel_bots(channel_id,bot_id) VALUES (%s,%s),(%s,%s),(%s,%s)", (channel, bot, channel, peer, direct, bot))
    state = {**synthetic_db, "bot": bot, "peer": peer, "channel": channel, "direct": direct, "suffix": suffix, "channels": [channel, direct], "bots": [bot, peer]}
    yield state
    with psycopg.connect(synthetic_db["dsn"]) as db:
        channels, bots = state["channels"], state["bots"]
        db.execute("DELETE FROM work_sources WHERE channel_id=ANY(%s)", (channels,))
        db.execute("DELETE FROM work_tasks WHERE bot_id=ANY(%s)", (bots,))
        db.execute("DELETE FROM run_events WHERE channel_id=ANY(%s) OR bot_id=ANY(%s)", (channels, bots))
        db.execute("DELETE FROM runs WHERE channel_id=ANY(%s)", (channels,))
        db.execute("DELETE FROM messages WHERE channel_id=ANY(%s)", (channels,))
        db.execute("DELETE FROM channel_bots WHERE channel_id=ANY(%s)", (channels,))
        db.execute("DELETE FROM channels WHERE id=ANY(%s)", (channels,))
        db.execute("DELETE FROM bots WHERE id=ANY(%s)", (bots,))


def message(world, channel, author="bot", content="Evidence"):
    identity = str(uuid4())
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) VALUES (%s,%s,%s,%s,clock_timestamp())",
                   (identity, channel, author, content))
    return identity


def run(world, channel, status="running", bot=None):
    identity = str(uuid4())
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) VALUES (%s,%s,%s,'none','Do it','Task',%s)",
                   (identity, channel, bot or world["bot"], status))
    return identity


def work_reference(world, channel, message_id, run_id):
    task = str(uuid4())
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit,status) "
                   "VALUES (%s,'owner',%s,%s,%s,'Objective',0,'completed')",
                   (task, world["bot"], task, hashlib.sha256(task.encode()).hexdigest()))
        db.execute("INSERT INTO work_sources VALUES (%s,%s,%s,%s)", (task, run_id, channel, message_id))


def code(awaitable):
    with pytest.raises(ControlError) as error:
        asyncio.run(awaitable)
    return error.value.status, error.value.code


def test_rename_is_audited_trimmed_and_conflicts_only_with_live_names(world):
    store = PostgresIdentityLifecycle(world["dsn"])
    renamed = asyncio.run(store.rename_channel(world["token"], world["channel"], {"name": "  Renamed " + world["suffix"] + " ", "extra": 1}))
    assert renamed == {"channelId": world["channel"], "name": "Renamed " + world["suffix"]}
    other = str(uuid4())
    world["channels"].append(other)
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO channels(id,name) VALUES (%s,%s)", (other, "Taken " + world["suffix"]))
    assert code(store.rename_channel(world["token"], world["channel"], {"name": "Taken " + world["suffix"]})) == (409, "name_already_exists")
    assert code(store.rename_channel(world["token"], world["channel"], {"name": " "})) == (422, "invalid_rename_input")
    assert code(store.rename_channel(world["token"], world["channel"], {"name": "x" * 81})) == (422, "invalid_rename_input")
    assert code(store.rename_channel(world["token"], world["direct"], {"name": "Direct"})) == (409, "direct_channel_identity_follows_bot")
    # A tombstoned name is free for a new live row.
    asyncio.run(store.delete_channel(world["token"], other))
    asyncio.run(store.rename_channel(world["token"], world["channel"], {"name": "Taken " + world["suffix"]}))
    with psycopg.connect(world["dsn"]) as db:
        events = db.execute("SELECT payload FROM run_events WHERE channel_id=%s AND type='CHANNEL_RENAMED' ORDER BY created_at", (world["channel"],)).fetchall()
    assert [row[0]["to"] for row in events] == ["Renamed " + world["suffix"], "Taken " + world["suffix"]]
    assert events[0][0]["from"] == "Group " + world["suffix"]


def test_bot_rename_follows_to_direct_channel_and_requires_owner(world):
    store = PostgresIdentityLifecycle(world["dsn"])
    asyncio.run(store.rename_bot(world["token"], world["bot"], {"name": "Helper " + world["suffix"]}))
    with psycopg.connect(world["dsn"]) as db:
        assert db.execute("SELECT name FROM channels WHERE id=%s", (world["direct"],)).fetchone() == ("Helper " + world["suffix"],)
        assert db.execute("SELECT count(*) FROM run_events WHERE bot_id=%s AND type='BOT_RENAMED'", (world["bot"],)).fetchone() == (1,)
    assert code(store.rename_bot(world["token"], world["bot"], {"name": "Peer " + world["suffix"]})) == (409, "name_already_exists")
    assert code(store.rename_bot(world["token"], str(uuid4()), {"name": "Missing"})) == (404, "bot_not_found")
    for operation in (store.rename_bot(None, world["bot"], {"name": "X"}), store.delete_channel("x" * 43, world["channel"]),
                      store.unread(None), store.audit(None)):
        with pytest.raises(AuthenticationRequired):
            asyncio.run(operation)


def test_channel_delete_refuses_active_work_then_removes_content_and_keeps_facts(world):
    store = PostgresIdentityLifecycle(world["dsn"])
    source = message(world, world["channel"], "human", "Please review")
    loose = message(world, world["channel"], "bot", "Private reply")
    active = run(world, world["channel"], "waiting_approval")
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO message_reactions(message_id,channel_id,emoji) VALUES (%s,%s,'👍')", (loose, world["channel"]))
    assert code(store.delete_channel(world["token"], world["channel"])) == (409, "active_work_blocks_delete")
    with psycopg.connect(world["dsn"]) as db:
        db.execute("UPDATE runs SET status='completed' WHERE id=%s", (active,))
    work_reference(world, world["channel"], source, active)
    assert asyncio.run(store.delete_channel(world["token"], world["channel"])) == {"deleted": True, "channelId": world["channel"]}
    with psycopg.connect(world["dsn"]) as db:
        assert db.execute("SELECT id,content FROM messages WHERE channel_id=%s", (world["channel"],)).fetchall() == [(source, REDACTED_CONTENT)]
        assert db.execute("SELECT count(*) FROM message_reactions WHERE channel_id=%s", (world["channel"],)).fetchone() == (0,)
        assert db.execute("SELECT count(*) FROM channel_bots WHERE channel_id=%s", (world["channel"],)).fetchone() == (0,)
        assert db.execute("SELECT deleted_at IS NOT NULL,description FROM channels WHERE id=%s", (world["channel"],)).fetchone() == (True, "")
        assert db.execute("SELECT status FROM runs WHERE id=%s", (active,)).fetchone() == ("completed",)
        audit = db.execute("SELECT payload FROM run_events WHERE channel_id=%s AND type='CHANNEL_DELETED'", (world["channel"],)).fetchone()[0]
    assert audit["deletedMessages"] == 1 and audit["redactedMessages"] == 1 and audit["memberCount"] == 2
    assert code(store.delete_channel(world["token"], world["channel"])) == (404, "channel_not_found")
    assert code(store.mark_read(world["token"], world["channel"])) == (404, "channel_not_found")
    assert code(store.delete_channel(world["token"], world["direct"])) == (409, "direct_channel_identity_follows_bot")
    snapshot = asyncio.run(PostgresWorkspace(world["dsn"]).snapshot(world["token"]))
    assert world["channel"] not in {channel["id"] for channel in snapshot["channels"]}


def test_bot_delete_removes_conversation_and_learning_but_keeps_runs(world):
    store = PostgresIdentityLifecycle(world["dsn"])
    message(world, world["direct"], "bot", "Direct reply")
    active = run(world, world["direct"], "running")
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO employee_memories(id,bot_id,kind,title,content) VALUES (%s,%s,'semantic','Fact','Remember this')", (str(uuid4()), world["bot"]))
    assert code(store.delete_bot(world["token"], world["bot"])) == (409, "active_work_blocks_delete")
    with psycopg.connect(world["dsn"]) as db:
        db.execute("UPDATE runs SET status='failed' WHERE id=%s", (active,))
    assert asyncio.run(store.delete_bot(world["token"], world["bot"])) == {
        "deleted": True, "botId": world["bot"], "directChannelId": world["direct"]}
    with psycopg.connect(world["dsn"]) as db:
        assert db.execute("SELECT deleted_at IS NOT NULL,configuration FROM bots WHERE id=%s", (world["bot"],)).fetchone() == (True, {})
        assert db.execute("SELECT count(*) FROM channel_bots WHERE bot_id=%s", (world["bot"],)).fetchone() == (0,)
        assert db.execute("SELECT count(*) FROM employee_memories WHERE bot_id=%s", (world["bot"],)).fetchone() == (0,)
        assert db.execute("SELECT count(*) FROM messages WHERE channel_id=%s", (world["direct"],)).fetchone() == (0,)
        assert db.execute("SELECT deleted_at IS NOT NULL FROM channels WHERE id=%s", (world["direct"],)).fetchone() == (True,)
        assert db.execute("SELECT count(*) FROM runs WHERE id=%s", (active,)).fetchone() == (1,)
        assert db.execute("SELECT count(*) FROM channel_bots WHERE channel_id=%s", (world["channel"],)).fetchone() == (1,)
        types = {row[0] for row in db.execute("SELECT type FROM run_events WHERE bot_id=%s", (world["bot"],)).fetchall()}
    assert {"BOT_DELETED", "BOT_REMOVED_FROM_CHANNEL"} <= types
    snapshot = asyncio.run(PostgresWorkspace(world["dsn"]).snapshot(world["token"]))
    assert world["bot"] not in {bot["id"] for bot in snapshot["bots"]}
    assert world["direct"] not in {channel["id"] for channel in snapshot["channels"]}
    with pytest.raises(ConversationNotFound):
        asyncio.run(PostgresConversationStore(world["dsn"]).direct(world["token"], world["bot"]))
    # A new Bot may take the deleted name.
    replacement = str(uuid4())
    world["bots"].append(replacement)
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES (%s,%s,'Assistant','none')", (replacement, "Lifecycle " + world["suffix"]))


def test_unread_counts_only_bot_and_system_messages_after_the_read_cursor(world):
    store = PostgresIdentityLifecycle(world["dsn"])
    asyncio.run(store.mark_read(world["token"], world["channel"]))
    message(world, world["channel"], "human", "Mine")
    message(world, world["channel"], "bot", "Reply")
    message(world, world["channel"], "system", "Joined")
    assert asyncio.run(store.unread(world["token"])).get(world["channel"]) == 2
    first = asyncio.run(store.mark_read(world["token"], world["channel"]))
    second = asyncio.run(store.mark_read(world["token"], world["channel"]))
    assert second["lastReadAt"] >= first["lastReadAt"]
    assert world["channel"] not in asyncio.run(store.unread(world["token"]))
    with psycopg.connect(world["dsn"]) as db:
        db.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) "
                   "SELECT gen_random_uuid()::text,%s,'bot','Batch',clock_timestamp()+interval '1 second' FROM generate_series(1,120)", (world["channel"],))
    assert asyncio.run(store.unread(world["token"]))[world["channel"]] == 99


def test_audit_view_projects_allowlisted_fields_and_pages_by_time(world):
    store = PostgresIdentityLifecycle(world["dsn"])
    with psycopg.connect(world["dsn"]) as db:
        for index in range(3):
            db.execute("INSERT INTO run_events(id,channel_id,bot_id,type,payload,created_at) VALUES (%s,%s,%s,'MESSAGE_POSTED',%s,clock_timestamp()+(%s||' minutes')::interval)",
                       (str(uuid4()), world["channel"], world["bot"], psycopg.types.json.Jsonb({"content": "secret text", "actor": "owner", "size": 1.5}), 60 + index))
    page = asyncio.run(store.audit(world["token"], limit=2))
    assert len(page["events"]) == 2 and page["nextBefore"] == page["events"][1]["createdAt"]
    event = page["events"][0]
    assert event["type"] == "MESSAGE_POSTED" and event["details"] == {"actor": "owner"}
    assert event["channelName"] == "Group " + world["suffix"] and event["channelDeleted"] is False
    assert event["botName"] == "Lifecycle " + world["suffix"]
    rest = asyncio.run(store.audit(world["token"], before=page["nextBefore"], limit=1))
    assert rest["events"][0]["createdAt"] < page["nextBefore"]
    for arguments in ({"limit": 0}, {"limit": 101}, {"before": "yesterday"}, {"before": "2026-01-01T00:00:00"}):
        assert code(store.audit(world["token"], **arguments))[0] == 422


def test_http_routes_require_origin_and_hide_tombstones(world, tmp_path):
    from fastapi.testclient import TestClient
    from openbot_server.app import create_app
    from openbot_server.database import PostgresReadStore
    from openbot_server.product_control import OwnerProduct

    (tmp_path / "attachments").mkdir(mode=0o700)
    from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
    service = OwnerProduct(world["dsn"], object_root=tmp_path, knowledge=PostgresEmployeeKnowledge(world["dsn"]))
    app = create_app(PostgresReadStore(world["dsn"]), owner_name="Owner", secure_cookies=False,
                     allowed_origins=("http://testserver",), product=service)
    headers = {"Origin": "http://testserver"}
    with TestClient(app) as api:
        api.cookies.set("openbot_session", world["token"])
        path = "/api/v1/channels/" + world["channel"]
        assert api.patch(path, json={"name": "No origin"}).status_code == 403
        renamed = api.patch(path, headers=headers, json={"name": "HTTP " + world["suffix"]})
        assert renamed.status_code == 200, renamed.text
        assert renamed.json() == {"channel": {"channelId": world["channel"], "name": "HTTP " + world["suffix"]}}
        assert api.patch(path, headers=headers, json={"name": ""}).json() == {"error": "invalid_rename_input"}
        message(world, world["channel"], "bot", "Unread reply")
        assert api.get("/api/v1/channels/unread").json()["unread"].get(world["channel"]) == 1
        assert api.post(path + "/read", headers=headers).status_code == 200
        assert world["channel"] not in api.get("/api/v1/channels/unread").json()["unread"]
        assert api.get("/api/v1/audit?limit=abc").status_code == 422
        assert api.get("/api/v1/audit?limit=5&extra=1").status_code == 422
        assert api.get("/api/v1/audit?limit=5").json()["events"][0]["type"]
        def upload(channel):
            response = api.post(f"/api/v1/channels/{channel}/attachments", content=b"synthetic notes\n",
                                headers={**headers, "Content-Type": "application/octet-stream", "X-OpenBot-Filename": "notes.txt"})
            assert response.status_code == 201, response.text
            return response.json()["attachment"]["id"]
        survivor_channel = str(uuid4())
        world["channels"].append(survivor_channel)
        with psycopg.connect(world["dsn"]) as db:
            db.execute("INSERT INTO channels(id,name) VALUES (%s,%s)", (survivor_channel, "Survivor " + world["suffix"]))
        direct_file, group_file, survivor = upload(world["direct"]), upload(world["channel"]), upload(survivor_channel)
        files = tmp_path / "attachments"
        # The purge path proves the tombstone first, so a live channel's files are never removed.
        assert code(service.purge_deleted_channel_files(world["token"], [survivor_channel])) == (404, "channel_not_found")
        assert list(files.glob(survivor + ".*"))
        deleted = api.delete("/api/v1/bots/" + world["bot"], headers=headers)
        assert deleted.json() == {"deleted": True, "botId": world["bot"], "pluginGrantsRemoved": True, "attachmentsRemoved": True}
        assert not list(files.glob(direct_file + ".*")) and list(files.glob(group_file + ".*"))
        assert api.get("/api/v1/bots/" + world["bot"] + "/profile").status_code == 404
        assert world["bot"] not in [bot["id"] for bot in api.get("/api/v1/bots").json()["bots"]]
        assert api.delete(path, headers=headers).json() == {"deleted": True, "channelId": world["channel"], "attachmentsRemoved": True}
        assert not list(files.glob(group_file + ".*"))
        assert api.get(f"/api/v1/channels/{survivor_channel}/attachments/{survivor}/content").content == b"synthetic notes\n"
        assert api.get(path + "/messages").status_code == 404
        assert world["channel"] not in [channel["id"] for channel in api.get("/api/v1/channels").json()["channels"]]
