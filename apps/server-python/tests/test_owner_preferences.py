"""Real Server preferences/default inheritance, optimistic writes and atomic audit rollback."""
import asyncio
from uuid import uuid4

import psycopg
from pydantic import ValidationError
from fastapi.testclient import TestClient
import pytest

from openbot_server.app import create_app
from openbot_server.control_errors import ControlError
from openbot_server.database import PostgresReadStore
from openbot_server.identity_inputs import CreateBotInput
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.owner_preferences import OwnerPreferences,PreferencesInput
from openbot_server.product_control import OwnerProduct


@pytest.mark.parametrize('timezone',['Asia/Singapore','UTC','Europe/London','Etc/GMT+8'])
def test_iana_timezone(timezone):
    assert PreferencesInput.model_validate(dict(expectedRevision=1,timezone=timezone,defaultModel=None)).timezone==timezone


@pytest.mark.parametrize('value',[dict(expectedRevision=True,timezone='UTC',defaultModel=None),dict(expectedRevision=1,timezone='Etc/../UTC',defaultModel=None),dict(expectedRevision=1,timezone='Unknown/Zone',defaultModel=None),dict(expectedRevision=1,timezone='/etc/passwd',defaultModel=None)])
def test_invalid_timezone_and_revision(value):
    with pytest.raises(ValidationError):PreferencesInput.model_validate(value)


@pytest.fixture
def preferences(fixture):
    with psycopg.connect(fixture['dsn']) as db:
        before=db.execute("SELECT timezone,default_model,revision,updated_at FROM owner_preferences WHERE owner_id='owner'").fetchone()
        db.execute("UPDATE owner_preferences SET timezone='UTC',default_model=NULL,revision=1 WHERE owner_id='owner'")
    try:yield
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE owner_preferences SET timezone=%s,default_model=%s,revision=%s,updated_at=%s WHERE owner_id='owner'",(before[0],None if before[1] is None else psycopg.types.json.Jsonb(before[1]),before[2],before[3]))
            db.execute("DELETE FROM run_events WHERE type='SETTINGS_OWNER_UPDATED'")


def test_real_general_settings_http_and_audit_rollback(fixture,preferences,tmp_path):
    product=OwnerProduct(fixture['dsn'],object_root=tmp_path)
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,allowed_origins=('http://testserver',),product=product)
    with TestClient(app) as api:
        assert api.get('/api/v1/settings/general').status_code==401
        api.cookies.set('openbot_session',fixture['token'])
        before=api.get('/api/v1/settings/general');assert before.status_code==200,before.text
        assert before.json()['timezone']=='UTC' and before.json()['defaultModel'] is None
        body=dict(expectedRevision=1,timezone='Asia/Singapore',defaultModel=None)
        assert api.put('/api/v1/settings/general',json=body).status_code==403
        headers={'Origin':'http://testserver'}
        changed=api.put('/api/v1/settings/general',json=body,headers=headers);assert changed.status_code==200,changed.text
        assert changed.json()['revision']==2
        assert api.put('/api/v1/settings/general',json=body,headers=headers).status_code==409
        assert api.put('/api/v1/settings/general',json={**body,'expectedRevision':2,'timezone':'Unknown/Zone'},headers=headers).status_code==422
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("CREATE FUNCTION c7_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='SETTINGS_OWNER_UPDATED' THEN RAISE EXCEPTION 'private failure'; END IF; RETURN NEW; END $$")
            db.execute("CREATE TRIGGER c7_reject_audit BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c7_reject_audit()")
        try:
            assert api.put('/api/v1/settings/general',json={**body,'expectedRevision':2,'timezone':'UTC'},headers=headers).status_code==503
            assert api.get('/api/v1/settings/general').json()==changed.json()
        finally:
            with psycopg.connect(fixture['dsn']) as db:
                db.execute('DROP TRIGGER c7_reject_audit ON run_events');db.execute('DROP FUNCTION c7_reject_audit()')


def test_default_applies_only_to_new_model_profiles_and_explicit_selection_wins(fixture,preferences):
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    service=OwnerPreferences(fixture['dsn'],model_connections=connections)
    store=PostgresIdentityStore(fixture['dsn'],model_connections=connections)
    ids=[];connection=None
    async def run():
        nonlocal connection
        connection=await connections.create(fixture['token'],dict(name='C7 fixture '+uuid4().hex,presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey='synthetic-fixture-key'))
        selection=dict(connectionId=connection['id'],modelId='fixture-default')
        value=await service.update(fixture['token'],dict(expectedRevision=1,timezone='UTC',defaultModel=selection))
        assert value['defaultModel']==selection
        for profile,explicit in [('model',None),('docker-linux',None),('none',None),('model','fixture-explicit')]:
            body=dict(name='C7 '+uuid4().hex,role='Fixture',computerProfile=profile)
            if explicit is not None:body['model']={**selection,'modelId':explicit}
            bot=await store.create_bot(fixture['token'],CreateBotInput.model_validate(body));ids.append(bot.id)
            with psycopg.connect(fixture['dsn']) as db:configuration=db.execute('SELECT configuration FROM bots WHERE id=%s',(bot.id,)).fetchone()[0]
            if profile=='none':assert 'model' not in configuration
            else:assert configuration['model']=={**selection,'modelId':explicit or 'fixture-default'}
        await connections.update(fixture['token'],connection['id'],dict(expectedRevision=1,enabled=False))
        with pytest.raises(ControlError,match='model_connection_disabled'):
            await store.create_bot(fixture['token'],CreateBotInput(name='C7 disabled '+uuid4().hex,role='Fixture',computerProfile='model'))
        assert (await service.get(fixture['token']))['defaultModel']==selection
    try:asyncio.run(run())
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DELETE FROM run_events WHERE bot_id=ANY(%s)',(ids,));db.execute('DELETE FROM employee_evolution_events WHERE bot_id=ANY(%s)',(ids,));db.execute('DELETE FROM bots WHERE id=ANY(%s)',(ids,))
            if connection:
                db.execute('DELETE FROM model_connections WHERE id=%s',(connection['id'],))
                db.execute("DELETE FROM run_events WHERE payload->>'id'=%s",(connection['id'],))


def test_simultaneous_preferences_revision_has_exactly_one_winner(fixture,preferences):
    async def run():
        service=OwnerPreferences(fixture['dsn'])
        values=await asyncio.gather(*(service.update(fixture['token'],dict(expectedRevision=1,timezone=zone,defaultModel=None)) for zone in ['Asia/Singapore','Europe/London']),return_exceptions=True)
        assert sum(isinstance(value,ControlError) and value.status==409 for value in values)==1
        assert sum(isinstance(value,dict) and value['revision']==2 for value in values)==1
    asyncio.run(run())


@pytest.mark.parametrize('response', [200,401,302])
def test_c17_unsaved_verification_is_one_get_and_never_persists(fixture,tmp_path,caplog,response):
    import httpx2
    import json
    from openbot_server.model_connections_inputs import VerifyModelConnectionInput
    key='unsaved-fixture-secret-'+uuid4().hex
    calls=[]
    def provider(request):
        calls.append(request)
        assert request.method=='GET' and request.url.path=='/v1/models'
        assert request.headers['Authorization']=='Bearer '+key
        assert not request.content
        return httpx2.Response(response,json={'data':[{'id':'fixture-model'},{'id':key}]},headers={'location':'https://bad.example/models'})
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))),transport_factory=lambda:httpx2.MockTransport(provider))
    product=OwnerProduct(fixture['dsn'],object_root=tmp_path,model_connections=connections)
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,allowed_origins=('http://testserver',),product=product)
    value=dict(presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey=key)
    assert key not in repr(VerifyModelConnectionInput.model_validate(value))
    with psycopg.connect(fixture['dsn']) as db:
        before=db.execute('SELECT count(*) FROM model_connections').fetchone()[0]
        audits=db.execute('SELECT count(*) FROM run_events').fetchone()[0]
    with TestClient(app) as api:
        assert api.post('/api/v1/model-connections/verify',json=value,headers={'Origin':'http://testserver'}).status_code==401
        api.cookies.set('openbot_session',fixture['token'])
        assert api.post('/api/v1/model-connections/verify',json=value).status_code==403
        result=api.post('/api/v1/model-connections/verify',json=value,headers={'Origin':'http://testserver'})
        assert result.status_code==(200 if response==200 else 422),result.text
        if response==200: assert result.json()=={'models':['fixture-model']}
        assert key not in result.text and key not in caplog.text
        invalid=api.post('/api/v1/model-connections/verify',json={**value,'baseUrl':'https://unapproved.example/v1'},headers={'Origin':'http://testserver'})
        assert invalid.status_code==422
        malformed=api.post('/api/v1/model-connections/verify',json={**value,'apiKey':'PRIVATE SPACE KEY'},headers={'Origin':'http://testserver'})
        assert malformed.status_code==422 and 'PRIVATE' not in malformed.text
    assert len(calls)==1
    with psycopg.connect(fixture['dsn']) as db:
        assert db.execute('SELECT count(*) FROM model_connections').fetchone()[0]==before
        assert db.execute('SELECT count(*) FROM run_events').fetchone()[0]==audits
        assert not db.execute("SELECT 1 FROM run_events WHERE payload::text LIKE %s",('%'+key+'%',)).fetchone()
    assert not list(tmp_path.glob('**/*key*'))


def test_c17_connection_default_cas_clear_and_safe_delete(fixture,preferences,tmp_path):
    from openbot_server.identity_inputs import CreateBotInput
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    async def check():
        created=await connections.create(fixture['token'],dict(name='C17 '+uuid4().hex,presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey='synthetic-fixture-key'))
        updated=await connections.update(fixture['token'],created['id'],dict(expectedRevision=1,defaultModel='fixture-default'))
        assert updated['defaultModel']=='fixture-default' and updated['revision']==2
        with pytest.raises(ControlError,match='revision_conflict'):
            await connections.update(fixture['token'],created['id'],dict(expectedRevision=1,defaultModel=None))
        cleared=await connections.update(fixture['token'],created['id'],dict(expectedRevision=2,defaultModel=None))
        assert 'defaultModel' not in cleared and cleared['revision']==3
        owner=OwnerPreferences(fixture['dsn'],model_connections=connections)
        await owner.update(fixture['token'],dict(expectedRevision=1,timezone='UTC',defaultModel=dict(connectionId=created['id'],modelId='fixture-model')))
        return created
    created=asyncio.run(check())
    product=OwnerProduct(fixture['dsn'],object_root=tmp_path,model_connections=connections)
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,allowed_origins=('http://testserver',),product=product)
    with TestClient(app) as api:
        api.cookies.set('openbot_session',fixture['token'])
        base='/api/v1/model-connections/'+created['id'];headers={'Origin':'http://testserver'}
        assert api.delete(base,headers=headers).status_code==422
        assert api.request('DELETE',base,json={'expectedRevision':1},headers=headers).status_code==409
        default=api.request('DELETE',base,json={'expectedRevision':3},headers=headers)
        assert default.status_code==409 and default.json()['ownerDefault'] is True and default.json()['bots']==[]
        asyncio.run(product.preferences.update(fixture['token'],dict(expectedRevision=2,timezone='UTC',defaultModel=None)))
        bot=asyncio.run(PostgresIdentityStore(fixture['dsn'],model_connections=connections).create_bot(fixture['token'],
            CreateBotInput(name='C17 Bot '+uuid4().hex,role='fixture',computerProfile='model',model=dict(connectionId=created['id'],modelId='fixture-model'))))
        blocked=api.request('DELETE',base,json={'expectedRevision':3},headers=headers)
        assert blocked.status_code==409 and blocked.json()['bots']==[dict(id=bot.id,name=bot.name)]
        asyncio.run(connections.update_employee_model(fixture['token'],bot.id,dict(expectedRevision=1,model=None)))
        removed=api.request('DELETE',base,json={'expectedRevision':3},headers=headers)
        assert removed.status_code==200 and removed.json()==dict(deleted=True,connectionId=created['id'])
        assert api.request('DELETE',base,json={'expectedRevision':3},headers=headers).status_code==404
        assert api.request('DELETE','/api/v1/model-connections/legacy-kimi',json={'expectedRevision':1},headers=headers).status_code==422
    with psycopg.connect(fixture['dsn']) as db:
        assert db.execute("SELECT count(*) FROM run_events WHERE type='MODEL_CONNECTION_DELETED' AND payload->>'id'=%s",(created['id'],)).fetchone()[0]==1


def test_c17_concurrent_default_updates_have_one_winner(fixture):
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    async def check():
        created=await connections.create(fixture['token'],dict(name='C17 race '+uuid4().hex,presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey='synthetic-fixture-key'))
        results=await asyncio.gather(*(connections.update(fixture['token'],created['id'],dict(expectedRevision=1,defaultModel=model)) for model in ['one','two']),return_exceptions=True)
        assert sum(isinstance(r,dict) for r in results)==1
        assert sum(isinstance(r,ControlError) and r.status==409 for r in results)==1
    asyncio.run(check())



def test_c17_delete_refuses_active_run_and_rolls_back_failed_audit(fixture):
    from openbot_server.model_connections import ModelConnectionInUse
    from openbot_server.database import StoreUnavailable
    from psycopg.types.json import Jsonb
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    created=asyncio.run(connections.create(fixture['token'],dict(name='C17 rollback '+uuid4().hex,presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey='synthetic-fixture-key')))
    bot=asyncio.run(PostgresIdentityStore(fixture['dsn'],model_connections=connections).create_bot(fixture['token'],CreateBotInput(name='C17 run '+uuid4().hex,role='fixture',computerProfile='model')))
    run_id=str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO runs(id,bot_id,channel_id,execution_profile,model_selection,instruction,title,status) VALUES(%s,%s,%s,'model',%s,'fixture','fixture','queued')",(run_id,bot.id,fixture['channelId'],Jsonb(dict(connectionId=created['id'],modelId='fixture-model'))))
    with pytest.raises(ModelConnectionInUse) as error:
        asyncio.run(connections.delete(fixture['token'],created['id'],dict(expectedRevision=1)))
    assert error.value.public['runIds']==[run_id] and error.value.public['bots']==[]
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("UPDATE runs SET status='cancelled' WHERE id=%s",(run_id,))
        db.execute("CREATE FUNCTION c17_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='MODEL_CONNECTION_DELETED' THEN RAISE EXCEPTION 'private fixture error'; END IF; RETURN NEW; END $$")
        db.execute('CREATE TRIGGER c17_reject_delete BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c17_reject_delete()')
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(connections.delete(fixture['token'],created['id'],dict(expectedRevision=1)))
        assert asyncio.run(connections.resolve(fixture['token'],dict(connectionId=created['id'],modelId='fixture-model'))).connection_id==created['id']
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER c17_reject_delete ON run_events');db.execute('DROP FUNCTION c17_reject_delete()')
    assert asyncio.run(connections.delete(fixture['token'],created['id'],dict(expectedRevision=1)))['deleted']


def test_c17_delete_fails_closed_on_corrupt_bot_reference(fixture):
    from psycopg.types.json import Jsonb
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    created=asyncio.run(connections.create(fixture['token'],dict(name='C17 corrupt '+uuid4().hex,presetId='kimi',baseUrl='https://api.moonshot.cn/v1',apiKey='synthetic-fixture-key')))
    bot=asyncio.run(PostgresIdentityStore(fixture['dsn']).create_bot(fixture['token'],CreateBotInput(name='C17 corrupt '+uuid4().hex,role='fixture')))
    try:
        for reference in [{'unexpected':'invalid'}, {'unexpected':'x'*4096}]:
            with psycopg.connect(fixture['dsn']) as db:
                db.execute('UPDATE bots SET configuration=%s WHERE id=%s',(Jsonb({'model':reference}),bot.id))
            with pytest.raises(ControlError,match='model_dependencies_unavailable'):
                asyncio.run(connections.delete(fixture['token'],created['id'],dict(expectedRevision=1)))
            assert asyncio.run(connections.resolve(fixture['token'],dict(connectionId=created['id'],modelId='fixture-model'))).connection_id==created['id']
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE bots SET configuration='{}'::jsonb WHERE id=%s",(bot.id,))
    assert asyncio.run(connections.delete(fixture['token'],created['id'],dict(expectedRevision=1)))['deleted']
