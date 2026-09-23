"""Atomic task journeys against the Node-owned PostgreSQL reference, without a dispatcher."""
import asyncio
import hashlib
import json
import os
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.identity_inputs import parse_bot_create, parse_channel_create
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.conversations import PostgresConversationStore
from openbot_server.task_inputs import parse_message
from openbot_server.task_routing import TaskValidation
from openbot_server.task_store import (PostgresTaskStore, AttachmentReferencesUnavailable,
                                      TooManyAttachments, TaskChannelNotFound)
from test_auth_postgres import authentication


def prepare(fixture, label):
    async def create():
        identities = PostgresIdentityStore(fixture["dsn"])
        first = await identities.create_bot(fixture["token"], parse_bot_create({"name": label+" first", "role": "reviewer"}))
        chief = await identities.create_bot(fixture["token"], parse_bot_create({"name": label+" chief", "role": "coordinator"}))
        channel = await identities.create_channel(fixture["token"], parse_channel_create({"name": label, "botIds": [first.id,chief.id]}))
        return first,chief,channel
    return asyncio.run(create())


def counts(fixture, channel_id):
    with psycopg.connect(fixture["dsn"]) as connection:
        return tuple(connection.execute(query, (channel_id,)).fetchone()[0] for query in (
            "SELECT count(*) FROM messages WHERE channel_id=%s",
            "SELECT count(*) FROM runs WHERE channel_id=%s",
            "SELECT count(*) FROM run_events WHERE channel_id=%s AND type IN ('MESSAGE_CREATED','RUN_CREATED')"))


def test_multi_recipient_submission_is_atomic_and_typescript_can_read_every_record(fixture):
    first,chief,channel = prepare(fixture, "Python multi task")
    result = asyncio.run(PostgresTaskStore(fixture["dsn"]).submit(fixture["token"], channel.id,
                         parse_message({"content": " 共同核查 🧪 ", "botIds": [first.id,chief.id]})))
    assert result.message.content == "共同核查 🧪"
    assert result.message.runId == result.run.id == result.runs[0].id
    assert [run.botId for run in result.runs] == [first.id,chief.id]
    assert all(run.sourceMessageId == result.message.id and run.status == "queued" for run in result.runs)
    assert counts(fixture, channel.id) == (1,2,3)
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT type,payload FROM run_events WHERE channel_id=%s AND type='MESSAGE_CREATED'", (channel.id,)).fetchall() == [
            ("MESSAGE_CREATED", {"messageId": result.message.id, "authorType": "human"})]
        rows = connection.execute("SELECT run_id,bot_id,payload FROM run_events WHERE channel_id=%s AND type='RUN_CREATED'", (channel.id,)).fetchall()
        assert {row[0] for row in rows} == {run.id for run in result.runs}
        assert {row[1] for row in rows} == {first.id,chief.id}
        assert all(row[2] == {"sourceMessageId": result.message.id,"title": "共同核查 🧪","executionProfile":"none"} for row in rows)
    with os.fdopen(os.open(fixture["taskResult"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(result.model_dump(mode="json",exclude_none=True), output)


def test_default_chief_explicit_recipient_and_same_channel_reply(fixture):
    first,chief,channel = prepare(fixture, "Python routed task")
    async def check():
        store = PostgresTaskStore(fixture["dsn"])
        default = await store.submit(fixture["token"], channel.id, parse_message({"content":"first"}))
        explicit = await store.submit(fixture["token"], channel.id, parse_message({"content":"second","botId":first.id,"replyToMessageId":default.message.id}))
        assert default.run.botId == chief.id and default.runs is None
        assert explicit.run.botId == first.id and explicit.message.replyToMessageId == default.message.id
        assert "runs" not in explicit.model_dump(mode="json",exclude_none=True)
    asyncio.run(check())
    assert counts(fixture,channel.id) == (2,2,4)


def test_missing_recipients_foreign_reply_and_direct_scope_leave_no_partial_tasks(fixture):
    first,chief,channel = prepare(fixture, "Python rejected task")
    store = PostgresTaskStore(fixture["dsn"])
    foreign = fixture["expected"]["/api/v1/bots"]["bots"][0]["id"]
    for value in ({"content":"bad","botId":foreign}, {"content":"bad","botIds":[first.id,foreign]},
                  {"content":"bad","replyToMessageId":str(uuid4())}, {"content":"\ud800"}):
        with pytest.raises(TaskValidation):
            asyncio.run(store.submit(fixture["token"],channel.id,parse_message(value)))
    assert counts(fixture,channel.id) == (0,0,0)
    direct = asyncio.run(PostgresConversationStore(fixture["dsn"]).direct(fixture["token"],first.id))
    with pytest.raises(TaskValidation):
        asyncio.run(store.submit(fixture["token"],direct.id,parse_message({"content":"bad","botId":chief.id})))
    assert counts(fixture,direct.id) == (0,0,0)
    with pytest.raises(TaskChannelNotFound):
        asyncio.run(store.submit(fixture["token"],str(uuid4()),parse_message({"content":"bad"})))
    empty = asyncio.run(PostgresIdentityStore(fixture["dsn"]).create_channel(fixture["token"],parse_channel_create({"name":"Python empty task"})))
    with pytest.raises(TaskValidation):
        asyncio.run(store.submit(fixture["token"],empty.id,parse_message({"content":"bad"})))
    assert counts(fixture,empty.id) == (0,0,0)


def test_concurrent_source_messages_have_distinct_monotonic_milliseconds(fixture):
    _,_,channel = prepare(fixture,"Python concurrent tasks")
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) VALUES (%s,%s,'human','future boundary','2030-01-01T00:00:00Z')", (str(uuid4()),channel.id))
    async def check():
        store = PostgresTaskStore(fixture["dsn"])
        return await asyncio.gather(*(store.submit(fixture["token"],channel.id,parse_message({"content":f"task {index}"})) for index in range(8)))
    result = asyncio.run(check())
    times = sorted(value.message.createdAt for value in result)
    assert times == [f"2030-01-01T00:00:00.00{index}Z" for index in range(1,9)]
    assert all(value.message.createdAt == value.run.createdAt == value.run.updatedAt for value in result)
    assert counts(fixture,channel.id) == (9,8,16)


def test_audit_failure_rolls_back_message_all_runs_and_audits(fixture):
    first,chief,channel = prepare(fixture,"Python failed tasks")
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("CREATE FUNCTION control_test_reject_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='RUN_CREATED' THEN RAISE EXCEPTION 'private fixture failure'; END IF; RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER control_test_reject_task BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION control_test_reject_task()")
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresTaskStore(fixture["dsn"]).submit(fixture["token"],channel.id,parse_message({"content":"rollback","botIds":[first.id,chief.id]})))
        assert counts(fixture,channel.id) == (0,0,0)
    finally:
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("DROP TRIGGER control_test_reject_task ON run_events")
            connection.execute("DROP FUNCTION control_test_reject_task()")


@pytest.mark.parametrize("change", ["revoked_at=clock_timestamp()", "expires_at=clock_timestamp()-interval '1 second'"])
def test_task_writer_rejects_revoked_or_expired_owner(fixture,change):
    issued = asyncio.run(authentication(fixture).login(fixture["ownerPassword"],"192.0.2.83"))
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("UPDATE auth_sessions SET "+change+" WHERE token_digest=%s",(hashlib.sha256(issued.token.encode()).hexdigest(),))
    with pytest.raises(AuthenticationRequired):
        asyncio.run(PostgresTaskStore(fixture["dsn"]).submit(issued.token,str(uuid4()),parse_message({"content":"blocked"})))


def test_attachment_references_are_not_persisted_without_the_file_authority(fixture):
    _,_,channel = prepare(fixture,"Python file refusal")
    for size,error in ((1,AttachmentReferencesUnavailable),(9,TooManyAttachments)):
        value = parse_message({"content":" ".join(f"[OpenBot attachment: {uuid4()}]" for _ in range(size))})
        with pytest.raises(error):
            asyncio.run(PostgresTaskStore(fixture["dsn"]).submit(fixture["token"],channel.id,value))
    assert counts(fixture,channel.id) == (0,0,0)


def test_latest_fifty_runs_preserve_nullable_usage_and_refuse_oversize_text(fixture):
    _,_,channel = prepare(fixture,"Python bounded runs")
    async def create():
        store = PostgresTaskStore(fixture["dsn"])
        return [await store.submit(fixture["token"],channel.id,parse_message({"content":f"job {index}"})) for index in range(52)]
    result = asyncio.run(create())
    latest = result[-1].run
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("UPDATE runs SET model_usage=%s::jsonb WHERE id=%s",(json.dumps({"provider":"deepseek","model":"fixture","steps":1,"inputTokens":None,"outputTokens":2}),latest.id))
    app = create_app(PostgresReadStore(fixture["dsn"]),owner_name=fixture["ownerName"],secure_cookies=False)
    with TestClient(app) as client:
        client.cookies.set("openbot_session",fixture["token"])
        response = client.get(f"/api/v1/channels/{channel.id}/runs")
        assert response.status_code == 200
        rows = response.json()["runs"]
        assert len(rows) == 50 and rows[0]["id"] == latest.id and rows[-1]["id"] == result[2].run.id
        assert rows[0]["modelUsage"]["inputTokens"] is None and rows[0]["modelUsage"]["outputTokens"] == 2
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("UPDATE runs SET instruction=repeat('x',4194305) WHERE id=%s",(latest.id,))
        assert client.get(f"/api/v1/channels/{channel.id}/runs").status_code == 503
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT octet_length(instruction) FROM runs WHERE id=%s",(latest.id,)).fetchone() == (4194305,)


def test_explicit_task_process_commits_and_lists_over_real_http(fixture):
    from pathlib import Path
    import signal
    import socket
    import subprocess
    import sys
    import time
    from urllib.error import URLError
    from urllib.request import Request,urlopen

    _,_,channel = prepare(fixture,"Python HTTP task")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1",0))
        port = reservation.getsockname()[1]
    root = Path(__file__).resolve().parents[1]
    child = subprocess.Popen([sys.executable,"-I",str(root/"scripts/serve.py")],cwd=root,
        env={"PATH":os.defpath,"LANG":"C.UTF-8","OPENBOT_CONTROL_DATABASE_URL":fixture["dsn"],
             "OPENBOT_CONTROL_COOKIE_MODE":"loopback","OPENBOT_CONTROL_PORT":str(port),
             "OPENBOT_CONTROL_AUTHORITY":"tasks","OPENBOT_CONTROL_OWNER_PASSWORD":fixture["ownerPassword"]},
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    base=f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            assert child.poll() is None
            try:
                with urlopen(base+"/health",timeout=0.25) as response:
                    assert json.load(response)["phase"] == "s2b-task-reference"
                break
            except (URLError,TimeoutError):
                time.sleep(0.05)
        else:
            pytest.fail("Task HTTP entry did not become ready")
        headers={"Content-Type":"application/json","Origin":base,"Cookie":"openbot_session="+fixture["token"]}
        request=Request(base+f"/api/v1/channels/{channel.id}/messages",data=json.dumps({"content":"HTTP task"}).encode(),headers=headers,method="POST")
        with urlopen(request,timeout=5) as response:
            assert response.status == 201
            result=json.load(response)
            assert result["run"]["status"] == "queued"
        with urlopen(Request(base+f"/api/v1/channels/{channel.id}/runs",headers=headers),timeout=5) as response:
            assert json.load(response) == {"runs":[result["run"]]}
        request = Request(base+f"/api/v1/runs/{result['run']['id']}/steer", data=json.dumps({"instruction":"verify before delivery"}).encode(), headers=headers, method="POST")
        with urlopen(request,timeout=5) as response:
            assert response.status == 202 and json.load(response)["steering"]["instruction"] == "verify before delivery"
        request = Request(base+f"/api/v1/runs/{result['run']['id']}/cancel", data=b"{}", headers=headers, method="POST")
        with urlopen(request,timeout=5) as response:
            assert response.status == 200 and json.load(response)["run"]["status"] == "cancelled"
        child.terminate()
        assert child.wait(timeout=10) == -signal.SIGTERM
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
