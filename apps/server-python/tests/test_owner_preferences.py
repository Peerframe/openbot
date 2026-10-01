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
