"""Real Owner/Origin/CAS/routing/import/deletion/audit and SSE primary preference acceptance."""
import asyncio
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.control_errors import ControlError
from openbot_server.database import PostgresReadStore
from openbot_server.identity_inputs import CreateBotInput, CreateChannelInput, parse_quick_bot_create
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.product_control import OwnerProduct
from openbot_server.task_inputs import parse_message
from openbot_server.task_store import PostgresTaskStore
from openbot_server.workspace_settings import WorkspaceSettings
from test_product_control import stream_request, HEARTBEAT


@pytest.fixture(autouse=True)
def isolate(fixture):
    with psycopg.connect(fixture['dsn']) as db:
        previous = db.execute("SELECT primary_bot_id,revision FROM workspace_settings WHERE workspace_id='workspace'").fetchone()
        db.execute("UPDATE workspace_settings SET primary_bot_id=NULL,revision=1")
    yield
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("UPDATE workspace_settings SET primary_bot_id=%s,revision=%s",previous)


def raw_bot(fixture, *, deleted=False, role='assistant'):
    identity = str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile,deleted_at) VALUES(%s,%s,%s,'none',"
            + ("now()" if deleted else "NULL") + ")",(identity,'Primary '+uuid4().hex,role))
    return identity


def api(fixture, tmp_path):
    product = OwnerProduct(fixture['dsn'],object_root=tmp_path)
    app = create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,
        allowed_origins=('http://testserver',),product=product,tasks=PostgresTaskStore(fixture['dsn']))
    client = TestClient(app)
    client.cookies.set('openbot_session',fixture['token'])
    client.headers['Origin']='http://testserver'
    return client,product


def state(fixture):
    with psycopg.connect(fixture['dsn']) as db:
        identity, revision = db.execute('SELECT primary_bot_id,revision FROM workspace_settings').fetchone()
        return dict(primaryBotId=identity,revision=revision)


def test_http_owner_origin_cas_deleted_noop_and_audit(fixture,tmp_path):
    bot = raw_bot(fixture); deleted = raw_bot(fixture,deleted=True)
    client,_ = api(fixture,tmp_path)
    with client:
        initial = client.get('/api/v1/workspace').json()
        assert initial['primaryBotId'] is None and initial['revision']==1
        client.cookies.clear()
        assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=bot,expectedRevision=1)).status_code==401
        # Worker/API bearer credentials do not substitute for the Owner cookie.
        assert client.put('/api/v1/workspace/primary-bot',headers={'Authorization':'Bearer '+fixture['token']},
            json=dict(botId=bot,expectedRevision=1)).status_code==401
        client.cookies.set('openbot_session',fixture['token'])
        for origin in ('https://other.test','null',''):
            assert client.put('/api/v1/workspace/primary-bot',headers={'Origin':origin},
                json=dict(botId=bot,expectedRevision=1)).status_code==403
        for bad in (dict(botId=bot,expectedRevision=True),dict(botId=bot,expectedRevision=1,permissions=['all']),
                dict(expectedRevision=1),dict(botId='',expectedRevision=1)):
            assert client.put('/api/v1/workspace/primary-bot',json=bad).status_code==422
        assert state(fixture)==dict(primaryBotId=None,revision=1)
        for identity in (deleted,str(uuid4())):
            assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=identity,expectedRevision=1)).status_code==404
        selected = client.put('/api/v1/workspace/primary-bot',json=dict(botId=bot,expectedRevision=1))
        assert selected.status_code==200 and selected.json()==dict(primaryBotId=bot,revision=2)
        stale=client.put('/api/v1/workspace/primary-bot',json=dict(botId=None,expectedRevision=1))
        assert stale.status_code==409 and stale.json()['error']=='workspace_revision_conflict'
        assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=bot,expectedRevision=2)).json()==selected.json()
        events=client.get('/api/v1/audit?category=settings').json()['events']
        event=next(e for e in events if e['details'].get('primaryBotId')==bot)
        assert event['type']=='SETTINGS_PRIMARY_BOT_UPDATED' and event['details']['previousBotId'] is None
        assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=None,expectedRevision=2)).json()==dict(primaryBotId=None,revision=3)
    with psycopg.connect(fixture['dsn']) as db:
        rows=db.execute("SELECT payload FROM run_events WHERE type='SETTINGS_PRIMARY_BOT_UPDATED' "
            "AND (payload->>'primaryBotId'=%s OR payload->>'previousBotId'=%s)",(bot,bot)).fetchall()
        assert [r[0] for r in rows]==[
            dict(actor='owner',previousBotId=None,primaryBotId=bot,revision=2,reason='selected'),
            dict(actor='owner',previousBotId=bot,primaryBotId=None,revision=3,reason='selected')]
        assert db.execute('SELECT configuration,computer_profile FROM bots WHERE id=%s',(bot,)).fetchone()==({},'none')


def test_independent_owner_writers_have_one_version_winner(fixture):
    first,second=raw_bot(fixture),raw_bot(fixture)
    async def check():
        outcomes=await asyncio.gather(*(WorkspaceSettings(fixture['dsn']).update(fixture['token'],
            dict(botId=bot,expectedRevision=1)) for bot in (first,second)),return_exceptions=True)
        assert sum(isinstance(value,dict) for value in outcomes)==1
        assert sum(isinstance(value,ControlError) and value.code=='workspace_revision_conflict' for value in outcomes)==1
    asyncio.run(check())
    assert state(fixture)['primaryBotId'] in (first,second) and state(fixture)['revision']==2


def test_concurrent_selection_and_deletion_cannot_leave_deleted_primary(fixture,tmp_path):
    bot=raw_bot(fixture)
    product=OwnerProduct(fixture['dsn'],object_root=tmp_path)
    async def check():
        selected,deleted=await asyncio.gather(
            WorkspaceSettings(fixture['dsn']).update(fixture['token'],dict(botId=bot,expectedRevision=1)),
            product.lifecycle.delete_bot(fixture['token'],bot),return_exceptions=True)
        assert isinstance(deleted,dict) and deleted['deleted']
        assert isinstance(selected,dict) or isinstance(selected,ControlError) and selected.status==404
        assert state(fixture)['primaryBotId'] is None
        assert state(fixture)['revision']==(3 if isinstance(selected,dict) else 1)
    asyncio.run(check())


def test_default_create_and_quick_create_are_atomic_and_do_not_override(fixture):
    async def check():
        store=PostgresIdentityStore(fixture['dsn'])
        bots=await asyncio.gather(*(store.create_bot(fixture['token'],CreateBotInput(name='Created '+uuid4().hex,role='assistant')) for _ in range(3)))
        selected=state(fixture)
        assert selected['primaryBotId'] in [b.id for b in bots] and selected['revision']==2
        quick=await store.quick_create_bot(fixture['token'],parse_quick_bot_create(dict(appearance=dict(head='cat',body='classic',mobility='feet',accessory='none',accent='green'))))
        assert state(fixture)==selected and quick['bot'].id!=selected['primaryBotId']
        await WorkspaceSettings(fixture['dsn']).update(fixture['token'],dict(botId=None,expectedRevision=2))
        quick=await store.quick_create_bot(fixture['token'],parse_quick_bot_create(dict(appearance=dict(head='cat',body='classic',mobility='feet',accessory='none',accent='green'))))
        assert state(fixture)==dict(primaryBotId=quick['bot'].id,revision=4)
    asyncio.run(check())


def test_import_default_and_replay_do_not_reselect_existing_bot(fixture):
    from test_employee_portability import document,request,service
    async def check():
        doc=document(); command=request(doc); importer=service(fixture)
        imported=await importer.activate(fixture['token'],command)
        identity=imported['employee']['id']
        assert state(fixture)==dict(primaryBotId=identity,revision=2)
        await WorkspaceSettings(fixture['dsn']).update(fixture['token'],dict(botId=None,expectedRevision=2))
        replay=await importer.activate(fixture['token'],command)
        assert replay['replayed'] and state(fixture)==dict(primaryBotId=None,revision=3)
        next_doc=document(); second=await importer.activate(fixture['token'],request(next_doc))
        assert state(fixture)==dict(primaryBotId=second['employee']['id'],revision=4)
    asyncio.run(check())


def test_delete_primary_clears_and_never_elects_an_existing_bot(fixture,tmp_path):
    first,second=raw_bot(fixture),raw_bot(fixture)
    client,_=api(fixture,tmp_path)
    with client:
        assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=first,expectedRevision=1)).status_code==200
        assert client.delete('/api/v1/bots/'+first).status_code==200
        snapshot=client.get('/api/v1/workspace').json()
        assert snapshot['primaryBotId'] is None and snapshot['revision']==3
        assert second in [b['id'] for b in snapshot['bots']]
        assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=first,expectedRevision=3)).status_code==404
        assert client.delete('/api/v1/bots/'+second).status_code==200 and state(fixture)['revision']==3
    with psycopg.connect(fixture['dsn']) as db:
        event=db.execute("SELECT payload FROM run_events WHERE type='SETTINGS_PRIMARY_BOT_UPDATED' "
            "AND payload->>'reason'='deleted' AND payload->>'previousBotId'=%s",(first,)).fetchone()[0]
        assert event['primaryBotId'] is None and event['revision']==3


def test_primary_routing_mentions_nonmember_and_direct_are_unchanged(fixture):
    from openbot_server.conversations import PostgresConversationStore
    async def check():
        first,chief,other=raw_bot(fixture),raw_bot(fixture,role='Chief'),raw_bot(fixture)
        store=PostgresIdentityStore(fixture['dsn'])
        channel=await store.create_channel(fixture['token'],CreateChannelInput(name='Routing '+uuid4().hex,botIds=[first,chief]))
        preferences=WorkspaceSettings(fixture['dsn']); tasks=PostgresTaskStore(fixture['dsn'])
        await preferences.update(fixture['token'],dict(botId=first,expectedRevision=1))
        for body,expected in ((dict(content='No mention'),[first]),(dict(content='Explicit',botId=chief),[chief]),
                (dict(content='Two mentions',botIds=[chief,first]),[chief,first])):
            result=await tasks.submit(fixture['token'],channel.id,parse_message(body))
            assert [run.botId for run in result.runs or [result.run]]==expected
        await preferences.update(fixture['token'],dict(botId=other,expectedRevision=2))
        result=await tasks.submit(fixture['token'],channel.id,parse_message(dict(content='Primary outside channel')))
        assert [run.botId for run in result.runs or [result.run]]==[chief]
        direct=await PostgresConversationStore(fixture['dsn']).direct(fixture['token'],first)
        result=await tasks.submit(fixture['token'],direct.id,parse_message(dict(content='Direct conversation')))
        assert [run.botId for run in result.runs or [result.run]]==[first]
    asyncio.run(check())


def test_primary_mutation_is_observed_by_existing_workspace_sse(fixture,tmp_path,monkeypatch):
    from openbot_server import product_events
    from test_product_control import product_endpoints
    monkeypatch.setattr(product_events,'POLL_SECONDS',0)
    service=OwnerProduct(fixture['dsn'],object_root=tmp_path)
    endpoint=product_endpoints(fixture,service)['/api/v1/workspace/events']
    identity=raw_bot(fixture)
    async def check():
        request,_=stream_request(fixture['token'],'/api/v1/workspace/events')
        stream=(await endpoint(request)).body_iterator
        assert (await anext(stream)).startswith('event: workspace.ready\n')
        assert await anext(stream)==HEARTBEAT
        # Independent store/process: no in-memory product revision is required for invalidation.
        await WorkspaceSettings(fixture['dsn']).update(fixture['token'],dict(botId=identity,expectedRevision=1))
        assert (await anext(stream)).startswith('event: workspace.ready\n')
        assert await anext(stream)==HEARTBEAT
        await service.lifecycle.delete_bot(fixture['token'],identity)
        assert (await anext(stream)).startswith('event: workspace.ready\n')
        await stream.aclose()
    asyncio.run(check())


def test_primary_audit_failure_rolls_back_manual_create_import_and_delete(fixture,tmp_path):
    from openbot_server.database import StoreUnavailable
    from test_employee_portability import document,request,service
    first=raw_bot(fixture)
    asyncio.run(WorkspaceSettings(fixture['dsn']).update(fixture['token'],dict(botId=first,expectedRevision=1)))
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("CREATE FUNCTION c26_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type='SETTINGS_PRIMARY_BOT_UPDATED' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$")
        db.execute("CREATE TRIGGER c26_refuse_audit BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c26_refuse_audit()")
    try:
        client,_=api(fixture,tmp_path)
        with client:
            assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=None,expectedRevision=2)).status_code==503
            assert client.delete('/api/v1/bots/'+first).status_code==503
        assert state(fixture)==dict(primaryBotId=first,revision=2)
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT deleted_at FROM bots WHERE id=%s',(first,)).fetchone()==(None,)
            db.execute('UPDATE workspace_settings SET primary_bot_id=NULL,revision=1')
        name='Rollback '+uuid4().hex
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresIdentityStore(fixture['dsn']).create_bot(fixture['token'],CreateBotInput(name=name,role='assistant')))
        doc=document(); command=request(doc)
        with pytest.raises(StoreUnavailable): asyncio.run(service(fixture).activate(fixture['token'],command))
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM bots WHERE name=%s',(name,)).fetchone()==(0,)
            assert db.execute('SELECT count(*) FROM employee_import_receipts WHERE package_id=%s',(doc['payload']['packageId'],)).fetchone()==(0,)
        assert state(fixture)==dict(primaryBotId=None,revision=1)
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER c26_refuse_audit ON run_events')
            db.execute('DROP FUNCTION c26_refuse_audit()')


def test_audit_resolves_retained_bot_names_and_ignores_payload_name_hints(fixture,tmp_path):
    previous,current=raw_bot(fixture),raw_bot(fixture)
    client,_=api(fixture,tmp_path)
    with client:
        assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=previous,expectedRevision=1)).status_code==200
        assert client.put('/api/v1/workspace/primary-bot',json=dict(botId=current,expectedRevision=2)).status_code==200
        with psycopg.connect(fixture['dsn']) as db:
            # Old events resolve renamed and tombstoned subjects just like ordinary audit records.
            db.execute("UPDATE bots SET name='已改名的复核员',deleted_at=now() WHERE id=%s",(previous,))
            db.execute("UPDATE bots SET name='研究员' WHERE id=%s",(current,))
            db.execute("UPDATE run_events SET payload=payload || %s::jsonb WHERE type='SETTINGS_PRIMARY_BOT_UPDATED' "
                "AND payload->>'primaryBotId'=%s",(psycopg.types.json.Jsonb(dict(
                    **{'from':'Synthetic forged previous name','to':'Synthetic forged current name'},
                    apiKey='Synthetic audit private sentinel')),current))
        events=client.get('/api/v1/audit?category=settings').json()['events']
        selected=next(e for e in events if e['details'].get('primaryBotId')==current)
        assert selected['details']['from']=='已改名的复核员'
        assert selected['details']['to']=='研究员'
        assert selected['details']['previousBotId']==previous
        assert 'Synthetic forged' not in str(selected)
        assert 'Synthetic audit private sentinel' not in str(selected)
        initial=next(e for e in events if e['details'].get('primaryBotId')==previous)
        assert initial['details']['previousBotId'] is None
        assert 'from' not in initial['details']
        assert initial['details']['to']=='已改名的复核员'
