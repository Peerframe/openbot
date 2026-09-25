"""Real isolated PostgreSQL identity concurrency, rollback and shared throttle contracts."""
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlparse
from uuid import uuid4

import psycopg
from psycopg import sql
import pytest

from openbot_server.auth import InvalidClientIdentity, RateLimited
from openbot_server.authority import AuthenticationRequired
from openbot_server.control_errors import ControlError
from openbot_server.database import StoreUnavailable
from openbot_server.worker_host_identity import PostgresWorkerHostIdentity, digest_secret, resolve_client_identity


@pytest.fixture(scope="module")
def worker_db():
    path = os.environ.get("OPENBOT_CONTROL_TEST_FIXTURE")
    if not path:
        pytest.skip("Requires the owned OPENBOT_CONTROL_TEST_FIXTURE PostgreSQL database")
    value = json.loads(Path(path).read_text())
    target = urlparse(value["dsn"])
    assert target.hostname == "127.0.0.1" and target.path.startswith("/openbot_control_test_")
    return value


@pytest.fixture
def host_seed(worker_db):
    node_id = "synthetic-worker-" + str(uuid4())
    client = resolve_client_identity("2001:db8::" + uuid4().hex[:4])
    yield {**worker_db, "node": node_id, "client": client}
    with psycopg.connect(worker_db["dsn"]) as connection:
        connection.execute("DELETE FROM node_identity_events WHERE node_id=%s", (node_id,))
        connection.execute("DELETE FROM node_enrollment_tokens WHERE node_id=%s", (node_id,))
        connection.execute("DELETE FROM node_credentials WHERE node_id=%s", (node_id,))
        connection.execute("DELETE FROM request_throttle_buckets WHERE scope='node-enrollment' AND client_digest=%s", (client["digest"],))


def test_direct_and_single_trusted_proxy_identity():
    assert resolve_client_identity("127.0.0.1", 'for="bad"') == resolve_client_identity("127.0.0.1")
    assert resolve_client_identity("127.0.0.1", 'for="[2001:db8::1]";proto=https', "127.0.0.1") == {
        **resolve_client_identity("2001:db8::1"), "source": "forwarded"}
    for value in (None, "", "for=192.0.2.1, for=192.0.2.2", "for=192.0.2.1;for=192.0.2.2", "for=192.0.2.1:443", "for=unknown", "for=fe80::1%en0", 'for="\\bad"'):
        with pytest.raises(InvalidClientIdentity):
            resolve_client_identity("127.0.0.1", value, "127.0.0.1")


def test_single_use_concurrent_exchange_rotation_and_revoke(host_seed):
    async def run():
        store = PostgresWorkerHostIdentity(host_seed["dsn"])
        node, token = host_seed["node"], host_seed["token"]
        issued = await store.issue(token, {"nodeId": node})
        results = await asyncio.gather(*(store.enroll({"nodeId": node, "token": issued["token"]}, host_seed["client"]) for _ in range(8)), return_exceptions=True)
        enrolled = [item for item in results if isinstance(item, dict)]
        assert len(enrolled) == 1
        assert all(isinstance(item, ControlError) and item.status == 401 for item in results if not isinstance(item, dict))
        old = enrolled[0]["credential"]
        assert await store.authenticate(node, old)
        row = next(row for row in await store.list(token) if row["nodeId"] == node)
        assert row["lastAuthenticatedAt"] and row["revokedAt"] is None
        replaced = await store.issue(token, {"nodeId": node})
        current = await store.issue(token, {"nodeId": node})
        with pytest.raises(ControlError):
            await store.enroll({"nodeId": node, "token": replaced["token"]}, host_seed["client"])
        new = await store.enroll({"nodeId": node, "token": current["token"]}, host_seed["client"])
        assert not await store.authenticate(node, old)
        assert await store.authenticate(node, new["credential"])
        await store.revoke(token, node)
        assert not await store.authenticate(node, new["credential"])
        with pytest.raises(ControlError) as missing:
            await store.revoke(token, node)
        assert missing.value.status == 404
        with psycopg.connect(host_seed["dsn"]) as connection:
            digest = connection.execute("SELECT credential_digest FROM node_credentials WHERE node_id=%s", (node,)).fetchone()[0]
            assert digest == digest_secret("credential", new["credential"])
            events = connection.execute("SELECT type,details FROM node_identity_events WHERE node_id=%s", (node,)).fetchall()
            assert [row[0] for row in events].count("enrolled") == 2
            assert [row[0] for row in events].count("revoked") == 1
            assert all(issued["token"] not in json.dumps(row) and old not in json.dumps(row) for row in events)
    asyncio.run(run())


def test_owner_authority_expiry_and_enrollment_expiry(host_seed):
    async def run():
        store = PostgresWorkerHostIdentity(host_seed["dsn"])
        for action in (lambda: store.issue(None, {"nodeId": host_seed["node"]}), lambda: store.list(None), lambda: store.revoke(None, host_seed["node"])):
            with pytest.raises(AuthenticationRequired):
                await action()
        issued = await store.issue(host_seed["token"], {"nodeId": host_seed["node"]})
        with psycopg.connect(host_seed["dsn"]) as connection:
            connection.execute("UPDATE node_enrollment_tokens SET expires_at=now()-interval '1 second' WHERE node_id=%s", (host_seed["node"],))
        with pytest.raises(ControlError):
            await store.enroll({"nodeId": host_seed["node"], "token": issued["token"]}, host_seed["client"])
    asyncio.run(run())


def test_shared_throttle_survives_new_store_instances(host_seed):
    async def run():
        value = {"nodeId": host_seed["node"], "token": "obenr_" + "x" * 43}
        for _ in range(30):
            with pytest.raises(ControlError):
                await PostgresWorkerHostIdentity(host_seed["dsn"]).enroll(value, host_seed["client"])
        with pytest.raises(RateLimited) as denied:
            await PostgresWorkerHostIdentity(host_seed["dsn"]).enroll(value, host_seed["client"])
        assert 1 <= denied.value.retry_after <= 300
    asyncio.run(run())


def test_identity_event_failure_rolls_back_token_consumption(host_seed):
    async def run():
        store = PostgresWorkerHostIdentity(host_seed["dsn"])
        issued = await store.issue(host_seed["token"], {"nodeId": host_seed["node"]})
        function, trigger = "worker_fail_" + uuid4().hex, "worker_fail_" + uuid4().hex
        with psycopg.connect(host_seed["dsn"]) as connection:
            connection.execute(sql.SQL("CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$").format(sql.Identifier(function)))
            connection.execute(sql.SQL("CREATE TRIGGER {} BEFORE INSERT ON node_identity_events FOR EACH ROW WHEN (NEW.node_id={} AND NEW.type='enrolled') EXECUTE FUNCTION {}()").format(sql.Identifier(trigger), sql.Literal(host_seed["node"]), sql.Identifier(function)))
        try:
            with pytest.raises(StoreUnavailable):
                await store.enroll({"nodeId": host_seed["node"], "token": issued["token"]}, host_seed["client"])
            with psycopg.connect(host_seed["dsn"]) as connection:
                assert connection.execute("SELECT consumed_at FROM node_enrollment_tokens WHERE node_id=%s", (host_seed["node"],)).fetchone()[0] is None
                assert connection.execute("SELECT count(*) FROM node_credentials WHERE node_id=%s", (host_seed["node"],)).fetchone()[0] == 0
        finally:
            with psycopg.connect(host_seed["dsn"]) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON node_identity_events").format(sql.Identifier(trigger)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
        await store.enroll({"nodeId": host_seed["node"], "token": issued["token"]}, host_seed["client"])
    asyncio.run(run())


def test_owner_expiration_during_issue_rolls_back_audit_and_token(host_seed):
    async def run():
        store = PostgresWorkerHostIdentity(host_seed["dsn"])
        token, identity = secrets.token_urlsafe(32), str(uuid4())
        function, trigger = "worker_delay_" + uuid4().hex, "worker_delay_" + uuid4().hex
        with psycopg.connect(host_seed["dsn"]) as connection:
            connection.execute("INSERT INTO auth_sessions(id,owner_id,token_digest,expires_at) VALUES(%s,'owner',%s,%s)", (identity, hashlib.sha256(token.encode()).hexdigest(), datetime.now(timezone.utc) + timedelta(milliseconds=250)))
            connection.execute(sql.SQL("CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$").format(sql.Identifier(function)))
            connection.execute(sql.SQL("CREATE TRIGGER {} BEFORE INSERT ON node_identity_events FOR EACH ROW WHEN (NEW.node_id={}) EXECUTE FUNCTION {}()").format(sql.Identifier(trigger), sql.Literal(host_seed["node"]), sql.Identifier(function)))
        try:
            with pytest.raises(AuthenticationRequired):
                await store.issue(token, {"nodeId": host_seed["node"]})
            with psycopg.connect(host_seed["dsn"]) as connection:
                assert connection.execute("SELECT count(*) FROM node_enrollment_tokens WHERE node_id=%s", (host_seed["node"],)).fetchone()[0] == 0
                assert connection.execute("SELECT count(*) FROM node_identity_events WHERE node_id=%s", (host_seed["node"],)).fetchone()[0] == 0
        finally:
            with psycopg.connect(host_seed["dsn"]) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON node_identity_events").format(sql.Identifier(trigger)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
                connection.execute("DELETE FROM auth_sessions WHERE id=%s", (identity,))
    asyncio.run(run())
