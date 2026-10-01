"""Owner security uses real SQL and HTTP; shared fixture state is restored after each test."""
import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.auth import InvalidCredentials, OwnerAuthentication, RateLimited, client_digest
from openbot_server.auth_credentials import hash_password, verify_password
from openbot_server.auth_store import PostgresAuthStore
from openbot_server.database import PostgresReadStore, StoreUnavailable

NEW = "synthetic-new-owner-password"
ORIGIN = "http://control.test"


def test_scrypt_format_is_salted_bounded_and_never_accepts_custom_parameters():
    one=hash_password(NEW);two=hash_password(NEW)
    assert one!=two and NEW not in one
    assert verify_password(NEW,one)
    assert not verify_password(" "+NEW,one)
    with pytest.raises(ValueError):verify_password(NEW,one.replace("32768","9999999999"))


@contextmanager
def isolated(fixture):
    with psycopg.connect(fixture["dsn"]) as db:
        before=dict(db.execute("SELECT id,revoked_at FROM auth_sessions").fetchall())
        assert db.execute("SELECT count(*) FROM owner_credentials").fetchone()==(0,)
    store=PostgresAuthStore(fixture["dsn"])
    auth=OwnerAuthentication(store,owner_name="Owner",password=fixture["ownerPassword"])
    app=create_app(PostgresReadStore(fixture["dsn"]),owner_name="Owner",secure_cookies=False,
                   allowed_origins=(ORIGIN,),auth=auth)
    try:
        with TestClient(app,base_url=ORIGIN,client=("192.0.2.180",1)) as api:
            api.headers["Origin"]=ORIGIN
            yield store,auth,api
    finally:
        with psycopg.connect(fixture["dsn"]) as db:
            db.execute("DELETE FROM owner_credentials")
            db.execute("DELETE FROM auth_sessions WHERE NOT(id=ANY(%s))",(list(before),))
            for identity,revoked in before.items():
                db.execute("UPDATE auth_sessions SET revoked_at=%s WHERE id=%s",(revoked,identity))
            db.execute("DELETE FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=%s",
                       (client_digest("192.0.2.180"),))


def login(api,password):
    return api.post("/api/v1/auth/login",json={"password":password},headers={"User-Agent":"Synthetic Desktop"})


def test_real_session_listing_revocation_and_persistent_password_change(fixture):
    with isolated(fixture) as (store,auth,api):
        assert api.get("/api/v1/auth/sessions").status_code==401
        assert login(api,fixture["ownerPassword"]).status_code==200
        old_token=api.cookies["openbot_session"]
        devices=api.get("/api/v1/auth/sessions").json()["sessions"]
        current=next(row for row in devices if row["current"])
        assert current["userAgent"]=="Synthetic Desktop"
        assert old_token not in str(devices) and "token_digest" not in str(devices)
        revoked=api.post("/api/v1/auth/sessions/revoke-others")
        assert revoked.status_code==200 and revoked.json()["revoked"]>=1
        assert api.get("/api/v1/auth/session").json()["authenticated"] is True
        assert api.get("/api/v1/auth/sessions").json()["sessions"]==[current]
        changed=api.post("/api/v1/auth/password",json={"currentPassword":fixture["ownerPassword"],"newPassword":NEW})
        assert changed.status_code==200,changed.text
        assert changed.json()=={"changed":True,"reauthenticationRequired":True}
        assert "Max-Age=0" in changed.headers["set-cookie"]
        api.cookies.set("openbot_session",old_token)
        assert api.get("/api/v1/auth/sessions").status_code==401
        assert login(api,fixture["ownerPassword"]).status_code==401
        assert login(api,NEW).status_code==200
        restarted=OwnerAuthentication(PostgresAuthStore(fixture["dsn"]),owner_name="Owner",password=fixture["ownerPassword"])
        assert asyncio.run(restarted.login(NEW,"192.0.2.180")).session.authenticated
        stale=asyncio.run(store.attempt(client_digest=client_digest("192.0.2.180"),valid_password=True,
            session_id=str(uuid4()),token_digest="f"*64,ttl_hours=1,credential_revision=None))
        assert stale.status=="invalid"
        with psycopg.connect(fixture["dsn"]) as db:
            events=db.execute("SELECT type,payload FROM run_events WHERE type IN "
                "('OWNER_PASSWORD_CHANGED','OWNER_SESSIONS_REVOKED') ORDER BY created_at DESC LIMIT 2").fetchall()
            assert {row[0] for row in events}=={"OWNER_PASSWORD_CHANGED","OWNER_SESSIONS_REVOKED"}
            assert NEW not in str(events) and old_token not in str(events)


def test_password_change_requires_origin_current_password_and_bounded_input(fixture):
    with isolated(fixture) as (_,_,api):
        assert login(api,fixture["ownerPassword"]).status_code==200
        value={"currentPassword":fixture["ownerPassword"],"newPassword":NEW}
        assert api.post("/api/v1/auth/password",json=value,headers={"Origin":"https://evil.test"}).status_code==403
        assert api.post("/api/v1/auth/password",json={**value,"newPassword":"short"}).status_code==422
        assert api.post("/api/v1/auth/password",json={**value,"extra":True}).status_code==422
        response=api.post("/api/v1/auth/password",json={**value,"currentPassword":"wrong"})
        assert response.status_code==401 and NEW not in response.text
        assert api.get("/api/v1/auth/session").json()["authenticated"]
        for _ in range(4):
            assert api.post("/api/v1/auth/password",json={**value,"currentPassword":"wrong"}).status_code==401
        assert api.post("/api/v1/auth/password",json=value).status_code==429


def test_audit_failure_rolls_back_credential_and_all_session_revocations(fixture):
    with isolated(fixture) as (_,_,api):
        assert login(api,fixture["ownerPassword"]).status_code==200
        with psycopg.connect(fixture["dsn"]) as db:
            before=db.execute("SELECT count(*) FROM auth_sessions WHERE revoked_at IS NULL").fetchone()
            db.execute("CREATE FUNCTION c2_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                "IF NEW.type='OWNER_PASSWORD_CHANGED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$")
            db.execute("CREATE TRIGGER c2_reject BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c2_reject_audit()")
        try:
            response=api.post("/api/v1/auth/password",json={"currentPassword":fixture["ownerPassword"],"newPassword":NEW})
            assert response.status_code==503 and "set-cookie" not in response.headers
            assert api.get("/api/v1/auth/session").json()["authenticated"]
            with psycopg.connect(fixture["dsn"]) as db:
                assert db.execute("SELECT count(*) FROM owner_credentials").fetchone()==(0,)
                assert db.execute("SELECT count(*) FROM auth_sessions WHERE revoked_at IS NULL").fetchone()==before
        finally:
            with psycopg.connect(fixture["dsn"]) as db:
                db.execute("DROP TRIGGER c2_reject ON run_events");db.execute("DROP FUNCTION c2_reject_audit()")
