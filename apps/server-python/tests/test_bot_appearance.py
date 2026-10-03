"""C9 Owner/Origin, strict complete shape, shared revision and transactional audit."""
import asyncio
from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from openbot_server.app import create_app
from openbot_server.bot_appearance import AppearanceInput, AppearanceResult
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.identity_inputs import parse_bot_create
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.profile_details import PostgresProfileStore, ProfileConflict, parse_profile_details
from test_app import Store, TOKEN

LOOK = dict(head='round',body='classic',mobility='feet',accessory='none',accent='green')
VALUE = dict(expectedRevision=1,appearance=LOOK)


@pytest.fixture
def api():
    writer = AsyncMock()
    writer.update_appearance.return_value = AppearanceResult.model_validate(dict(
        bot=dict(id='bot',name='Bot',role='Role',status='idle',computerProfile='none',
                 appearance=LOOK,createdAt='2030-01-01T00:00:00.000Z'),revision=2))
    with TestClient(create_app(Store(),owner_name='Owner',profiles=writer,
                    allowed_origins=('https://control.test',)),base_url='https://control.test') as client:
        client.cookies.set('__Host-openbot_session',TOKEN)
        client.headers['Origin']='https://control.test'
        yield writer, client


def test_authority_precedes_validation_and_schema_is_complete(api):
    writer,client=api
    assert client.patch('/api/v1/bots/bot/appearance',json=VALUE,headers={'Origin':'null'}).status_code==403
    client.cookies.clear()
    assert client.patch('/api/v1/bots/bot/appearance',content='broken').status_code==401
    writer.update_appearance.assert_not_called()
    client.cookies.set('__Host-openbot_session',TOKEN)
    result=client.patch('/api/v1/bots/bot/appearance',json=VALUE)
    assert result.status_code==200 and result.json()['revision']==2
    schema=client.get('/openapi.json').json()['paths']['/api/v1/bots/{bot_id}/appearance']['patch']
    assert schema['security']==[{'OwnerSession':[]}]
    body=schema['requestBody']['content']['application/json']['schema']
    assert body['additionalProperties'] is False
    assert body['properties']['appearance']['additionalProperties'] is False


@pytest.mark.parametrize('value',[{**VALUE,'role':'admin'}, {'appearance':LOOK},
    {**VALUE,'appearance':{**LOOK,'unknown':True}}, {**VALUE,'appearance':{**LOOK,'accent':'orange'}},
    {**VALUE,'appearance':{key:v for key,v in LOOK.items() if key!='body'}},
    {**VALUE,'expectedRevision':True}, {**VALUE,'expectedRevision':'1'},
    {**VALUE,'expectedRevision':0}, {**VALUE,'expectedRevision':2**53},
    {**VALUE,'appearance':None}])
def test_invalid_input_never_reaches_writer(api,value):
    writer,client=api
    assert client.patch('/api/v1/bots/bot/appearance',json=value).status_code==422
    writer.update_appearance.assert_not_called()


def bot(fixture):
    return asyncio.run(PostgresIdentityStore(fixture['dsn']).create_bot(fixture['token'],
        parse_bot_create(dict(name='Appearance '+str(uuid4()),role='Role',appearance=LOOK))))


def test_real_http_noop_cas_deleted_and_audit(fixture):
    created=bot(fixture)
    writer=PostgresProfileStore(fixture['dsn'])
    with TestClient(create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',profiles=writer,
                    secure_cookies=False,allowed_origins=('http://control.test',)),base_url='http://control.test') as client:
        client.headers['Origin']='http://control.test'
        client.cookies.set('openbot_session',fixture['token'])
        url=f'/api/v1/bots/{created.id}/appearance'
        unchanged=client.patch(url,json=VALUE)
        assert unchanged.status_code==200 and unchanged.json()['revision']==1
        look={**LOOK,'head':'cat','accent':'slate'}
        result=client.patch(url,json={**VALUE,'appearance':look})
        assert result.status_code==200 and result.json()['revision']==2
        assert result.json()['bot']['appearance']==look
        assert client.patch(url,json=VALUE).status_code==409
        assert client.patch(url,json=dict(expectedRevision=2,appearance=look)).json()['revision']==2
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute("SELECT payload FROM run_events WHERE bot_id=%s AND type='EMPLOYEE_APPEARANCE_UPDATED'",(created.id,)).fetchall()==[
                (dict(actor='owner',**{'from':LOOK,'to':look},revision=2),)]
            assert db.execute('SELECT count(*) FROM employee_evolution_events WHERE bot_id=%s',(created.id,)).fetchone()==(1,)
            db.execute('UPDATE bots SET deleted_at=clock_timestamp() WHERE id=%s',(created.id,))
        assert client.patch(url,json=dict(expectedRevision=2,appearance=look)).status_code==404


def test_profile_and_appearance_compete_for_one_revision(fixture):
    created=bot(fixture)
    async def run():
        writer=PostgresProfileStore(fixture['dsn'])
        return await asyncio.gather(writer.update_appearance(fixture['token'],created.id,
            AppearanceInput.model_validate({**VALUE,'appearance':{**LOOK,'accent':'blue'}})),
            writer.update(fixture['token'],created.id,parse_profile_details(dict(role='Changed',description='',expectedRevision=1))),
            return_exceptions=True)
    results=asyncio.run(run())
    assert sum(isinstance(r,ProfileConflict) for r in results)==1


def test_audit_failure_rolls_back_appearance(fixture):
    created=bot(fixture)
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("CREATE FUNCTION reject_appearance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type='EMPLOYEE_APPEARANCE_UPDATED' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$")
        db.execute('CREATE TRIGGER reject_appearance BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_appearance()')
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresProfileStore(fixture['dsn']).update_appearance(fixture['token'],created.id,
                AppearanceInput.model_validate({**VALUE,'appearance':{**LOOK,'accent':'blue'}})))
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute("SELECT configuration->'appearance',profile_revision FROM bots WHERE id=%s",(created.id,)).fetchone()==(LOOK,1)
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute('DROP TRIGGER reject_appearance ON run_events')
            db.execute('DROP FUNCTION reject_appearance()')


def test_workspace_stream_invalidates_only_changed_bot_after_commit(fixture,tmp_path,monkeypatch):
    import json
    from openbot_server import product_events
    from test_product_control import product,product_endpoints,stream_request
    monkeypatch.setattr(product_events,'POLL_SECONDS',0)
    created=bot(fixture)
    service=product(fixture,tmp_path)
    endpoint=product_endpoints(fixture,service)['/api/v1/workspace/events']
    async def run():
        request,_=stream_request(fixture['token'],'/api/v1/workspace/events')
        stream=(await endpoint(request)).body_iterator
        assert (await anext(stream)).startswith('event: workspace.ready')
        writer=PostgresProfileStore(fixture['dsn'])
        await writer.update_appearance(fixture['token'],created.id,AppearanceInput.model_validate(VALUE))
        assert await anext(stream)==product_events.HEARTBEAT
        await writer.update_appearance(fixture['token'],created.id,
            AppearanceInput.model_validate({**VALUE,'appearance':{**LOOK,'accent':'red'}}))
        event=await anext(stream)
        assert event.startswith('event: employee.profile.changed')
        payload=json.loads(event.partition('data: ')[2])
        assert payload['botId']==created.id and payload['sections']==['identity']
        assert set(payload)=={'type','botId','sections','occurredAt'}
        assert (await anext(stream)).startswith('event: workspace.ready')
        await stream.aclose()
    asyncio.run(run())
