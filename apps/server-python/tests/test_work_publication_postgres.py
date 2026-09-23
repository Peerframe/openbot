"""Publication authority with owned PostgreSQL, real private files and an actual HTTP process."""
import asyncio
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from uuid import uuid4

import httpx
import psycopg
import pytest

from openbot_server.database import StoreUnavailable
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import WorkConflict


def service(fixture,tmp_path):
    tmp_path.chmod(0o700)
    return PostgresWorkStore(fixture['dsn'],files=LocalWorkFiles(tmp_path))


async def task_and_claim(fixture,store):
    task = await store.create(fixture['token'],bot_id=fixture['expected']['/api/v1/bots']['bots'][0]['id'],
        objective='Correct row 7',token_limit=20,request_key=str(uuid4()))
    fence = await store.claim(task['id'],task['runs'][0]['id'],'execution-one')
    return task,fence


def proof():
    return {'source':'owned-csv-verifier','reference':'row-7-check','sha256':hashlib.sha256(b'7,fixed').hexdigest()}


def artifact(data=b'row,value\n7,fixed\n'):
    return {'key':'result','name':'修正结果.csv','mediaType':'text/csv','data':data}


async def publish(fixture,store,task,fence,**changes):
    snap = await store.snapshot(fixture['token'],task['id'])
    args=dict(fence=fence,expected_revision=snap['revision'],summary='Row 7 verified.',
              artifacts=[artifact()],verification=proof())
    args.update(changes)
    return await store.complete(task['id'],task['runs'][0]['id'],**args)


def test_new_attempt_fences_stale_proposal_admission_and_publication(fixture,tmp_path):
    async def check():
        store=service(fixture,tmp_path);task,first=await task_and_claim(fixture,store)
        identity=await store.propose(task['id'],first.run_id,fence=first,action_key='update',
            intent={'row':7},reserved_tokens=4,requires_approval=False)
        second=await store.claim(task['id'],first.run_id,'execution-two')
        assert second.epoch == first.epoch+1
        assert await store.claim(task['id'],first.run_id,'execution-two') == second
        with pytest.raises(WorkConflict,match='execution_claim_stale'):
            await store.claim(task['id'],first.run_id,'execution-one')
        with pytest.raises(WorkConflict,match='execution_claim_stale'):
            await store.propose(task['id'],first.run_id,fence=first,action_key='late',intent={'row':8},reserved_tokens=4)
        with pytest.raises(WorkConflict,match='execution_claim_stale'):
            await store.admit(identity,fence=first)
        with pytest.raises(WorkConflict,match='execution_claim_stale'):
            await publish(fixture,store,task,first)
        assert await store.admit(identity,fence=second)
        assert not await store.admit(identity,fence=second)
        snap=await store.snapshot(fixture['token'],task['id']);assert snap['usage']['reservedTokens']==4
        assert not list(tmp_path.iterdir())
    asyncio.run(check())


def test_expired_claim_cannot_be_renewed_by_replaying_identity(fixture,tmp_path):
    async def check():
        store=service(fixture,tmp_path);task,fence=await task_and_claim(fixture,store)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(fence.run_id,))
        with pytest.raises(WorkConflict,match='execution_claim_stale'):
            await store.claim(task['id'],fence.run_id,fence.claim_id)
        with pytest.raises(WorkConflict,match='execution_claim_stale'):
            await publish(fixture,store,task,fence)
        current=await store.claim(task['id'],fence.run_id,'fresh-attempt')
        assert current.epoch==fence.epoch+1
    asyncio.run(check())


def test_concurrent_claims_leave_only_one_current_epoch(fixture,tmp_path):
    async def check():
        store=service(fixture,tmp_path);task,_=await task_and_claim(fixture,store)
        run=task['runs'][0]['id']
        a,b=await asyncio.gather(*(store.claim(task['id'],run,key) for key in ('a','b')))
        assert sorted([a.epoch,b.epoch])==[2,3]
        stale=a if a.epoch==2 else b
        with pytest.raises(WorkConflict,match='execution_claim_stale'):
            await publish(fixture,store,task,stale)
    asyncio.run(check())


@pytest.mark.parametrize('state',['proposed','admitted','unknown','not_applied'])
def test_unfinished_or_unapplied_action_prevents_success(fixture,tmp_path,state):
    async def check():
        store=service(fixture,tmp_path);task,fence=await task_and_claim(fixture,store)
        identity=await store.propose(task['id'],fence.run_id,fence=fence,action_key='write',
            intent={'row':7},reserved_tokens=4,requires_approval=False)
        if state!='proposed':await store.admit(identity,fence=fence)
        if state=='unknown':await store.uncertain(identity)
        if state=='not_applied':await store.resolve(identity,applied=False,actual_tokens=1,evidence=proof())
        with pytest.raises(WorkConflict,match='actions_unresolved'):
            await publish(fixture,store,task,fence)
        assert not list(tmp_path.iterdir())
    asyncio.run(check())


def test_verified_publication_is_atomic_idempotent_and_not_chat_owned(fixture,tmp_path):
    async def check():
        store=service(fixture,tmp_path);task,fence=await task_and_claim(fixture,store)
        identity=await store.propose(task['id'],fence.run_id,fence=fence,action_key='write',
            intent={'row':7},reserved_tokens=4,requires_approval=False)
        await store.admit(identity,fence=fence)
        await store.resolve(identity,applied=True,actual_tokens=3,evidence=proof())
        completed=await publish(fixture,store,task,fence)
        assert completed['status']=='completed' and not completed['authorityActive']
        assert completed['resultSummary']=='Row 7 verified.'
        assert completed['runs'][0]['status']=='completed' and len(completed['artifacts'])==1
        assert completed['usage']['spentTokens']==3 and completed['usage']['reservedTokens']==0
        assert await publish(fixture,store,task,fence)==completed
        with pytest.raises(WorkConflict,match='completion_content_changed'):
            await publish(fixture,store,task,fence,summary='Changed final answer')
        row,data=await store.download(fixture['token'],completed['artifacts'][0]['id'])
        assert data==artifact()['data'] and hashlib.sha256(data).hexdigest()==row['sha256']
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='task.completed'",(task['id'],)).fetchone()[0]==1
            assert db.execute('SELECT count(*) FROM messages WHERE run_id=%s',(fence.run_id,)).fetchone()[0]==0
    asyncio.run(check())


def test_failed_audit_leaves_no_published_metadata_and_retry_reuses_blob(fixture,tmp_path):
    async def check():
        store=service(fixture,tmp_path);task,fence=await task_and_claim(fixture,store)
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("CREATE FUNCTION work_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='task.completed' THEN RAISE EXCEPTION 'private'; END IF; RETURN NEW; END $$")
            db.execute('CREATE TRIGGER work_reject_completion BEFORE INSERT ON work_events FOR EACH ROW EXECUTE FUNCTION work_reject_completion()')
        try:
            with pytest.raises(StoreUnavailable):await publish(fixture,store,task,fence)
            snap=await store.snapshot(fixture['token'],task['id'])
            assert snap['status']=='open' and snap['artifacts']==[] and snap['resultSummary'] is None
            assert len(list(tmp_path.iterdir()))==1
        finally:
            with psycopg.connect(fixture['dsn']) as db:
                db.execute('DROP TRIGGER work_reject_completion ON work_events');db.execute('DROP FUNCTION work_reject_completion()')
        assert (await publish(fixture,store,task,fence))['status']=='completed'
        assert len(list(tmp_path.iterdir()))==1
    asyncio.run(check())


@pytest.mark.parametrize('interruption',['cancel','claim','corrupt'])
def test_change_between_file_staging_and_sql_commit_blocks_completion(fixture,tmp_path,interruption):
    async def check():
        store=service(fixture,tmp_path);task,fence=await task_and_claim(fixture,store)
        original=store.files.put
        def interrupted(data):
            descriptor=original(data)
            if interruption=='cancel':asyncio.run(store.cancel(fixture['token'],task['id']))
            elif interruption=='claim':asyncio.run(store.claim(task['id'],fence.run_id,'new-engine-attempt'))
            else:(tmp_path/descriptor['sha256']).write_bytes(b'x'*descriptor['sizeBytes'])
            return descriptor
        store.files.put=interrupted
        with pytest.raises((WorkConflict,StoreUnavailable)):
            await publish(fixture,store,task,fence)
        snap=await store.snapshot(fixture['token'],task['id'])
        assert snap['status']!='completed' and not snap['artifacts']
    asyncio.run(check())


@contextmanager
def http_server(fixture,root):
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
    url=f'http://127.0.0.1:{port}'
    script=Path(__file__).resolve().parents[1]/'scripts/serve.py'
    child=subprocess.Popen([sys.executable,'-I',str(script)],env={'PATH':os.defpath,
        'OPENBOT_CONTROL_DATABASE_URL':fixture['dsn'],'OPENBOT_CONTROL_PORT':str(port),
        'OPENBOT_CONTROL_AUTHORITY':'work','OPENBOT_CONTROL_OWNER_PASSWORD':'synthetic-work-fixture-password',
        'OPENBOT_CONTROL_COOKIE_MODE':'loopback','OPENBOT_CONTROL_ALLOWED_ORIGINS':url,
        'OPENBOT_CONTROL_ARTIFACT_ROOT':str(root)},stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    try:
        with httpx.Client(base_url=url,trust_env=False,timeout=2) as client:
            for _ in range(100):
                if child.poll() is not None:raise AssertionError('Owned work API process stopped before readiness.')
                try:
                    if client.get('/health').status_code==200:break
                except httpx.TransportError:pass
                time.sleep(.03)
            else:raise AssertionError('Owned work API did not become ready.')
            client.headers['Origin']=url
            client.cookies.set('openbot_session',fixture['token'])
            yield client
    finally:
        child.terminate()
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
        child.stderr.close()


def test_real_http_restart_approval_and_verified_download(fixture,tmp_path):
    store=service(fixture,tmp_path)
    with http_server(fixture,tmp_path) as client:
        response=client.post('/api/v1/tasks',json={'botId':fixture['expected']['/api/v1/bots']['bots'][0]['id'],
            'objective':'Correct CSV row 7','tokenLimit':20,'requestKey':str(uuid4())})
        assert response.status_code==202,response.text
        task=response.json();run=task['runs'][0]['id']
        fence=asyncio.run(store.claim(task['id'],run,'fixture-engine'))
        identity=asyncio.run(store.propose(task['id'],run,fence=fence,action_key='row-update',intent={'row':7,'value':'fixed'},reserved_tokens=4))
        pending=client.get('/api/v1/tasks/'+task['id']).json()
        assert pending['attention']=='approval'
    # A new real HTTP process sees the same work. This test has no durable engine or real tool.
    with http_server(fixture,tmp_path) as client:
        assert client.get('/api/v1/tasks/'+task['id']).json()==pending
        decision=client.post('/api/v1/actions/'+identity+'/decision',json={'intentDigest':pending['actions'][0]['intentDigest'],'approved':True})
        assert decision.status_code==200,decision.text
        assert asyncio.run(store.admit(identity,fence=fence))
        asyncio.run(store.resolve(identity,applied=True,actual_tokens=3,evidence=proof()))
        completed=asyncio.run(publish(fixture,store,task,fence))
        projected=client.get('/api/v1/tasks/'+task['id']).json();assert projected==completed
        artifact_url=completed['artifacts'][0]['downloadUrl']
        downloaded=client.get(artifact_url)
        assert downloaded.status_code==200 and downloaded.content==artifact()['data']
        assert downloaded.headers['content-disposition'].startswith("attachment; filename*=UTF-8''")
        assert downloaded.headers['x-content-type-options']=='nosniff'
        assert 'no-store' in downloaded.headers['cache-control']
        client.cookies.clear();assert client.get(artifact_url).status_code==401
        client.cookies.set('openbot_session',fixture['token'])
        (tmp_path/completed['artifacts'][0]['sha256']).write_bytes(b'corrupted')
        assert client.get(artifact_url).status_code==503


def test_expiration_during_publication_rolls_back_metadata_and_final_event(fixture,tmp_path):
    async def check():
        store=service(fixture,tmp_path);task,fence=await task_and_claim(fixture,store)
        with psycopg.connect(fixture['dsn']) as db:
            # Make time expiry occur after the first guard, without replacing the epoch. The final
            # in-transaction check must roll back even metadata/event writes already performed.
            db.execute("CREATE FUNCTION work_expire_at_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                "UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=NEW.run_id; RETURN NEW; END $$")
            db.execute('CREATE TRIGGER work_expire_at_publish AFTER INSERT ON work_artifacts FOR EACH ROW EXECUTE FUNCTION work_expire_at_publish()')
        try:
            with pytest.raises(WorkConflict,match='execution_claim_stale'):
                await publish(fixture,store,task,fence)
            snap=await store.snapshot(fixture['token'],task['id'])
            assert snap['status']=='open' and snap['artifacts']==[] and snap['resultSummary'] is None
        finally:
            with psycopg.connect(fixture['dsn']) as db:
                db.execute('DROP TRIGGER work_expire_at_publish ON work_artifacts');db.execute('DROP FUNCTION work_expire_at_publish()')
        assert (await publish(fixture,store,task,fence))['status']=='completed'
    asyncio.run(check())
