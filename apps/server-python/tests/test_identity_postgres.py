"""Atomic identity/audit acceptance in the Node-owned disposable PostgreSQL fixture."""
import asyncio
from collections import Counter
import hashlib
import json
import os
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.identity_inputs import parse_bot_create, parse_channel_create
from openbot_server.identity_store import AuthenticationRequired, IdentityConflict, PostgresIdentityStore, UnknownMembers
from test_auth_postgres import authentication


def app_for(fixture):
    return create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"], secure_cookies=False,
                      allowed_origins=("http://control.test",), auth=authentication(fixture),
                      identity=PostgresIdentityStore(fixture["dsn"]))


def test_owner_creates_identity_members_and_exact_audits_for_typescript_readback(fixture):
    with TestClient(app_for(fixture), base_url="http://control.test", client=("192.0.2.70", 12345)) as client:
        client.headers["Origin"] = "http://control.test"
        client.cookies.set("openbot_session", fixture["token"])
        appearance = {"head": "cat", "body": "classic", "mobility": "feet", "accessory": "none", "accent": "blue"}
        response = client.post("/api/v1/bots", json={"name": " Python 核查员 ", "role": "资料核查",
                                                   "appearance": appearance, "grant": "ignored"})
        assert response.status_code == 201
        bot = response.json()["bot"]
        assert bot["name"] == "Python 核查员" and bot["computerProfile"] == "none" and bot["status"] == "idle"
        assert bot["appearance"] == appearance
        original_id = fixture["expected"]["/api/v1/bots"]["bots"][0]["id"]
        member_ids = [bot["id"], original_id]
        response = client.post("/api/v1/channels", json={"name": "Python 核查组", "description": "共同核查", "botIds": member_ids})
        assert response.status_code == 201
        channel = response.json()["channel"]
        assert channel["botIds"] == member_ids
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT configuration, profile_revision FROM bots WHERE id=%s", (bot["id"],)).fetchone() == ({"appearance": appearance}, 1)
            assert connection.execute("SELECT type,title,summary,source,evidence FROM employee_evolution_events WHERE bot_id=%s",
                                      (bot["id"],)).fetchall() == [("created", "Employee created", "Python 核查员 was created with the 资料核查 role.", "manual", [])]
            events = connection.execute("SELECT type,payload FROM run_events WHERE bot_id=%s AND channel_id IS NULL", (bot["id"],)).fetchall()
            assert events == [("BOT_CREATED", {"name": bot["name"], "role": bot["role"]})]
            events = connection.execute("SELECT type,payload,bot_id FROM run_events WHERE channel_id=%s", (channel["id"],)).fetchall()
            assert Counter(event[0] for event in events) == {"CHANNEL_CREATED": 1, "BOT_JOINED_CHANNEL": 2}
            assert next(event[1] for event in events if event[0] == "CHANNEL_CREATED") == {"name": channel["name"]}
            assert {event[2] for event in events if event[0] == "BOT_JOINED_CHANNEL"} == set(member_ids)
        with os.fdopen(os.open(fixture["identityResult"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            json.dump({"bot": bot, "channel": channel}, output)


def test_concurrent_name_conflict_commits_only_one_identity_and_event(fixture):
    async def check():
        store = PostgresIdentityStore(fixture["dsn"])
        value = parse_bot_create({"name": "Python concurrent identity", "role": "test"})
        results = await asyncio.gather(*(store.create_bot(fixture["token"], value) for _ in range(2)), return_exceptions=True)
        assert sum(isinstance(value, IdentityConflict) for value in results) == 1
        assert sum(not isinstance(value, Exception) for value in results) == 1
    asyncio.run(check())
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM bots WHERE name='Python concurrent identity'").fetchone() == (1,)
        assert connection.execute("SELECT count(*) FROM run_events WHERE type='BOT_CREATED' AND payload->>'name'='Python concurrent identity'").fetchone() == (1,)


def test_missing_member_cannot_leave_a_channel_or_event(fixture):
    store = PostgresIdentityStore(fixture["dsn"])
    with pytest.raises(UnknownMembers):
        asyncio.run(store.create_channel(fixture["token"], parse_channel_create({"name": "Python missing member", "botIds": [str(uuid4())]})))
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM channels WHERE name='Python missing member'").fetchone() == (0,)
        assert connection.execute("SELECT count(*) FROM run_events WHERE payload->>'name'='Python missing member'").fetchone() == (0,)


def test_audit_failure_rolls_back_both_bot_and_channel_identity(fixture):
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("CREATE FUNCTION control_test_reject_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                           "IF NEW.payload->>'name'='Python audit reject' THEN RAISE EXCEPTION 'private fixture failure'; END IF; RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER control_test_reject_identity BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION control_test_reject_identity()")
    try:
        store = PostgresIdentityStore(fixture["dsn"])
        for operation, value in [(store.create_bot, parse_bot_create({"name": "Python audit reject", "role": "test"})),
                                 (store.create_channel, parse_channel_create({"name": "Python audit reject"}))]:
            with pytest.raises(StoreUnavailable):
                asyncio.run(operation(fixture["token"], value))
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM bots WHERE name='Python audit reject'").fetchone() == (0,)
            assert connection.execute("SELECT count(*) FROM channels WHERE name='Python audit reject'").fetchone() == (0,)
            assert connection.execute("SELECT count(*) FROM employee_evolution_events WHERE summary LIKE 'Python audit reject%'").fetchone() == (0,)
    finally:
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("DROP TRIGGER control_test_reject_identity ON run_events")
            connection.execute("DROP FUNCTION control_test_reject_identity()")


@pytest.mark.parametrize("change", ["revoked_at=clock_timestamp()", "expires_at=clock_timestamp()-interval '1 second'"])
def test_revoked_or_expired_session_cannot_write(fixture, change):
    issued = asyncio.run(authentication(fixture).login(fixture["ownerPassword"], "192.0.2.71"))
    digest = hashlib.sha256(issued.token.encode()).hexdigest()
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("UPDATE auth_sessions SET " + change + " WHERE token_digest=%s", (digest,))
    with pytest.raises(AuthenticationRequired):
        asyncio.run(PostgresIdentityStore(fixture["dsn"]).create_bot(issued.token, parse_bot_create({"name": "Python unauthorized", "role": "test"})))
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM bots WHERE name='Python unauthorized'").fetchone() == (0,)


def test_revoke_committed_while_writer_waits_is_rechecked_after_row_lock(fixture):
    async def check():
        issued = await authentication(fixture).login(fixture["ownerPassword"], "192.0.2.72")
        digest = hashlib.sha256(issued.token.encode()).hexdigest()
        async with await psycopg.AsyncConnection.connect(fixture["dsn"]) as revoke:
            await revoke.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=%s", (digest,))
            task = asyncio.create_task(PostgresIdentityStore(fixture["dsn"]).create_bot(
                issued.token, parse_bot_create({"name": "Python revoke wins", "role": "test"})))
            try:
                async with await psycopg.AsyncConnection.connect(fixture["dsn"], autocommit=True) as observer:
                    for _ in range(60):
                        cursor = await observer.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='openbot-control-identity' AND wait_event_type='Lock'")
                        if (await cursor.fetchone())[0] > 0:
                            break
                        await asyncio.sleep(0.01)
                    else:
                        pytest.fail("Identity transaction did not reach the conflicting session lock")
                await revoke.commit()
                with pytest.raises(AuthenticationRequired):
                    await task
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
    asyncio.run(check())
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM bots WHERE name='Python revoke wins'").fetchone() == (0,)


def test_existing_channel_name_conflict_is_409_without_new_audit(fixture):
    with TestClient(app_for(fixture), base_url="http://control.test") as client:
        client.headers["Origin"] = "http://control.test"
        client.cookies.set("openbot_session", fixture["token"])
        name = next(row["name"] for row in fixture["expected"]["/api/v1/channels"]["channels"] if "directBotId" not in row)
        response = client.post("/api/v1/channels", json={"name": name})
        assert response.status_code == 409
        assert "constraint" not in response.text


def test_explicit_identity_entry_creates_over_real_http(fixture):
    from pathlib import Path
    import signal
    import socket
    import subprocess
    import sys
    import time
    from urllib.error import URLError
    from urllib.request import Request, urlopen

    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    root = Path(__file__).resolve().parents[1]
    child = subprocess.Popen([sys.executable, "-I", str(root / "scripts/serve.py")], cwd=root,
        env={"PATH": os.defpath, "LANG": "C.UTF-8", "OPENBOT_CONTROL_DATABASE_URL": fixture["dsn"],
             "OPENBOT_CONTROL_COOKIE_MODE": "loopback", "OPENBOT_CONTROL_PORT": str(port),
             "OPENBOT_CONTROL_AUTHORITY": "identity", "OPENBOT_CONTROL_OWNER_PASSWORD": fixture["ownerPassword"]},
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            assert child.poll() is None
            try:
                with urlopen(base + "/health", timeout=0.25) as response:
                    assert json.load(response)["phase"] == "s2a-identity-reference"
                break
            except (URLError, TimeoutError):
                time.sleep(0.05)
        else:
            pytest.fail("Identity HTTP process did not become ready")
        headers = {"Content-Type": "application/json", "Origin": base, "Cookie": "openbot_session=" + fixture["token"]}
        request = Request(base + "/api/v1/bots", data=json.dumps({"name": "Python HTTP identity", "role": "test"}).encode(), headers=headers, method="POST")
        with urlopen(request, timeout=5) as response:
            assert response.status == 201
            bot = json.load(response)["bot"]
        request = Request(base + "/api/v1/channels", data=json.dumps({"name": "Python HTTP channel", "botIds": [bot["id"]]}).encode(), headers=headers, method="POST")
        with urlopen(request, timeout=5) as response:
            assert response.status == 201 and json.load(response)["channel"]["botIds"] == [bot["id"]]
        child.terminate()
        assert child.wait(timeout=10) == -signal.SIGTERM
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)


def test_session_expiring_while_audit_waits_rolls_back_the_entire_creation(fixture):
    async def check():
        issued = await authentication(fixture).login(fixture["ownerPassword"], "192.0.2.73")
        digest = hashlib.sha256(issued.token.encode()).hexdigest()
        async with await psycopg.AsyncConnection.connect(fixture["dsn"], autocommit=True) as observer:
            await observer.execute("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_digest=%s", (digest,))
            async with await psycopg.AsyncConnection.connect(fixture["dsn"]) as blocker:
                await blocker.execute("LOCK TABLE run_events IN ACCESS EXCLUSIVE MODE")
                task = asyncio.create_task(PostgresIdentityStore(fixture["dsn"]).create_bot(
                    issued.token, parse_bot_create({"name": "Python expires during write", "role": "test"})))
                try:
                    for _ in range(60):
                        cursor = await observer.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='openbot-control-identity' AND wait_event_type='Lock'")
                        if (await cursor.fetchone())[0] > 0:
                            break
                        await asyncio.sleep(0.01)
                    else:
                        pytest.fail("Identity transaction did not reach its audit write")
                    for _ in range(70):
                        cursor = await observer.execute("SELECT expires_at <= clock_timestamp() FROM auth_sessions WHERE token_digest=%s", (digest,))
                        if (await cursor.fetchone())[0]:
                            break
                        await asyncio.sleep(0.01)
                    else:
                        pytest.fail("Synthetic session did not expire")
                    await blocker.commit()
                    with pytest.raises(AuthenticationRequired):
                        await task
                finally:
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(check())
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM bots WHERE name='Python expires during write'").fetchone() == (0,)
        assert connection.execute("SELECT count(*) FROM employee_evolution_events WHERE summary LIKE 'Python expires during write%'").fetchone() == (0,)
