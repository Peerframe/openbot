"""Product publication binding and recovery against the owned PostgreSQL fixture."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import hashlib
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import psycopg
import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')
pytest.importorskip('pydantic_ai', reason='optional Worker SDK profile')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent-runtime-python/src'))
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from openbot_server import work_worker as worker
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_engine_binding import assert_completed_workflow
from openbot_server.work_values import WorkConflict, InvalidWork
from test_work_engine_binding_postgres import new, acknowledge, reference, facts, settings, QUEUE, NAMESPACE, WORKFLOW_TYPE
from openbot_server.work_store import PostgresWorkStore


async def setup(fixture, tmp_path):
    root=tmp_path/'files';root.mkdir(mode=0o700)
    service=PostgresWorkStore(fixture['dsn'],files=LocalWorkFiles(root))
    task=await new(fixture,service);run_id=task['runs'][0]['id']
    attempt=await acknowledge(fixture,service,task,reference(run_id))
    engine_facts=facts(task['id'],run_id,attempt)
    context=SimpleNamespace(task_id=task['id'],run_id=run_id,objective=task['objective'])
    client=SimpleNamespace(namespace=NAMESPACE,config=lambda:dict(plugins=[PydanticAIPlugin()]))
    data=b'checked\n'; verdict=worker.VerifiedTaskResult((dict(key='result',name='report.txt',mediaType='text/plain',data=data),),
        dict(source='independent-fixture',reference=task['id'],sha256=hashlib.sha256(data).hexdigest()))
    verifier=AsyncMock(return_value=verdict)
    host=worker.WorkActivities(service,client,namespace=NAMESPACE,queue=QUEUE,
                               load_services=lambda _:None,verify_result=verifier)
    async def bind(*args,**kwargs):
        return await assert_completed_workflow(service,dict(taskId=task['id'],runId=run_id),engine_facts,**settings())
    async def claim(*args,**kwargs):
        return await service.claim(task['id'],run_id,'publication')
    return service,task,host,verifier,verdict,engine_facts,context,bind,claim


def invoke(host,context,bind,claim,summary='verified answer'):
    async def call():
        with patch.object(worker,'bind_completed_activity',bind), \
             patch.object(worker,'load_current_activity_task',AsyncMock(return_value=context)), \
             patch.object(worker,'claim_current_activity',claim):
            return await host.publish_task(summary)
    return call()


def test_completed_publication_is_read_only_even_when_claim_expired(fixture,tmp_path):
    async def check():
        service,task,host,verify,_,facts_,context,bind,claim=await setup(fixture,tmp_path)
        first=await invoke(host,context,bind,claim)
        before=await service.snapshot(fixture['token'],task['id'])
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("UPDATE work_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE run_id=%s",(context.run_id,))
        verify.side_effect=AssertionError('verifier must not rerun')
        second=await invoke(host,context,bind,AsyncMock(side_effect=AssertionError('no claim')))
        assert first==second and verify.await_count==1
        assert await service.snapshot(fixture['token'],task['id'])==before
        with pytest.raises(WorkConflict,match='content_changed'):
            await invoke(host,context,bind,claim,'replacement')
        for field,value in [('first_run_id','other'),('queue','wrong'),('workflow_type','wrong'),
                           ('start_input',dict(taskId=task['id'],runId=context.run_id,attemptId='f'*32))]:
            with pytest.raises(WorkConflict):
                await assert_completed_workflow(service,dict(taskId=task['id'],runId=context.run_id),
                    replace(facts_,**{field:value}),**settings())
    asyncio.run(check())


@pytest.mark.parametrize('damage',['delete','metadata','blob','event'])
def test_completed_result_corruption_is_not_success(fixture,tmp_path,damage):
    async def check():
        service,task,host,verify,_,_,context,bind,claim=await setup(fixture,tmp_path)
        await invoke(host,context,bind,claim)
        with psycopg.connect(fixture['dsn']) as db:
            if damage=='delete': db.execute('DELETE FROM work_artifacts WHERE task_id=%s',(task['id'],))
            if damage=='metadata': db.execute("UPDATE work_artifacts SET name='changed.txt' WHERE task_id=%s",(task['id'],))
            if damage=='event': db.execute("DELETE FROM work_events WHERE task_id=%s AND kind='task.completed'",(task['id'],))
            if damage=='blob':
                digest=db.execute('SELECT sha256 FROM work_artifacts WHERE task_id=%s',(task['id'],)).fetchone()[0]
                (service.files.directory/digest).write_bytes(b'corrupt')
        from openbot_server.database import StoreUnavailable
        with pytest.raises((WorkConflict,StoreUnavailable)):
            await invoke(host,context,bind,claim)
        assert verify.await_count==1
    asyncio.run(check())


@pytest.mark.parametrize('mode',['reject','cancel','revoke','revision'])
def test_verification_cannot_override_mutated_authority_or_facts(fixture,tmp_path,mode):
    async def check():
        service,task,host,verify,verdict,_,context,bind,claim=await setup(fixture,tmp_path)
        async def changing(*args):
            if mode=='cancel': await service.cancel(fixture['token'],task['id'])
            if mode=='revoke': await service.revoke(fixture['token'],task['id'])
            if mode=='revision':
                async with service._transaction(trusted=True) as db:
                    await service._event(db,task['id'],'fixture.changed',{})
            return None if mode=='reject' else verdict
        verify.side_effect=changing
        with pytest.raises(WorkConflict): await invoke(host,context,bind,claim)
        snap=await service.snapshot(fixture['token'],task['id'])
        assert not snap['artifacts'] and snap['status']!='completed'
    asyncio.run(check())


def test_active_to_completed_race_recovers_the_original_result(fixture,tmp_path):
    async def check():
        service,task,host,verify,_,_,context,bind,claim=await setup(fixture,tmp_path)
        original=host._publish_active
        async def raced(summary):
            await original(summary)
            raise WorkConflict('admission_closed')
        with patch.object(host,'_publish_active',raced):
            result=await invoke(host,context,bind,claim)
        assert result['status']=='completed' and verify.await_count==1
        assert sum(e['kind']=='task.completed' for e in (await service.snapshot(fixture['token'],task['id']))['events'])==1
    asyncio.run(check())


@pytest.mark.parametrize('changed_after_review',[False,True])
def test_review_revision_and_publication_scope_preserve_atomic_read_authority(fixture,tmp_path,changed_after_review):
    async def check():
        service,task,host,verify,verdict,_,context,bind,claim=await setup(fixture,tmp_path)
        order=[]
        lock=asyncio.Lock()
        async def reviewed(*args):
            assert not lock.locked()
            async with service._transaction(trusted=True) as db:
                await service._task(db,task['id'])
                await service._event(db,task['id'],'fixture.review_settled',{})
                current=await service._task(db,task['id'],read=True)
                revision=current['revision']
            return replace(verdict,observed_revision=revision)
        @asynccontextmanager
        async def scope(_context):
            async with lock:
                order.append('scope')
                if changed_after_review:
                    async with service._transaction(trusted=True) as db:
                        await service._task(db,task['id'])
                        await service._event(db,task['id'],'fixture.concurrent_change',{})
                try: yield
                finally: order.append('released')
        @asynccontextmanager
        async def publication(_context,db):
            assert lock.locked()
            order.append('publication')
            yield
        verify.side_effect=reviewed
        host.publication_scope=scope;host.publication=publication
        if changed_after_review:
            with pytest.raises(WorkConflict):await invoke(host,context,bind,claim)
            assert (await service.snapshot(fixture['token'],task['id']))['status']!='completed'
            assert order==['scope','released']
        else:
            assert (await invoke(host,context,bind,claim))['status']=='completed'
            assert order==['scope','publication','released']
        assert not lock.locked()
    asyncio.run(check())


def test_worker_requires_registered_sdk_and_both_trusted_callbacks():
    with pytest.raises(InvalidWork,match='plugin_required'):
        worker.WorkActivities(object(),SimpleNamespace(namespace='default',config=lambda:{}),
            namespace='default',queue='queue',load_services=lambda _:None,verify_result=lambda *_:None)
    with pytest.raises(InvalidWork,match='callbacks_required'):
        worker.WorkActivities(object(),SimpleNamespace(namespace='default'),namespace='default',
            queue='queue',load_services=lambda _:None,verify_result=None)
