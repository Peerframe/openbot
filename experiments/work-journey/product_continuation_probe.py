"""Real HTTP/PG/mTLS continuation journeys with private synthetic fixtures and offline replay."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit

import httpx2
import psycopg
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import WorkflowFailureError
from temporalio.worker import Replayer

from product_runtime_probe import ProductAPI
from product_http_fixture import Process
from product_continuation_server import SUMMARY
from postgres_server import PostgresServer
from openbot_server.model_settings import ModelSettingsService
from openbot_server.work_worker import OpenBotWork


def deadline_timer_seconds(history):
    starts={event.event_id:event.timer_started_event_attributes.start_to_fire_timeout.ToTimedelta().total_seconds()
            for event in history.events if event.HasField('timer_started_event_attributes')}
    fired=[starts[event.timer_fired_event_attributes.started_event_id] for event in history.events
           if event.HasField('timer_fired_event_attributes')
           and starts.get(event.timer_fired_event_attributes.started_event_id,0)>200]
    assert len(fired)==1 and 200<fired[0]<=300, 'Original collaboration deadline timer did not fire'
    return fired[0]


class ContinuationAPI(ProductAPI):
    def start(self):
        self.child=Process([str(self.python),'-u','-B',str(Path(__file__).with_name('product_continuation_server.py'))],
            self.directory,self.env)
        deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            self.child.alive()
            try:
                if self.call('/health')['ok']:return
            except OSError:pass
            time.sleep(.1)
        raise AssertionError('Product service did not become ready')

    def restart(self):
        self.close();value=json.loads(self.config.read_text())
        value.update(pause_creation=False,pause_failure=False)
        self.config.write_text(json.dumps(value));self.start()


async def wait_for(api, predicate, seconds=110):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        api.child.alive()
        result=await asyncio.to_thread(predicate)
        if result:return result
        await asyncio.sleep(.2)
    raise AssertionError('Journey checkpoint timed out: '+api.child.diagnostic())


async def qualify(directory,fixture,case):
    parsed=urlsplit(fixture['dsn'])
    if parsed.hostname!='127.0.0.1' or not parsed.path.startswith('/openbot_control_test_'):
        raise ValueError('Owned disposable Control fixture required')
    with psycopg.connect(fixture['dsn']) as db:
        if db.execute('SELECT count(*) FROM work_tasks').fetchone()[0]:raise ValueError('Empty fixture required')
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    for child in ('artifacts','objects'):(directory/child).mkdir(mode=0o700,exist_ok=True)
    await ModelSettingsService(directory/'model',lambda req:httpx2.Response(200,json={'id':'synthetic-product'})).save(
        dict(provider='openai',model='synthetic-product',apiKey='synthetic-product-key',revision=None,agentEnabled=True))
    engine=PostgresServer(directory,mtls=True)
    api=ContinuationAPI(directory,fixture,directory/'artifacts',engine,pause_completion=False)
    config=json.loads(api.config.read_text());config.update(case=case,pause_creation=case in ('collaboration','cancel'),pause_failure=case=='failure')
    api.config.write_text(json.dumps(config))
    try:
        await asyncio.to_thread(engine.start);client=await engine.connect()
        print(json.dumps(dict(stage='engine-ready',case=case,mutualTLS=True)),flush=True)
        await asyncio.to_thread(api.start)
        await asyncio.to_thread(api.call,'/api/v1/auth/login',{'password':api.password})
        bots=[]
        for name in ('Parent','Child A','Child B'):
            bots.append((await asyncio.to_thread(api.call,'/api/v1/bots',dict(name=name,role='Synthetic evidence assistant'),expected=201))['bot'])
        channel=(await asyncio.to_thread(api.call,'/api/v1/channels',dict(name='Continuation fixture',botIds=[b['id'] for b in bots]),expected=201))['channel']
        config.update(child_a=bots[1]['id'],child_b=bots[2]['id']);api.config.write_text(json.dumps(config))
        # The fixture provider is process-local trusted composition; restart before task admission
        # loads only these current synthetic Bot IDs, never a model-supplied target override.
        await asyncio.to_thread(api.close);await asyncio.to_thread(api.start)
        source=await asyncio.to_thread(api.call,f"/api/v1/channels/{channel['id']}/messages",dict(botId=bots[0]['id'],
            content='OWNER-PARENT Ask colleagues to verify the supplied values 42 and 84, then read both results.' if case!='failure' else 'Explain the supplied value 42.'),expected=201)
        with psycopg.connect(fixture['dsn']) as db:
            task_id,run_id=db.execute('SELECT s.task_id,r.id FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id WHERE s.legacy_run_id=%s',(source['run']['id'],)).fetchone()
        handle=client.get_workflow_handle('openbot-work-v1-'+run_id)
        marker=api.probe_directory/('failure-committed' if case=='failure' else 'creation-committed')
        await wait_for(api,marker.exists)
        original=(await handle.describe()).run_id
        before=json.loads((api.probe_directory/'provider-count.json').read_text())
        if case in ('collaboration','failure'):
            await asyncio.to_thread(api.restart)
            print(json.dumps(dict(stage='restarted-after-sql-commit',case=case,originalEngineRun=original)),flush=True)
        elif case=='cancel':
            await asyncio.to_thread(api.call,f"/api/v1/runs/{source['run']['id']}/cancel",{})
            print(json.dumps(dict(stage='owner-cancelled-tree',case=case)),flush=True)
        else:print(json.dumps(dict(stage='waiting-original-300-second-deadline',case=case)),flush=True)
        if case=='collaboration':
            result=await asyncio.wait_for(handle.result(),150)
            snapshot=await asyncio.to_thread(api.snapshot,task_id)
            assert result['status']==snapshot['status']=='completed' and snapshot['resultSummary']==SUMMARY
        else:
            try:await asyncio.wait_for(handle.result(),330 if case=='expiry' else 110)
            except WorkflowFailureError:pass
            else:raise AssertionError('The execution failure was not reported by Temporal')
            snapshot=await asyncio.to_thread(api.snapshot,task_id)
            assert not snapshot['artifacts']
            if case=='cancel':assert snapshot['cancelRequested'] and not snapshot['authorityActive']
            else:assert snapshot['status']=='failed'
        assert (await handle.describe()).run_id==original
        counts=json.loads((api.probe_directory/'provider-count.json').read_text())
        assert all(value==1 for value in counts.values()),counts
        if case=='failure':assert counts==before=={'failed-model':1}
        elif case=='collaboration':assert counts.keys()=={'parent:start','parent:delegate','parent:draft','parent:final','parent:review','a:answer','a:review','b:answer','b:review'},counts
        else:assert counts.get('parent:start')==1 and not any(k.startswith('parent:') and k!='parent:start' for k in counts)
        with psycopg.connect(fixture['dsn']) as db:
            links=db.execute('SELECT c.child_work_run_id,a.engine_first_run_id FROM work_collaborations c JOIN work_admissions a ON a.run_id=c.child_work_run_id WHERE c.root_task_id=%s',(task_id,)).fetchall()
            assert len(links)==(2 if case=='collaboration' else 0 if case=='failure' else 1)
            assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind=%s",(task_id,'task.completed' if case=='collaboration' else 'task.failed')).fetchone()[0]==(0 if case=='cancel' else 1)
            if case in ('failure','expiry'):
                failure=db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='task.failed'",(task_id,)).fetchone()[0]
                assert failure['code']=='execution_failed'
                assert db.execute('SELECT count(*) FROM messages WHERE id=%s',('work-result:'+task_id,)).fetchone()[0]==0
            if case=='cancel':
                assert db.execute('SELECT count(*) FROM work_tasks WHERE bot_id=ANY(%s) AND authority_active',([b['id'] for b in bots],)).fetchone()[0]==0
            if case=='expiry':
                elapsed=db.execute("SELECT extract(epoch FROM (f.created_at-c.created_at)) FROM work_events f JOIN work_events c ON c.task_id=f.task_id AND c.kind='run.claimed' WHERE f.task_id=%s AND f.kind='task.failed' ORDER BY c.created_at LIMIT 1",(task_id,)).fetchone()[0]
                assert 300<=elapsed<330,elapsed
                assert db.execute("SELECT count(*) FROM work_actions WHERE task_id=%s AND intent->>'tool'='start_task' AND status='unknown'",(task_id,)).fetchone()[0]==1
        histories=[]
        for index,identity in enumerate([run_id,*(row[0] for row in links if row[1] is not None)]):
            current=client.get_workflow_handle('openbot-work-v1-'+identity)
            history=await current.fetch_history();(directory/f'history-{index}.json').write_text(history.to_json());histories.append(history)
        with ThreadPoolExecutor(max_workers=2) as executor:
            replayer=Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
            for history in histories:await replayer.replay_workflow(history)
        record=dict(case=case,actualHTTP=True,actualPostgres=True,mutualTLS=True,syntheticModel=True,
            sqlCommitBeforeACKRecovery=case in ('collaboration','failure'),originalEngineRun=True,noProviderResend=True,counts=counts,
            offlineReplay=True,replayedHistories=len(histories),childRelations=len(links),taskStatus=snapshot['status'])
        if case=='expiry':
            record.update(durableDeadlineTimerFired=True,deadlineTimerSeconds=deadline_timer_seconds(histories[0]))
        (directory/'result.json').write_text(json.dumps(record,indent=2));print(json.dumps(record),flush=True)
    finally:
        await asyncio.to_thread(api.close);await asyncio.to_thread(engine.close)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--fixture',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--case',choices=('collaboration','failure','expiry','cancel'),required=True)
    args=parser.parse_args();asyncio.run(qualify(args.output,json.loads(args.fixture.read_text()),args.case))


if __name__=='__main__':main()
