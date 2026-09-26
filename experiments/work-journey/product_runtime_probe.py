"""Actual product HTTP/PG/mTLS journey, with synthetic model HTTP and original-history recovery."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import urlsplit

import psycopg
import httpx2
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.worker import Replayer

from product_http_fixture import API, Process, REPO
sys.path[:0]=[str(REPO/'apps/server-python/src'),str(REPO/'apps/agent-runtime-python/src')]
from postgres_server import PostgresServer
from product_runtime_server import REPORT, SUMMARY
from openbot_server.model_settings import ModelSettingsService
from openbot_server.work_worker import OpenBotWork


class ProductAPI(API):
    def __init__(self,directory,fixture,artifacts,engine,*,pause_completion):
        super().__init__(directory,fixture['dsn'],artifacts)
        self.python=REPO/'apps/server-python/.worker-venv/bin/python'
        self.probe_directory=directory/'product';self.probe_directory.mkdir(mode=0o700)
        self.config=self.probe_directory/'fixture.json'
        self.config.write_text(json.dumps(dict(directory=str(self.probe_directory),pause_completion=pause_completion)))
        self.config.chmod(0o600)
        engine_path=directory/'engine-config.json'
        engine_path.write_text(json.dumps(dict(temporal_address=engine.address,namespace='default',
            queue='product-runtime-'+secrets.token_hex(8),tls=engine.client_settings,
            interval_seconds=1,execution_timeout_seconds=600)))
        engine_path.chmod(0o600)
        self.env.update(OPENBOT_CONTROL_AUTHORITY='product',OPENBOT_CONTROL_WORK_TOKEN_LIMIT='1000000',
            OPENBOT_CONTROL_OBJECT_ROOT=str(directory/'objects'),OPENBOT_CONTROL_MODEL_DIRECTORY=str(directory/'model'),
            OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH=str(engine_path),OPENBOT_PRODUCT_PROBE_CONFIG=str(self.config))

    def start(self):
        self.child=Process([str(self.python),'-u','-B',str(Path(__file__).with_name('product_runtime_server.py'))],
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
        self.close()
        cfg=json.loads(self.config.read_text());cfg.update(pause_completion=False,forbid_provider=True)
        self.config.write_text(json.dumps(cfg))
        self.start()


async def qualify(directory,fixture,*,recovery=True,native=False):
    parsed=urlsplit(fixture['dsn'])
    if parsed.hostname!='127.0.0.1' or not parsed.path.startswith('/openbot_control_test_'):
        raise ValueError('An owned disposable Control database is required')
    with psycopg.connect(fixture['dsn']) as db:
        if db.execute('SELECT count(*) FROM work_tasks').fetchone()[0]:
            raise ValueError('The disposable fixture must contain no earlier Tasks')
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    for child in ('artifacts','objects'):(directory/child).mkdir(mode=0o700,exist_ok=True)
    await ModelSettingsService(directory/'model',lambda request:httpx2.Response(200,json={'id':'synthetic-product'})).save(dict(provider='openai',model='synthetic-product',
        apiKey='synthetic-product-key',revision=None,agentEnabled=True))
    engine=PostgresServer(directory,mtls=True)
    api=ProductAPI(directory,fixture,directory/'artifacts',engine,pause_completion=recovery)
    try:
        await asyncio.to_thread(engine.start)
        client=await engine.connect()
        print(json.dumps(dict(stage='engine-ready',mutualTLS=True)),flush=True)
        await asyncio.to_thread(api.start)
        await asyncio.to_thread(api.call,'/api/v1/auth/login',{'password':api.password})
        bot=(await asyncio.to_thread(api.call,'/api/v1/bots',dict(name='Product runtime fixture',role='Evidence assistant'),expected=201))['bot']
        if native:
            task=await asyncio.to_thread(api.call,'/api/v1/tasks',dict(botId=bot['id'],
                objective='Prepare a Markdown report. The supplied fixture value is 42.',
                tokenLimit=1000000,requestKey=secrets.token_hex(16)),expected=202)
            task_id,run_id=task['id'],task['runs'][0]['id']
        else:
            channel=(await asyncio.to_thread(api.call,'/api/v1/channels',dict(name='Runtime fixture',botIds=[bot['id']]),expected=201))['channel']
            source=await asyncio.to_thread(api.call,f"/api/v1/channels/{channel['id']}/messages",
                dict(botId=bot['id'],content='Read the existing channel context and prepare a Markdown report. The supplied fixture value is 42.'),expected=201)
            with psycopg.connect(fixture['dsn']) as db:
                task_id,run_id=db.execute('SELECT s.task_id,r.id FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id '
                                          'WHERE s.legacy_run_id=%s',(source['run']['id'],)).fetchone()
        handle=client.get_workflow_handle('openbot-work-v1-'+run_id)
        deadline=time.monotonic()+70
        while time.monotonic()<deadline:
            api.child.alive()
            snapshot=await asyncio.to_thread(api.snapshot,task_id)
            if snapshot['status']=='completed':break
            await asyncio.sleep(.25)
        else:
            raise AssertionError('Product task did not complete: '+api.child.diagnostic()[-6000:])
        assert snapshot['resultSummary']==SUMMARY
        assert len(snapshot['artifacts'])==1
        artifact=snapshot['artifacts'][0]
        assert await asyncio.to_thread(api.call,artifact['downloadUrl'],raw=True)==REPORT.encode()
        counts=json.loads((api.probe_directory/'provider-count.json').read_text())
        requests=3 if native else 4
        assert counts==dict(calls=requests),counts
        print(json.dumps(dict(stage='product-completed',nativeTask=native,modelRequests=requests,reportBytes=len(REPORT.encode()),
                             sourceMessagePublished=not native)),flush=True)
        if recovery:
            if not (api.probe_directory/'published').exists():raise AssertionError('Publication barrier was not reached')
            original=(await handle.describe()).run_id
            await asyncio.to_thread(api.restart)
            await asyncio.wait_for(handle.result(),110)
            assert (await handle.describe()).run_id==original
            assert await asyncio.to_thread(api.snapshot,task_id)==snapshot
            assert json.loads((api.probe_directory/'provider-count.json').read_text())==counts
            print(json.dumps(dict(stage='publication-recovered',originalEngineRun=True,noProviderResend=True)),flush=True)
        else:
            await asyncio.wait_for(handle.result(),10)
        history=await handle.fetch_history()
        (directory/'history.json').write_text(history.to_json())
        with ThreadPoolExecutor(max_workers=2) as executor:
            await Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor).replay_workflow(history)
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute('SELECT count(*) FROM messages WHERE id=%s',('work-result:'+task_id,)).fetchone()[0]==(0 if native else 1)
            if native:
                assert db.execute('SELECT count(*) FROM work_sources WHERE task_id=%s',(task_id,)).fetchone()[0]==0
                assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(bot['id'],)).fetchone()[0]==0
            assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='task.completed'",(task_id,)).fetchone()[0]==1
        record=dict(case='composed-python-product-runtime',actualHTTP=True,actualPostgres=True,mutualTLS=True,
            syntheticModel=True,nativeTask=native,modelRequests=requests,reportBytes=len(REPORT.encode()),publicationRecovery=recovery,
            offlineReplay=True,completedEvents=1,sourceMessages=0 if native else 1)
        (directory/'result.json').write_text(json.dumps(record,indent=2))
        print(json.dumps(record),flush=True)
    finally:
        await asyncio.to_thread(api.close)
        await asyncio.to_thread(engine.close)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--fixture',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--without-recovery',action='store_true')
    parser.add_argument('--native-task',action='store_true')
    args=parser.parse_args()
    asyncio.run(qualify(args.output,json.loads(args.fixture.read_text()),recovery=not args.without_recovery,native=args.native_task))


if __name__=='__main__':main()
