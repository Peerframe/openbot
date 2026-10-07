"""CSV safety and real Owner HTTP category/keyset/export acceptance."""
import asyncio
import csv
import io
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.auth import OwnerAuthentication
from openbot_server.auth_store import PostgresAuthStore
from openbot_server.audit_records import csv_cell,export_csv
from openbot_server.database import PostgresReadStore
from openbot_server.identity_lifecycle import PostgresIdentityLifecycle
from openbot_server.product_control import OwnerProduct
from openbot_server.worker_host_identity import PostgresWorkerHostIdentity


@pytest.mark.parametrize("value",["=1+1","+cmd","-2+3","@SUM(A1)","\t=1"," \r\n@cmd","\ufeff=1","＝1+1"])
def test_csv_formula_candidates_are_prefixed(value):
    assert csv_cell(value)=="'"+value


def test_csv_quotes_and_roundtrips_newlines_commas_and_double_quotes():
    source='A, "B"\nC'
    data=export_csv([dict(id="e",createdAt="2026-10-01",category="channels",type="CHANNEL_RENAMED",channelName=source,details={"actor":"owner"})])
    rows=list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))
    assert rows[0]["channelName"]==source
    assert '\r\n' in data.decode()


def test_owner_audit_filters_keysets_exports_and_redacts_in_real_http(fixture,tmp_path):
    identities=[str(uuid4()) for _ in range(3)]
    with psycopg.connect(fixture["dsn"]) as db:
        for identity,event_type in zip(identities,["AUTH_LOGIN_SUCCEEDED","SETTINGS_MODEL_UPDATED","WORKER_HOST_CONNECTED"]):
            db.execute("INSERT INTO run_events(id,type,payload,created_at) VALUES (%s,%s,%s,'2040-01-01')",
                       (identity,event_type,psycopg.types.json.Jsonb({"actor":"=untrusted","apiKey":"must-never-leak","content":"private prompt","nodeId":"host"})))
    try:
        product=OwnerProduct(fixture["dsn"],object_root=tmp_path)
        app=create_app(PostgresReadStore(fixture["dsn"]),owner_name="Owner",secure_cookies=False,
                       allowed_origins=("http://testserver",),product=product)
        with TestClient(app) as api:
            assert api.get('/api/v1/audit/export').status_code==401
            api.cookies.set("openbot_session",fixture["token"])
            for category in ("authentication","settings","hosts"):
                page=api.get('/api/v1/audit',params={"category":category,"limit":1})
                assert page.status_code==200,page.text
                assert page.json()["events"][0]["category"]==category
                assert "must-never-leak" not in page.text and "private prompt" not in page.text
            for query in ("category=unknown","category=hosts&category=bots","limit=1001","extra=1"):
                assert api.get('/api/v1/audit/export?'+query).status_code==422
            page=api.get('/api/v1/audit/export?limit=1')
            assert page.status_code==200
            assert 'attachment;' in page.headers['content-disposition']
            assert page.headers['cache-control']=='no-store'
            cursor=page.headers['x-openbot-next-before']
            first=list(csv.DictReader(io.StringIO(page.content.decode('utf-8-sig'))))[0]
            second=api.get('/api/v1/audit/export',params={"limit":1,"before":cursor})
            next_row=list(csv.DictReader(io.StringIO(second.content.decode('utf-8-sig'))))[0]
            assert first['id']!=next_row['id']
            assert 'must-never-leak' not in page.text
    finally:
        with psycopg.connect(fixture["dsn"]) as db:db.execute("DELETE FROM run_events WHERE id=ANY(%s)",(identities,))


def test_auth_and_worker_lifecycle_events_enter_the_existing_audit(fixture):
    auth=OwnerAuthentication(PostgresAuthStore(fixture["dsn"]),owner_name="Owner",password=fixture["ownerPassword"])
    async def check():
        from openbot_server.auth import InvalidCredentials
        with pytest.raises(InvalidCredentials):await auth.login("wrong","192.0.2.181")
        issued=await auth.login(fixture["ownerPassword"],"192.0.2.181",user_agent="Synthetic C3 Desktop")
        sessions=await auth.sessions(issued.token)
        current=next(row for row in sessions if row["current"])
        assert current["userAgent"]=="Synthetic C3 Desktop"
        assert issued.token not in str(sessions)
        assert await auth.logout(issued.token)
        identity=PostgresWorkerHostIdentity(fixture["dsn"])
        await identity.connection_event("c3-audit-host","connected")
        await identity.connection_event("c3-audit-host","disconnected")
        service=PostgresIdentityLifecycle(fixture["dsn"])
        return await service.audit(fixture["token"],category="authentication"),await service.audit(fixture["token"],category="hosts")
    authentication,hosts=asyncio.run(check())
    assert {e['type'] for e in authentication['events']} >= {'AUTH_LOGIN_FAILED','AUTH_LOGIN_SUCCEEDED','AUTH_LOGOUT'}
    assert {e['type'] for e in hosts['events']} >= {'WORKER_HOST_CONNECTED','WORKER_HOST_DISCONNECTED'}
    assert fixture['ownerPassword'] not in str(authentication)


def test_connection_audit_failure_rolls_back_private_configuration(fixture,tmp_path):
    from openbot_server.model_connections import ModelConnectionsService
    from openbot_server.model_connections_cipher import ModelCredentialCipher
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    product=OwnerProduct(fixture['dsn'],object_root=tmp_path,model_connections=connections)
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,
                   allowed_origins=('http://testserver',),product=product)
    with psycopg.connect(fixture['dsn']) as db:
        before=db.execute('SELECT count(*) FROM model_connections').fetchone()[0]
        db.execute("CREATE FUNCTION c3_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type='MODEL_CONNECTION_CREATED' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$")
        db.execute("CREATE TRIGGER c3_reject BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c3_reject_audit()")
    try:
        with TestClient(app) as api:
            api.cookies.set('openbot_session',fixture['token'])
            response=api.post('/api/v1/model-connections',headers={'Origin':'http://testserver'},json={
                'presetId':'openai','name':'Rollback fixture','baseUrl':'https://api.openai.com/v1','apiKey':'synthetic-not-a-live-key'})
            assert response.status_code==503,response.text
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM model_connections').fetchone()[0]==before
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER c3_reject ON run_events');db.execute('DROP FUNCTION c3_reject_audit()')


def test_live_registry_connection_audit_and_failed_audit_refuse_availability(fixture):
    from test_worker_host_socket import live_server,hello,send,receive
    from websockets.asyncio.client import connect
    identity=PostgresWorkerHostIdentity(fixture['dsn'])
    async def check():
        async with live_server(options={'audit':identity.connection_event}) as (registry,url,base,_):
            async with connect(url,proxy=None) as ws:
                await send(ws,hello('c3-audit-live-host'))
                assert (await receive(ws))['accepted']
                assert len(registry.list())==1
        async def unavailable(*_):raise StoreUnavailable('synthetic audit unavailable')
        async with live_server(options={'audit':unavailable}) as (registry,url,base,events):
            async with connect(url,proxy=None) as ws:
                await send(ws,hello('c3-audit-rejected-host'))
                assert (await receive(ws))['accepted'] is False
                assert registry.list()==[]
                assert not any(event[0]=='available' for event in events)
    asyncio.run(check())
    with psycopg.connect(fixture['dsn']) as db:
        events=db.execute("SELECT type FROM run_events WHERE payload->>'nodeId'='c3-audit-live-host'").fetchall()
        assert {row[0] for row in events}=={'WORKER_HOST_CONNECTED','WORKER_HOST_DISCONNECTED'}


@pytest.mark.parametrize("valid_password",[False,True])
def test_login_audit_failure_cannot_publish_session_cookie_or_throttle(fixture,valid_password):
    from openbot_server.auth import client_digest
    auth=OwnerAuthentication(PostgresAuthStore(fixture["dsn"]),owner_name="Owner",password=fixture["ownerPassword"])
    app=create_app(PostgresReadStore(fixture["dsn"]),owner_name="Owner",secure_cookies=False,
                   allowed_origins=("http://testserver",),auth=auth)
    digest=client_digest("192.0.2.182")
    with psycopg.connect(fixture["dsn"]) as db:
        sessions_before=db.execute("SELECT count(*) FROM auth_sessions").fetchone()
        assert db.execute("SELECT attempt_count FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=%s",(digest,)).fetchone() is None
        events_before=db.execute("SELECT count(*) FROM run_events WHERE type IN ('AUTH_LOGIN_FAILED','AUTH_LOGIN_SUCCEEDED')").fetchone()
        db.execute("CREATE FUNCTION c3_reject_login_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type IN ('AUTH_LOGIN_FAILED','AUTH_LOGIN_SUCCEEDED') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$")
        db.execute("CREATE TRIGGER c3_reject_login BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c3_reject_login_audit()")
    try:
        with TestClient(app,client=("192.0.2.182",1)) as api:
            response=api.post('/api/v1/auth/login',headers={'Origin':'http://testserver','User-Agent':'Synthetic C3 Desktop'},
                              json={'password':fixture['ownerPassword'] if valid_password else 'wrong'})
            assert response.status_code==503,response.text
            assert 'set-cookie' not in response.headers and not api.cookies
            with psycopg.connect(fixture["dsn"]) as db:
                assert db.execute("SELECT count(*) FROM auth_sessions").fetchone()==sessions_before
                assert db.execute("SELECT attempt_count FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=%s",(digest,)).fetchone() is None
                assert db.execute("SELECT count(*) FROM run_events WHERE type IN ('AUTH_LOGIN_FAILED','AUTH_LOGIN_SUCCEEDED')").fetchone()==events_before
    finally:
        with psycopg.connect(fixture["dsn"]) as db:
            db.execute('DROP TRIGGER c3_reject_login ON run_events');db.execute('DROP FUNCTION c3_reject_login_audit()')
