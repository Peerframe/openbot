"""Actual Owner HTTP -> ProductWorkRuntime -> PostgreSQL/mTLS workflow -> offline replay."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
from urllib.parse import quote,urlsplit
from urllib.request import Request
from product_native_fixture import REPORT,SUMMARY,CHILD,DRAFT

def private(path,value):path.write_text(json.dumps(value,indent=2));path.chmod(0o600)
def emit(**value):print(json.dumps(value),flush=True)

async def qualify(repo,fixture_path,directory):
    sys.path[:0]=[str(Path(__file__).resolve().parent),str(repo/'experiments/work-journey'),
                 str(repo/'apps/server-python/src'),str(repo/'apps/agent-runtime-python/src')]
    import httpx2
    import psycopg
    from product_http_fixture import API,Process
    from postgres_server import PostgresServer
    from openbot_server.model_settings import ModelSettingsService
    from openbot_server.database import PostgresReadStore
    from openbot_server.work_worker import OpenBotWork
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio.worker import Replayer
    os.umask(0o077)
    fixture=json.loads(fixture_path.read_text());parsed=urlsplit(fixture['dsn'])
    if parsed.hostname!='127.0.0.1' or not re.fullmatch(r'/openbot_control_test_[a-z0-9_]+',parsed.path):
        raise ValueError('An explicit owned disposable loopback fixture is required')
    assert fixture_path.stat().st_mode & 0o077==0
    await PostgresReadStore(fixture['dsn']).verify_schema()
    with psycopg.connect(fixture['dsn']) as db:
        if db.execute('SELECT count(*) FROM work_tasks').fetchone()[0]:
            raise ValueError('The fixture must contain no earlier Work Tasks')
    if directory.exists() and any(directory.iterdir()):raise ValueError('New empty output required')
    directory.mkdir(parents=True,mode=0o700,exist_ok=True)
    if directory.stat().st_mode & 0o077:raise ValueError('Private output directory required')
    for child in ('artifacts','objects','provider'):(directory/child).mkdir(mode=0o700)
    await ModelSettingsService(directory/'model',lambda _:httpx2.Response(200,json={'id':'synthetic-native-product'})).save(dict(provider='openai',model='synthetic-native-product',apiKey='synthetic-native-key',revision=None,agentEnabled=True))
    engine=PostgresServer(directory,mtls=True)
    engine.release_overlay=repo/'experiments/work-journey/terminal-recovery/resources.yaml'
    api=API(directory,fixture['dsn'],directory/'artifacts')
    engine_config=directory/'engine-config.json'
    private(engine_config,dict(temporal_address=engine.address,namespace='default',queue='native-product-'+secrets.token_hex(8),tls=engine.client_settings,interval_seconds=1,execution_timeout_seconds=600))
    config_file=directory/'provider/config.json';config=dict(directory=str(directory/'provider'),pause_completion=True)
    private(config_file,config)
    api.env.update(OPENBOT_CONTROL_AUTHORITY='product',OPENBOT_CONTROL_WORK_TOKEN_LIMIT='1000000',OPENBOT_OWNER_NAME=fixture['ownerName'],
        OPENBOT_CONTROL_OBJECT_ROOT=str(directory/'objects'),OPENBOT_CONTROL_MODEL_DIRECTORY=str(directory/'model'),
        OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH=str(engine_config),OPENBOT_NATIVE_PROBE_CONFIG=str(config_file))
    bots=[];tasks=[];cleaned=False
    def ownership():private(directory/'ownership.json',dict(engineProjects=engine.projects,botIds=bots,taskIds=tasks,controlDatabase='owned_disposable',engineCleaned=cleaned))
    ownership()
    def start():
        api.child=Process([sys.executable,'-u','-B',str(Path(__file__).with_name('product_native_server.py')),'--repo',str(repo)],api.directory,api.env)
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            api.child.alive()
            try:
                if api.call('/health')['ok']:return
            except OSError:pass
            time.sleep(.15)
        raise AssertionError('Actual product API startup timed out')
    def upload():
        body=b'label,value\nfixture,42\n'
        req=Request(api.url+'/api/v1/task-attachments',body,{'Content-Type':'application/octet-stream','Origin':api.url,'X-OpenBot-Filename':quote('evidence.csv',safe='')})
        with api.opener.open(req,timeout=5) as res:
            assert res.status==201;item=json.load(res)
        assert item['attachment']['sha256']==hashlib.sha256(body).hexdigest()
        return item['attachment']
    async def until(predicate,seconds=180):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            api.child.alive();value=await asyncio.to_thread(predicate)
            if value:return value
            await asyncio.sleep(.2)
        raise AssertionError('Native journey checkpoint timeout; inspect owned process.log')
    try:
        emit(stage='initialize',resources=dict(temporalMemoryMiB=1536,postgresMemoryMiB=512,maximumWorkers=1),integratedCheckout=True)
        await asyncio.to_thread(engine.start);client=await engine.connect()
        emit(stage='engine-ready',mutualTLS=True)
        await asyncio.to_thread(start)
        await asyncio.to_thread(api.call,'/api/v1/auth/login',dict(password=api.password))
        suffix=secrets.token_hex(4)
        for label in ('Native root evidence assistant','Native authorized colleague'):
            name=label+' '+suffix
            item=await asyncio.to_thread(api.call,'/api/v1/bots',dict(name=name,role='Synthetic source reviewer'),expected=201)
            bots.append(item['bot']['id']);ownership()
        asset=await asyncio.to_thread(upload)
        await asyncio.to_thread(api.call,f'/api/v1/bots/{bots[0]}/memories',dict(kind='semantic',title='Owner note',content='Preserve source attribution in the final report.',sensitivity='internal',portability='never',modelUseEnabled=True),expected=201)
        config.update(root=bots[0],child=bots[1],attachment=asset['id']);private(config_file,config)
        await asyncio.to_thread(api.close);await asyncio.to_thread(start)
        scope=dict(version=1,attachmentIds=[asset['id']],collaboratorBotIds=[bots[1]],knowledge=True,plugins=False,web=False)
        created=await asyncio.to_thread(api.call,'/api/v1/tasks',dict(botId=bots[0],objective='NATIVE-ROOT Read the supplied evidence.csv and Owner memory. Ask the authorized colleague to independently read the same attachment, consume its result, draft one reusable lesson for Owner review, and publish a Markdown report. [OpenBot attachment: '+asset['id']+']',tokenLimit=1000000,requestKey='native-product-'+secrets.token_hex(12),scope=scope),expected=202)
        tid,rid=created['id'],created['runs'][0]['id'];tasks.append(tid);ownership()
        handle=client.get_workflow_handle('openbot-work-v1-'+rid)
        def completed():
            snapshot=api.snapshot(tid)
            if snapshot['status'] in ('failed','cancelled'):raise AssertionError('Unexpected native terminal: '+snapshot['status'])
            return snapshot if snapshot['status']=='completed' else None
        snapshot=await until(completed)
        assert snapshot['resultSummary']==SUMMARY and len(snapshot['artifacts'])==1
        assert (directory/'provider/published').exists()
        assert await asyncio.to_thread(api.call,snapshot['artifacts'][0]['downloadUrl'],raw=True)==REPORT.encode()
        with psycopg.connect(fixture['dsn']) as db:
            link=db.execute('SELECT child_task_id,child_work_run_id,source_kind,child_source_run_id,assignment_message_id FROM work_collaborations WHERE root_task_id=%s',(tid,)).fetchall()
            assert len(link)==1 and link[0][2:]==('task',None,None)
            child_tid,child_rid=link[0][:2];tasks.append(child_tid);ownership()
            assert db.execute('SELECT status,result_summary FROM work_tasks WHERE id=%s',(child_tid,)).fetchone()==('completed',CHILD)
            child_scope=db.execute("SELECT scope->'request' FROM work_task_scopes WHERE task_id=%s",(child_tid,)).fetchone()[0]
            assert child_scope==dict(scope,collaboratorBotIds=[])
            assert db.execute('SELECT count(*) FROM work_sources WHERE task_id=ANY(%s)',(tasks,)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM runs WHERE bot_id=ANY(%s)',(bots,)).fetchone()[0]==0
            assert db.execute('SELECT count(*) FROM channel_bots WHERE bot_id=ANY(%s)',(bots,)).fetchone()[0]==0
            assert db.execute("SELECT count(*) FROM work_actions WHERE task_id=%s AND intent->>'tool'='wait_for_task' AND status='applied'",(tid,)).fetchone()[0]==1
            assert db.execute('SELECT count(*) FROM employee_memories WHERE bot_id=%s',(bots[0],)).fetchone()[0]==1
        pending=await asyncio.to_thread(api.call,f'/api/v1/bots/{bots[0]}/knowledge-proposals')
        assert len(pending['proposals'])==1
        proposal=pending['proposals'][0]
        assert proposal['source']==dict(kind='task',taskId=tid,runId=rid) and 'sourceRunId' not in proposal
        counts=json.loads((directory/'provider/provider-count.json').read_text())
        assert set(counts)=={'root:read','root:memory','root:delegate','root:proposal','root:report','root:final','root:review','child:read','child:final','child:review'} and set(counts.values())=={1}
        original=(await handle.describe()).run_id
        emit(stage='native-product-completed',modelCalls=sum(counts.values()),realChildTasks=1,pendingKnowledge=1,reportBytes=len(REPORT.encode()))
        await asyncio.to_thread(api.close);config.update(pause_completion=False,forbid_provider=True);private(config_file,config)
        await asyncio.to_thread(start)
        result=await asyncio.wait_for(handle.result(),110)
        assert result['status']=='completed' and (await handle.describe()).run_id==original
        assert await asyncio.to_thread(api.snapshot,tid)==snapshot
        assert json.loads((directory/'provider/provider-count.json').read_text())==counts
        reviewed=await asyncio.to_thread(api.call,f'/api/v1/bots/{bots[0]}/knowledge-proposals/{proposal["id"]}/review',dict(decision='accept',title=DRAFT['title'],content=DRAFT['content'],modelUseEnabled=False,ownerReviewed=True))
        with psycopg.connect(fixture['dsn']) as db:
            memory=db.execute('SELECT provenance,model_use_enabled FROM employee_memories WHERE id=%s',(reviewed['memoryId'],)).fetchone()
            assert memory[0]==dict(source='reviewed-work-proposal',actor='owner',proposalId=proposal['id'],sourceTaskId=tid,sourceWorkRunId=rid) and memory[1] is False
            assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='task.completed'",(tid,)).fetchone()[0]==1
            assert db.execute('SELECT count(*) FROM work_collaborations WHERE root_task_id=%s',(tid,)).fetchone()[0]==1
            assert db.execute('SELECT count(*) FROM knowledge_proposals WHERE source_work_run_id=%s',(rid,)).fetchone()[0]==1
        histories=[]
        for i,identity in enumerate((rid,child_rid)):
            history=await client.get_workflow_handle('openbot-work-v1-'+identity).fetch_history()
            (directory/f'history-{i}.json').write_text(history.to_json());histories.append(history)
        with ThreadPoolExecutor(max_workers=2) as executor:
            replayer=Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
            for history in histories:await replayer.replay_workflow(history)
        assert json.loads((directory/'provider/provider-count.json').read_text())==counts
        record=dict(case='native-task-scoped-capabilities',actualOwnerHTTP=True,actualPostgres=True,mutualTLS=True,actualProductWorkRuntime=True,syntheticProvider=True,
            attachmentReads=2,authorizedChildTasks=1,childResultConsumed=True,reportPublished=True,reportBytes=len(REPORT.encode()),knowledgePendingAfterCompletion=True,
            ownerReviewedRealTaskProvenance=True,memoryAutomaticallyEnabled=False,legacySourceRows=0,sourceChannelRows=0,providerCounts=counts,
            commitAckRecovery=True,originalEngineRun=True,historyReplayCount=2,noProviderResend=True)
        private(directory/'result.json',record);emit(**record)
    finally:
        await asyncio.to_thread(api.close)
        await asyncio.to_thread(engine.close);cleaned=True;ownership()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--fixture',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    asyncio.run(qualify(args.repo.resolve(),args.fixture.resolve(),args.output.resolve()))
