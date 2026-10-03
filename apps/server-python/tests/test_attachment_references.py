"""Real disposable SQL/HTTP checks for scoped counts and bounded Owner reference previews."""
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore
from openbot_server.product_control import OwnerProduct
from test_automation_store import synthetic_db  # noqa: F401


@pytest.fixture
def seed(synthetic_db):
    bot,peer,channel=[str(uuid4()) for _ in range(3)]
    with psycopg.connect(synthetic_db["dsn"]) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES (%s,%s,'Fixture','none'),(%s,%s,'Fixture','none')", (bot,"Count "+bot,peer,"Peer "+peer))
        db.execute("INSERT INTO channels(id,name) VALUES (%s,'Count fixture')",(channel,))
        db.execute("INSERT INTO channel_bots(channel_id,bot_id) VALUES (%s,%s),(%s,%s)",(channel,bot,channel,peer))
    value={**synthetic_db,"bot":bot,"peer":peer,"channel":channel}
    yield value
    with psycopg.connect(synthetic_db["dsn"]) as db:
        db.execute("DELETE FROM run_events WHERE channel_id=%s",(channel,))
        db.execute("DELETE FROM work_sources WHERE channel_id=%s",(channel,))
        db.execute("DELETE FROM work_tasks WHERE bot_id=ANY(%s)",([bot,peer],))
        db.execute("DELETE FROM runs WHERE channel_id=%s",(channel,))
        db.execute("DELETE FROM messages WHERE channel_id=%s",(channel,))
        db.execute("DELETE FROM channel_bots WHERE channel_id=%s",(channel,))
        db.execute("DELETE FROM channels WHERE id=%s",(channel,))
        db.execute("DELETE FROM bots WHERE id=ANY(%s)",([bot,peer],))
        if value.get('foreignChannel'):
            db.execute("DELETE FROM messages WHERE channel_id=%s",(value['foreignChannel'],))
            db.execute("DELETE FROM channels WHERE id=%s",(value['foreignChannel'],))


def setup(seed, tmp_path):
    (tmp_path/'attachments').mkdir(mode=0o700)
    product=OwnerProduct(seed['dsn'],object_root=tmp_path)
    item=product.files.persist(seed['channel'],'fixture.txt',b'Synthetic file')
    unused=product.files.persist(seed['channel'],'unused.txt',b'No refs')
    marker=f"[OpenBot attachment: {item['id']}]"
    first,second,other,run1,run2,child,task=[str(uuid4()) for _ in range(7)]
    seed['foreignChannel']=other
    with psycopg.connect(seed['dsn']) as db:
        db.execute("INSERT INTO channels(id,name) VALUES (%s,%s)",(other,'Other '+other))
        for identity,channel,body in [(first,seed['channel'],'PRIVATE_BODY '+marker+' '+marker),
            (second,seed['channel'],marker.upper()),(str(uuid4()),other,marker),
            (str(uuid4()),seed['channel'],item['id'])]:
            db.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES (%s,%s,'human',%s)",(identity,channel,body))
        for identity,bot,parent,status in [(run1,seed['bot'],None,'completed'),(run2,seed['peer'],None,'queued'),(child,seed['bot'],run1,'queued')]:
            db.execute("INSERT INTO runs(id,channel_id,bot_id,title,instruction,status,parent_run_id,root_run_id,delegated_by_bot_id) VALUES (%s,%s,%s,'PRIVATE_TASK',%s,%s,%s,%s,%s)",
                (identity,seed['channel'],bot,marker+' '+marker,status,parent,parent,seed['peer'] if parent else None))
        db.execute("UPDATE runs SET source_message_id=%s WHERE id IN (%s,%s)",(first,run1,run2))
        # Work mapping must not double count the retained channel task identity.
        db.execute("INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit) VALUES (%s,'owner',%s,%s,%s,%s,0)",
            (task,seed['bot'],task,'a'*64,marker))
        db.execute('INSERT INTO work_sources(task_id,legacy_run_id,channel_id,source_message_id) VALUES (%s,%s,%s,%s)',(task,run1,seed['channel'],first))
    app=create_app(PostgresReadStore(seed['dsn']),owner_name='Owner',secure_cookies=False,
        allowed_origins=('http://testserver',),product=product)
    return product,item,unused,other,TestClient(app)


def test_exact_reference_counts_are_channel_scoped_distinct_and_owner_only(seed,tmp_path):
    product,item,unused,other,api=setup(seed,tmp_path)
    route=f"/api/v1/channels/{seed['channel']}/attachments"
    with api:
        assert api.get(route).status_code==401
        api.cookies.set('openbot_session',seed['token'])
        response=api.get(route)
        assert response.status_code==200,response.text
        values={value['id']:value for value in response.json()['attachments']}
        assert values[item['id']]['referenceCount']==dict(messages=2,tasks=3)
        assert values[unused['id']]['referenceCount']==dict(messages=0,tasks=0)
        assert 'PRIVATE_BODY' not in response.text and 'PRIVATE_TASK' not in response.text
        assert api.get(f'/api/v1/channels/{other}/attachments').json()=={'attachments':[]}
        product.files.set_deleted(seed['channel'],item['id'],True)
        recycled={value['id']:value for value in api.get(route).json()['attachments']}[item['id']]
        assert recycled['deletedAt'] and recycled['referenceCount']==dict(messages=2,tasks=3)
        assert 'referenceCount' not in api.get(route+'/'+item['id']).json()['attachment']
        with psycopg.connect(seed['dsn']) as db: db.execute('UPDATE channels SET deleted_at=now() WHERE id=%s',(seed['channel'],))
        assert api.get(route).status_code==404


def test_overflow_never_returns_partial_or_capped_counts(seed,tmp_path,monkeypatch):
    from openbot_server import attachment_references
    monkeypatch.setattr(attachment_references,'REFERENCE_LIMIT',1)
    _,_,_,_,api=setup(seed,tmp_path)
    with api:
        api.cookies.set('openbot_session',seed['token'])
        response=api.get(f"/api/v1/channels/{seed['channel']}/attachments")
        assert response.status_code==503 and 'attachment_reference_limit' in response.text
        assert 'attachments' not in response.json() and 'PRIVATE' not in response.text


def test_final_owner_recheck_withholds_reference_metadata(seed,tmp_path,monkeypatch):
    import hashlib
    from openbot_server import product_attachment_routes
    _,_,_,_,api=setup(seed,tmp_path)
    original=product_attachment_routes.with_reference_counts
    async def revoke_after_read(db,channel,items):
        result=await original(db,channel,items)
        await db.execute('UPDATE auth_sessions SET revoked_at=now() WHERE token_digest=%s',
            (hashlib.sha256(seed['token'].encode()).hexdigest(),))
        return result
    monkeypatch.setattr(product_attachment_routes,'with_reference_counts',revoke_after_read)
    with api:
        api.cookies.set('openbot_session',seed['token'])
        response=api.get(f"/api/v1/channels/{seed['channel']}/attachments")
        assert response.status_code==401 and 'attachments' not in response.json()


def test_reference_lists_keep_c19_matching_order_identity_and_short_previews(seed,tmp_path):
    product,item,unused,other,api=setup(seed,tmp_path)
    route=f"/api/v1/channels/{seed['channel']}/attachments/{item['id']}/references"
    bot_message,system_message = str(uuid4()),str(uuid4())
    marker=f"[OpenBot attachment: {item['id']}]"
    with psycopg.connect(seed['dsn']) as db:
        db.execute("INSERT INTO messages(id,channel_id,author_type,author_id,content) VALUES(%s,%s,'bot',%s,%s),(%s,%s,'system',NULL,%s)",
            (bot_message,seed['channel'],seed['bot'],marker+'😀'*130+f"[OPENBOT ATTACHMENT: {unused['id']}]",
             system_message,seed['channel'],'Scheduled '+marker.upper()))
        db.execute("UPDATE messages SET created_at='2026-10-03T00:00:00Z' WHERE channel_id=%s",(seed['channel'],))
        db.execute("UPDATE runs SET created_at='2026-10-03T00:00:00Z' WHERE channel_id=%s",(seed['channel'],))
    with api:
        assert api.get(route).status_code==401
        api.cookies.set('openbot_session',seed['token'])
        response=api.get(route)
        assert response.status_code==200,response.text
        result=response.json()
        assert set(result)=={'messages','tasks','messageCount','taskCount','hasMore'}
        assert result['messageCount']==4 and result['taskCount']==3 and result['hasMore'] is False
        assert [m['id'] for m in result['messages']]==sorted((m['id'] for m in result['messages']),reverse=True)
        assert [r['runId'] for r in result['tasks']]==sorted((r['runId'] for r in result['tasks']),reverse=True)
        by_id={m['id']:m for m in result['messages']}
        assert by_id[bot_message]['author']==dict(kind='bot',botId=seed['bot'])
        assert by_id[bot_message]['preview']=='😀'*120
        assert by_id[system_message]['author']==dict(kind='system')
        assert by_id[system_message]['preview']=='Scheduled'
        for value in result['messages']:
            assert set(value)=={'id','createdAt','author','preview'}
            assert len(value['preview'])<=120 and '[openbot attachment:' not in value['preview'].lower()
        for value in result['tasks']: assert set(value)=={'runId','title','status','createdAt'}
        assert {value['status'] for value in result['tasks']}=={'queued','completed'}
        limited=api.get(route+'?limit=1').json()
        assert limited=={**result,'messages':result['messages'][:1],'tasks':result['tasks'][:1],'hasMore':True}
        product.files.set_deleted(seed['channel'],item['id'],True)
        assert api.get(route).json()==result
        assert api.get(route.replace(seed['channel'],other)).status_code==404


def test_reference_list_query_limits_gone_files_and_unknown_counts_fail_closed(seed,tmp_path,monkeypatch):
    from openbot_server import attachment_references
    product,item,unused,_,api=setup(seed,tmp_path)
    base=f"/api/v1/channels/{seed['channel']}/attachments/"
    route=base+item['id']+'/references'
    with api:
        api.cookies.set('openbot_session',seed['token'])
        for query in ('limit=0','limit=101','limit=-1','limit=1.5','limit=','limit=20&limit=20','offset=1','limit=２０'):
            response=api.get(route+'?'+query)
            assert response.status_code==422,response.text
            assert 'messages' not in response.json()
        assert api.get(route+'?limit=100').status_code==200
        assert api.get(base+str(uuid4())+'/references').status_code==404
        assert api.get(base+unused['id']+'/references').json()==dict(messages=[],tasks=[],messageCount=0,taskCount=0,hasMore=False)
        product.files.set_deleted(seed['channel'],unused['id'],True)
        assert api.delete(base+unused['id']+'/purge',headers={'Origin':'http://testserver'}).status_code==200
        gone=api.get(base+unused['id']+'/references')
        assert gone.status_code==410 and 'messages' not in gone.json()
        monkeypatch.setattr(attachment_references,'REFERENCE_LIMIT',1)
        refused=api.get(route)
        assert refused.status_code==503 and refused.json()=={'error':'attachment_reference_limit'}


def test_reference_list_rechecks_owner_before_releasing_content(seed,tmp_path,monkeypatch):
    import hashlib
    from openbot_server import product_attachment_routes
    _,item,_,_,api=setup(seed,tmp_path)
    original=product_attachment_routes.reference_list
    async def revoke_after_read(db,*args):
        result=await original(db,*args)
        await db.execute('UPDATE auth_sessions SET revoked_at=now() WHERE token_digest=%s',
            (hashlib.sha256(seed['token'].encode()).hexdigest(),))
        return result
    monkeypatch.setattr(product_attachment_routes,'reference_list',revoke_after_read)
    with api:
        api.cookies.set('openbot_session',seed['token'])
        response=api.get(f"/api/v1/channels/{seed['channel']}/attachments/{item['id']}/references")
        assert response.status_code==401 and 'PRIVATE' not in response.text and 'messages' not in response.json()
