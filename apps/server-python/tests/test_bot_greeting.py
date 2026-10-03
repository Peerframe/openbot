"""Real Owner/PG/SDK C11 journey; synthetic transport only, never a paid model."""
import asyncio
import json
import threading
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx2
import psycopg
from psycopg.types.json import Jsonb
import pytest

from openbot_server.app import create_app
from openbot_server.bot_greeting import BotGreetings, GreetingFailure, plain_greeting
from openbot_server.database import PostgresReadStore
from openbot_server.identity_inputs import parse_quick_bot_create
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.model_connections_port import ModelConnectionPort
from openbot_server.product_control import OwnerProduct
from openbot_server.task_inputs import parse_message
from openbot_server.task_store import PostgresTaskStore
from test_model_connections import create, reply
from test_product_control import product_endpoints, stream_request

LOOK=dict(head='cat',body='classic',mobility='feet',accessory='none',accent='blue')
COMMAND=parse_quick_bot_create(dict(appearance=LOOK))
GREETING='你好，我刚加入团队。你希望我负责哪些任务？'


@pytest.fixture
def world(fixture):
    with psycopg.connect(fixture['dsn']) as db:
        before={row[0] for row in db.execute('SELECT id FROM bots')}
    connections=ModelConnectionsService(fixture['dsn'],ModelCredentialCipher(bytes(range(32))))
    selected=asyncio.run(connections.create(fixture['token'],create()))
    selection=dict(connectionId=selected['id'],modelId='test-model')
    with psycopg.connect(fixture['dsn']) as db:
        prior=db.execute("SELECT default_model FROM owner_preferences WHERE owner_id='owner'").fetchone()[0]
        db.execute("UPDATE owner_preferences SET default_model=%s WHERE owner_id='owner'",(Jsonb(selection),))
    yield dict(**fixture,connections=connections,selection=selection)
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("UPDATE owner_preferences SET default_model=%s WHERE owner_id='owner'",(Jsonb(prior) if prior else None,))
        ids=[row[0] for row in db.execute('SELECT id FROM bots') if row[0] not in before]
        channels=[row[0] for row in db.execute('SELECT id FROM channels WHERE direct_bot_id=ANY(%s)',(ids,))]
        db.execute('DELETE FROM run_events WHERE bot_id=ANY(%s) OR channel_id=ANY(%s)',(ids,channels))
        db.execute('DELETE FROM runs WHERE bot_id=ANY(%s)',(ids,))
        db.execute('DELETE FROM messages WHERE channel_id=ANY(%s)',(channels,))
        db.execute('DELETE FROM channel_bots WHERE channel_id=ANY(%s)',(channels,))
        db.execute('DELETE FROM channels WHERE id=ANY(%s)',(channels,))
        db.execute('DELETE FROM employee_evolution_events WHERE bot_id=ANY(%s)',(ids,))
        db.execute('DELETE FROM bots WHERE id=ANY(%s)',(ids,))
        db.execute('DELETE FROM model_connections WHERE id=%s',(selected['id'],))



def quick(world):
    return asyncio.run(PostgresIdentityStore(world['dsn'],model_connections=world['connections']).quick_create_bot(world['token'],COMMAND))


def service(world,handler):
    calls=[]
    async def transport(request):
        calls.append(json.loads(request.content))
        return await handler(request) if asyncio.iscoroutinefunction(handler) else handler(request)
    def factory(resolved,**options):
        return ModelConnectionPort(resolved,transport=httpx2.MockTransport(transport),**options)
    return BotGreetings(world['dsn'],world['connections'],model_factory=factory),calls


def response(text=GREETING,status=200):
    value=reply();value['choices'][0]['message']['content']=text
    return httpx2.Response(status,json=value)


def messages(world,channel):
    return asyncio.run(PostgresReadStore(world['dsn']).read(world['token'],'messages',channel_id=channel)).rows


def reasons(world,bot):
    with psycopg.connect(world['dsn']) as db:
        return [row[0]['reason'] for row in db.execute("SELECT payload FROM run_events WHERE bot_id=%s AND type='BOT_GREETING_FAILED'",(bot,))]


@pytest.mark.parametrize('value',['','hello?', '你喜欢什么颜色？', '我负责研究。你想做什么？还有什么？',
    '中'*121+'你想让我做什么？', '[OpenBot attachment: private]', '抱歉，我无法提供帮助。你需要做什么？'])
def test_invalid_or_refused_output_is_not_a_greeting(value):
    with pytest.raises(GreetingFailure):plain_greeting(value)


def test_plain_text_removes_markers_links_and_markdown():
    assert plain_greeting('### **你好**，[团队](https://synthetic.invalid)。[OpenBot attachment: secret]\n你希望我负责什么任务？')=='你好，团队。你希望我负责什么任务？'


def test_real_sdk_call_bounded_input_and_first_message_origin(world):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    with psycopg.connect(world['dsn']) as db:
        for n in range(15):
            db.execute("INSERT INTO bots(id,name,role,status,computer_profile) VALUES(%s,%s,%s,'idle','none')",
                (str(uuid4()),'Roster '+uuid4().hex,'角色'+str(n)))
    greeting,calls=service(world,lambda _:response('**你好**，[团队](https://synthetic.invalid)。你希望我负责哪些任务？'))
    asyncio.run(greeting.run(world['token'],bot,channel))
    rows=messages(world,channel)
    assert len(rows)==1 and rows[0]['origin']=='greeting' and rows[0]['author_id']==bot
    assert rows[0]['content']=='你好，团队。你希望我负责哪些任务？'
    assert len(calls)==1 and not calls[0].get('tools')
    assert calls[0]['max_tokens']==256
    prompts=calls[0]['messages'];assert len(prompts)==2
    payload=json.loads(prompts[1]['content']);assert set(payload)=={'name','others'}
    assert payload['name']==result['bot'].name and len(payload['others'])==12
    assert all(set(other)=={'name','role'} for other in payload['others'])
    assert all(other['name']!=payload['name'] for other in payload['others'])
    with psycopg.connect(world['dsn']) as db:
        audit=db.execute("SELECT payload FROM run_events WHERE bot_id=%s AND type='MESSAGE_CREATED'",(bot,)).fetchone()[0]
        assert audit==dict(messageId=rows[0]['id'],authorType='bot',origin='greeting')
    # Public HTTP projection carries origin, including explicit C18 paging.
    with TestClient(create_app(PostgresReadStore(world['dsn']),owner_name='Owner',secure_cookies=False)) as client:
        client.cookies.set('openbot_session',world['token'])
        assert client.get(f'/api/v1/channels/{channel}/messages?limit=20').json()['messages'][0]['origin']=='greeting'


@pytest.mark.parametrize('text,status',[(GREETING,500),('中'*121+'你希望我做什么？',200),('你好。',200),('抱歉，无法帮助你。你需要做什么？',200)])
def test_failures_never_write_or_retry(world,text,status):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    greeting,calls=service(world,lambda _:response(text,status))
    async def run():
        await greeting.run(world['token'],bot,channel)
        await greeting.run(world['token'],bot,channel)
    asyncio.run(run())
    assert len(calls)==1 and not messages(world,channel)
    assert len(reasons(world,bot))==1 and all(len(reason)<40 for reason in reasons(world,bot))


def test_real_fifteen_second_timeout_audits_and_does_not_retry(world):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    cancelled=[]
    async def slow(_request):
        try:await asyncio.sleep(30)
        finally:cancelled.append(True)
    greeting,calls=service(world,slow)
    start=time.monotonic();asyncio.run(greeting.run(world['token'],bot,channel));elapsed=time.monotonic()-start
    assert 14.8<=elapsed<18 and cancelled==[True]
    assert len(calls)==1 and not messages(world,channel) and reasons(world,bot)==['timeout']


def test_no_model_means_no_call_or_message(world):
    with psycopg.connect(world['dsn']) as db:db.execute("UPDATE owner_preferences SET default_model=NULL WHERE owner_id='owner'")
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    greeting,calls=service(world,lambda _:response())
    asyncio.run(greeting.run(world['token'],bot,channel))
    assert calls==[] and not messages(world,channel) and reasons(world,bot)==['model_unavailable']


def test_owner_send_during_model_call_wins_channel_lock(world):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    async def owner_first(_request):
        await PostgresTaskStore(world['dsn']).submit(world['token'],channel,parse_message(dict(content='请先帮我检查文件')))
        return response()
    greeting,calls=service(world,owner_first)
    asyncio.run(greeting.run(world['token'],bot,channel))
    rows=messages(world,channel)
    assert len(calls)==1 and len(rows)==1 and rows[0]['author_type']=='human' and rows[0]['origin'] is None
    assert reasons(world,bot)==['conversation_started']
    # Even deleting the message cannot erase the Owner's prior send audit.
    with psycopg.connect(world['dsn']) as db:db.execute('DELETE FROM messages WHERE channel_id=%s',(channel,))
    asyncio.run(greeting.run(world['token'],bot,channel));assert len(calls)==1 and not messages(world,channel)


def test_independent_services_get_only_one_model_attempt(world):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    one,first=service(world,lambda _:response());two,second=service(world,lambda _:response())
    async def run():await asyncio.gather(one.run(world['token'],bot,channel),two.run(world['token'],bot,channel))
    asyncio.run(run())
    assert len(first)+len(second)==1 and len(messages(world,channel))==1
    with psycopg.connect(world['dsn']) as db:
        with pytest.raises(psycopg.errors.UniqueViolation):
            db.execute("INSERT INTO messages(id,channel_id,author_type,author_id,origin,content) VALUES(%s,%s,'bot',%s,'greeting',%s)",(str(uuid4()),channel,bot,GREETING))


def test_quick_http_returns_before_model_and_ordinary_create_never_greets(world,tmp_path):
    entered=threading.Event();release=threading.Event()
    async def pending(_request):
        entered.set()
        while not release.is_set():await asyncio.sleep(.005)
        return response()
    greeting,calls=service(world,pending)
    product=OwnerProduct(world['dsn'],object_root=tmp_path,model_connections=world['connections']);product.greetings=greeting
    identity=PostgresIdentityStore(world['dsn'],model_connections=world['connections'])
    with TestClient(create_app(PostgresReadStore(world['dsn']),owner_name='Owner',secure_cookies=False,
        allowed_origins=('http://testserver',),identity=identity,product=product)) as client:
        client.cookies.set('openbot_session',world['token']);client.headers['Origin']='http://testserver'
        start=time.monotonic();created=client.post('/api/v1/bots/quick',json=dict(appearance=LOOK));elapsed=time.monotonic()-start
        assert created.status_code==201 and elapsed<2
        bot,channel=created.json()['bot']['id'],created.json()['channel']['id']
        assert entered.wait(2) and not messages(world,channel)
        assert client.post('/api/v1/bots/quick',json={'appearance':{}}).status_code==422
        assert client.post('/api/v1/bots',json=dict(name='Ordinary '+uuid4().hex,role='Role')).status_code==201
        assert len(calls)==1
        release.set()
        end=time.monotonic()+3
        while not messages(world,channel) and time.monotonic()<end:time.sleep(.02)
        assert len(messages(world,channel))==1


def test_normal_message_created_sse_carries_greeting(world,tmp_path,monkeypatch):
    from openbot_server import product_events
    monkeypatch.setattr(product_events,'POLL_SECONDS',0)
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    product=OwnerProduct(world['dsn'],object_root=tmp_path,model_connections=world['connections'])
    endpoint=product_endpoints(world,product)['/api/v1/channels/{channel_id}/events']
    greeting,_=service(world,lambda _:response())
    async def run():
        request,_=stream_request(world['token'],f'/api/v1/channels/{channel}/events')
        stream=(await endpoint(request,channel)).body_iterator
        assert (await anext(stream)).startswith('event: channel.ready')
        await greeting.run(world['token'],bot,channel)
        frame=await anext(stream);assert frame.startswith('event: message.created')
        payload=json.loads(frame.partition('data: ')[2]);assert payload['message']['origin']=='greeting'
        assert payload['message']['authorId']==bot and payload['message']['channelId']==channel
        assert (await anext(stream)).startswith('event: channel.ready')
        await stream.aclose()
    asyncio.run(run())


def test_owner_already_spoke_prevents_even_the_model_call(world):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    asyncio.run(PostgresTaskStore(world['dsn']).submit(world['token'],channel,parse_message(dict(content='请先检查文件'))))
    greeting,calls=service(world,lambda _:response())
    asyncio.run(greeting.run(world['token'],bot,channel))
    assert calls==[] and len(messages(world,channel))==1 and reasons(world,bot)==['conversation_started']


def test_model_disabled_during_call_prevents_message(world):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    def disabled(_request):
        with psycopg.connect(world['dsn']) as db:db.execute('UPDATE model_connections SET enabled=false,revision=revision+1 WHERE id=%s',(world['selection']['connectionId'],))
        return response()
    greeting,calls=service(world,disabled)
    asyncio.run(greeting.run(world['token'],bot,channel))
    assert len(calls)==1 and not messages(world,channel) and reasons(world,bot)==['operation_failed']


def test_message_audit_failure_rolls_back_greeting(world):
    result=quick(world);bot,channel=result['bot'].id,result['channel'].id
    with psycopg.connect(world['dsn']) as db:
        db.execute("CREATE FUNCTION reject_greeting_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type='MESSAGE_CREATED' AND NEW.payload->>'origin'='greeting' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$")
        db.execute('CREATE TRIGGER reject_greeting_message BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_greeting_message()')
    try:
        greeting,calls=service(world,lambda _:response())
        asyncio.run(greeting.run(world['token'],bot,channel))
        assert len(calls)==1 and not messages(world,channel) and reasons(world,bot)==['operation_failed']
    finally:
        with psycopg.connect(world['dsn']) as db:
            db.execute('DROP TRIGGER reject_greeting_message ON run_events')
            db.execute('DROP FUNCTION reject_greeting_message()')
