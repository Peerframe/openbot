"""Real disposable SQL/HTTP counts expose metadata, never the referencing content."""
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
    app=create_app(PostgresReadStore(seed['dsn']),owner_name='Owner',secure_cookies=False,product=product)
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
