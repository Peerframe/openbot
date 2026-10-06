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


@pytest.fixture
def c28(fixture):
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
    with psycopg.connect(fixture['dsn'], row_factory=dict_row) as db:
        previous = db.execute("SELECT * FROM owner_preferences WHERE owner_id='owner'").fetchone()
        before = {r['id'] for r in db.execute('SELECT id FROM model_connections').fetchall()}
        receipts = {r['source_id'] for r in db.execute('SELECT source_id FROM legacy_model_imports').fetchall()}
        db.execute("UPDATE owner_preferences SET default_model=NULL,transcription_connection_id=NULL,revision=1 WHERE owner_id='owner'")
    connections = ModelConnectionsService(fixture['dsn'], ModelCredentialCipher(bytes(range(32))))
    yield connections
    with psycopg.connect(fixture['dsn'], row_factory=dict_row) as db:
        db.execute("UPDATE owner_preferences SET timezone=%s,default_model=%s,transcription_connection_id=%s,revision=%s,updated_at=%s WHERE owner_id='owner'",
            (previous['timezone'],None if previous['default_model'] is None else Jsonb(previous['default_model']),previous['transcription_connection_id'],previous['revision'],previous['updated_at']))
        after = {r['id'] for r in db.execute('SELECT id FROM model_connections').fetchall()}
        db.execute('DELETE FROM model_connections WHERE id=ANY(%s)', (list(after-before),))
        after_receipts = {r['source_id'] for r in db.execute('SELECT source_id FROM legacy_model_imports').fetchall()}
        db.execute('DELETE FROM legacy_model_imports WHERE source_id=ANY(%s)', (list(after_receipts-receipts),))


def test_c28_transcription_http_is_owner_only_revision_checked_and_keeps_general_preferences(fixture,c28,tmp_path):
    from openbot_server.transcription_settings import TranscriptionSettings
    async def create():
        return await c28.create(fixture['token'],dict(name='C28 OpenAI',presetId='openai',baseUrl='https://api.openai.com/v1',apiKey='synthetic-c28-key'))
    connection=asyncio.run(create())
    service=OwnerProduct(fixture['dsn'],object_root=tmp_path,model_connections=c28)
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,allowed_origins=('http://testserver',),product=service)
    path='/api/v1/settings/transcription';body=dict(expectedRevision=1,connectionId=connection['id']);headers={'Origin':'http://testserver'}
    with TestClient(app) as api:
        assert api.get(path).status_code==401
        assert api.put(path,json={},headers=headers).status_code==401
        api.cookies.set('openbot_session',fixture['token'])
        assert api.put(path,json=body).status_code==403
        assert api.put(path,json={**body,'apiKey':'must-not-accept'},headers=headers).status_code==422
        result=api.put(path,json=body,headers=headers)
        assert result.status_code==200 and result.json()==dict(revision=2,connectionId=connection['id'])
        assert 'synthetic-c28-key' not in result.text
        assert api.put(path,json=body,headers=headers).status_code==409
        assert api.put('/api/v1/settings/general',json=dict(expectedRevision=2,timezone='Asia/Singapore',defaultModel=None),headers=headers).status_code==200
        assert api.get(path).json()==dict(revision=3,connectionId=connection['id'])
        blocked=api.request('DELETE','/api/v1/model-connections/'+connection['id'],headers=headers,json=dict(expectedRevision=1))
        assert blocked.status_code==409 and blocked.json()['transcription'] is True
        assert api.put(path,json=dict(expectedRevision=3,connectionId=None),headers=headers).status_code==200
    assert asyncio.run(service.preferences.get(fixture['token']))['timezone']=='Asia/Singapore'


@pytest.mark.parametrize('preset,enabled',[('anthropic',True),('openai',False)])
def test_c28_transcription_rejects_ineligible_connections_and_has_no_implicit_fallback(fixture,c28,preset,enabled):
    from openbot_server.transcription_settings import TranscriptionSettings
    service=TranscriptionSettings(fixture['dsn'],c28)
    async def run():
        created=await c28.create(fixture['token'],dict(name='C28 ineligible',presetId=preset,baseUrl='https://api.anthropic.com' if preset=='anthropic' else 'https://api.openai.com/v1',apiKey='synthetic-c28-key'))
        if not enabled: await c28.update(fixture['token'],created['id'],dict(expectedRevision=1,enabled=False))
        with pytest.raises(ControlError):
            await service.update(fixture['token'],dict(expectedRevision=1,connectionId=created['id']))
        async with c28._transactions.transaction(fixture['token']) as db:
            with pytest.raises(ControlError,match='enabled_openai_transcription_required'): await service.resolve_in_transaction(db)
    asyncio.run(run())


@pytest.mark.parametrize('enabled',[False,True])
def test_c28_legacy_import_is_atomic_once_preserves_files_keys_and_opt_in(fixture,c28,tmp_path,enabled):
    import httpx2
    from openbot_server.model_settings import ModelSettingsService
    from openbot_server.legacy_model_import import import_legacy_model, import_legacy_path
    from openbot_server.database import StoreUnavailable
    legacy=ModelSettingsService(tmp_path.resolve()/'legacy',lambda request:httpx2.Response(200,json={'id':'fixture-model'}))
    asyncio.run(legacy.save(dict(provider='openai',model='fixture-model',apiKey='synthetic-c28-key',revision=None,agentEnabled=enabled)))
    ciphertext=legacy.path.read_bytes();key=(legacy.directory/'encryption.key').read_bytes()
    # A failed audit must leave no connection, receipt or default publication.
    with psycopg.connect(fixture['dsn']) as db:
        count=db.execute('SELECT count(*) FROM model_connections').fetchone()[0]
        db.execute("CREATE FUNCTION c28_reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='MODEL_CONNECTION_CREATED' AND NEW.payload->>'source'='legacy_migration' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$")
        db.execute('CREATE TRIGGER c28_reject_import BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c28_reject_import()')
    try:
        with pytest.raises(StoreUnavailable): asyncio.run(import_legacy_model(fixture['dsn'],legacy,c28))
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM model_connections').fetchone()[0]==count
            assert db.execute('SELECT count(*) FROM legacy_model_imports').fetchone()[0]==0
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER c28_reject_import ON run_events');db.execute('DROP FUNCTION c28_reject_import()')
    asyncio.run(import_legacy_model(fixture['dsn'],legacy,c28))
    asyncio.run(import_legacy_model(fixture['dsn'],legacy,c28))
    assert legacy.path.read_bytes()==ciphertext and (legacy.directory/'encryption.key').read_bytes()==key
    with psycopg.connect(fixture['dsn']) as db:
        identity=db.execute('SELECT connection_id FROM legacy_model_imports').fetchone()[0]
        assert db.execute('SELECT enabled FROM model_connections WHERE id=%s',(identity,)).fetchone()[0] is enabled
        default=db.execute("SELECT default_model FROM owner_preferences WHERE owner_id='owner'").fetchone()[0]
        assert default==(dict(connectionId=identity,modelId='fixture-model') if enabled else None)
        assert db.execute("SELECT transcription_connection_id FROM owner_preferences WHERE owner_id='owner'").fetchone()[0] is None
        assert db.execute('SELECT count(*) FROM model_connections').fetchone()[0]==count+1
        db.execute("UPDATE owner_preferences SET default_model=NULL WHERE owner_id='owner'")
    asyncio.run(c28.delete(fixture['token'],identity,dict(expectedRevision=1)))
    # Post-import startup does not consult unavailable old keys or recreate a deleted connection.
    (legacy.directory/'encryption.key').rename(legacy.directory/'retained-key.backup')
    asyncio.run(import_legacy_path(fixture['dsn'],c28,directory=legacy.directory))
    with psycopg.connect(fixture['dsn']) as db:
        assert db.execute('SELECT count(*) FROM model_connections WHERE id=%s',(identity,)).fetchone()[0]==0


def test_c28_import_keeps_an_existing_owner_default_and_empty_install_creates_no_legacy_key(fixture,c28,tmp_path):
    import httpx2
    from openbot_server.legacy_model_import import import_legacy_model, import_legacy_path
    from openbot_server.model_settings import ModelSettingsService
    async def run():
        existing=await c28.create(fixture['token'],dict(name='C28 existing',presetId='openai',baseUrl='https://api.openai.com/v1',apiKey='synthetic-existing-key'))
        selection=dict(connectionId=existing['id'],modelId='existing-model')
        prefs=OwnerPreferences(fixture['dsn'],model_connections=c28)
        await prefs.update(fixture['token'],dict(expectedRevision=1,timezone='UTC',defaultModel=selection))
        await import_legacy_path(fixture['dsn'],c28,directory=tmp_path/'empty')
        assert not (tmp_path/'empty').exists()
        legacy=ModelSettingsService(tmp_path/'old',lambda request:httpx2.Response(200,json={'id':'old-model'}))
        await legacy.save(dict(provider='openai',model='old-model',apiKey='synthetic-old-key',revision=None,agentEnabled=True))
        await import_legacy_model(fixture['dsn'],legacy,c28)
        assert (await prefs.get(fixture['token']))['defaultModel']==selection
    asyncio.run(run())
