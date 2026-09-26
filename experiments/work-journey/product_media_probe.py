"""Real serve/Owner HTTP/PG/mTLS media journey using only owned disposable resources."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import quote,urlsplit
from urllib.request import Request

from product_media_fixture import MODEL,KEY,REPORT,SUMMARY,originals,check_history


def private_json(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2));path.chmod(0o600)


def cleanup_database(dsn,bot_id,channel_id,session_digest):
    """Exact generated identities only; preserve the fixture's original Owner session/data."""
    import psycopg
    with psycopg.connect(dsn) as db:
        if bot_id:
            ids=[row[0] for row in db.execute('SELECT id FROM work_tasks WHERE bot_id=%s',(bot_id,))]
            db.execute('DELETE FROM work_collaborations WHERE root_task_id=ANY(%s)',(ids,))
            db.execute('DELETE FROM work_reconciliation_requests WHERE command_id IN (SELECT c.id FROM work_reconciliation_commands c '
                'JOIN work_actions a ON a.id=c.action_id WHERE a.task_id=ANY(%s))',(ids,))
            db.execute('DELETE FROM work_reconciliation_commands WHERE action_id IN (SELECT id FROM work_actions WHERE task_id=ANY(%s))',(ids,))
            for table in ('work_model_receipts','work_tool_results','work_sources','work_actions','work_artifacts',
                          'work_correction_contexts','work_corrections','work_events','work_task_profiles'):
                db.execute('DELETE FROM '+table+' WHERE task_id=ANY(%s)',(ids,))
            for table in ('work_claims','work_admissions'):
                db.execute('DELETE FROM '+table+' WHERE run_id IN (SELECT id FROM work_runs WHERE task_id=ANY(%s))',(ids,))
            db.execute('DELETE FROM work_runs WHERE task_id=ANY(%s)',(ids,));db.execute('DELETE FROM work_tasks WHERE id=ANY(%s)',(ids,))
            db.execute('DELETE FROM knowledge_proposals WHERE bot_id=%s',(bot_id,))
            db.execute('DELETE FROM runs WHERE bot_id=%s',(bot_id,))
            if channel_id:
                # Channel-level MESSAGE_CREATED events have no Run FK and do not cascade.
                db.execute('DELETE FROM run_events WHERE channel_id=%s',(channel_id,))
                db.execute('DELETE FROM channels WHERE id=%s',(channel_id,))
            # Bot lifecycle events also have neither a Run nor a channel FK.
            db.execute('DELETE FROM run_events WHERE bot_id=%s',(bot_id,))
            db.execute('DELETE FROM bots WHERE id=%s',(bot_id,))
            assert db.execute('SELECT count(*) FROM work_tasks').fetchone()[0]==0
        if session_digest:db.execute('DELETE FROM auth_sessions WHERE token_digest=%s',(session_digest,))


async def qualify(repo,fixture_path,directory,restore_container=None):
    # Keep sibling candidate probes ahead of the checkout's already integrated helpers.
    sys.path[:0]=[str(Path(__file__).resolve().parent),str(repo/'experiments/work-journey'),str(repo/'apps/server-python/src'),
                 str(repo/'apps/agent-runtime-python/src')]
    import httpx2
    import psycopg
    from product_http_fixture import API,Process
    from postgres_server import PostgresServer
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio.worker import Replayer
    from openbot_server.model_settings import ModelSettingsService
    from openbot_server.database import PostgresReadStore
    from openbot_server.work_worker import OpenBotWork
    from openbot_server.work_product_collaboration import WorkCollaborationAdapter
    if not callable(getattr(WorkCollaborationAdapter,'unconsumed_in_transaction',None)):
        raise RuntimeError('Required integrated collaboration final-publication method is not ready')
    fixture=json.loads(fixture_path.read_text());parsed=urlsplit(fixture['dsn'])
    if parsed.hostname!='127.0.0.1' or not parsed.path.startswith('/openbot_control_test_'):
        raise ValueError('Requires an explicit owned disposable loopback fixture')
    await PostgresReadStore(fixture['dsn']).verify_schema()
    with psycopg.connect(fixture['dsn']) as db:
        if db.execute('SELECT count(*) FROM work_tasks').fetchone()[0]:raise ValueError('Requires an empty Work fixture')
    if directory.exists() and any(directory.iterdir()):raise ValueError('Output directory must be new or empty')
    directory.mkdir(mode=0o700,parents=True,exist_ok=True);directory.chmod(0o700)
    for child in ('artifacts','objects','provider'):(directory/child).mkdir(mode=0o700)
    await ModelSettingsService(directory/'model',lambda _:httpx2.Response(200,json={'id':MODEL})).save(
        dict(provider='openai',model=MODEL,apiKey=KEY,revision=None,agentEnabled=True))
    engine=PostgresServer(directory,mtls=True)
    engine_config=directory/'engine-config.json'
    private_json(engine_config,dict(temporal_address=engine.address,namespace='default',
        queue='product-media-'+secrets.token_hex(8),tls=engine.client_settings,interval_seconds=1,
        execution_timeout_seconds=600))
    probe_config=directory/'provider'/'config.json';private_json(probe_config,dict(directory=str(directory/'provider')))
    api=API(directory,fixture['dsn'],directory/'artifacts')
    api.env.update(OPENBOT_CONTROL_AUTHORITY='product',OPENBOT_CONTROL_WORK_TOKEN_LIMIT='1000000',
        OPENBOT_CONTROL_OBJECT_ROOT=str(directory/'objects'),OPENBOT_CONTROL_MODEL_DIRECTORY=str(directory/'model'),
        OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH=str(engine_config),OPENBOT_MEDIA_PROBE_CONFIG=str(probe_config))
    # Preserve the selected venv executable path; resolving its symlink would lose pyvenv.cfg.
    python=Path(sys.executable)
    def start_api():
        api.child=Process([str(python),'-u','-B',str(Path(__file__).with_name('product_media_server.py')),'--repo',str(repo)],api.directory,api.env)
        deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            api.child.alive()
            try:
                if api.call('/health')['ok']:return
            except OSError:pass
            time.sleep(.1)
        raise AssertionError('Actual product API readiness timed out')
    def upload(channel,name,data):
        request=Request(api.url+f'/api/v1/channels/{channel}/attachments',data,
            {'Content-Type':'application/octet-stream','Origin':api.url,'X-OpenBot-Filename':quote(name,safe='')})
        with api.opener.open(request,timeout=5) as response:
            assert response.status==201
            return json.loads(response.read())['attachment']
    bot_id=channel_id=task_id=None;cleanup_errors=[];session_digest=None
    private_json(directory/'ownership.json',dict(composeProjects=engine.projects))
    try:
        await asyncio.to_thread(engine.start);client=await engine.connect()
        print(json.dumps(dict(stage='engine-ready',mutualTLS=True)),flush=True)
        await asyncio.to_thread(start_api)
        await asyncio.to_thread(api.call,'/api/v1/auth/login',{'password':api.password})
        from urllib.request import HTTPCookieProcessor
        cookies=[cookie for handler in api.opener.handlers if isinstance(handler,HTTPCookieProcessor)
                 for cookie in handler.cookiejar]
        if len(cookies)!=1:raise AssertionError('Expected one owned Owner session')
        session_digest=hashlib.sha256(cookies[0].value.encode()).hexdigest()
        bot=(await asyncio.to_thread(api.call,'/api/v1/bots',dict(name='Synthetic media journey',role='Evidence assistant'),expected=201))['bot']
        bot_id=bot['id']
        private_json(directory/'ownership.json',dict(composeProjects=engine.projects,botId=bot_id,sessionDigest=session_digest))
        channel=(await asyncio.to_thread(api.call,'/api/v1/channels',dict(name='Synthetic media channel',botIds=[bot_id]),expected=201))['channel']
        channel_id=channel['id'];attachments=[]
        private_json(directory/'ownership.json',dict(composeProjects=engine.projects,botId=bot_id,channelId=channel_id,sessionDigest=session_digest))
        for name,mime,data in originals():
            item=await asyncio.to_thread(upload,channel_id,name,data)
            assert item['name']==name and item['mediaType']==mime and item['sizeBytes']==len(data)
            assert item['sha256']==hashlib.sha256(data).hexdigest() and not item.get('processing')
            attachments.append(item)
            assert await asyncio.to_thread(api.call,f"/api/v1/channels/{channel_id}/attachments/{item['id']}/content",raw=True)==data
        prompt='Inspect the original image and PDF, then write a Markdown report.\n'+'\n'.join(
            '[OpenBot attachment: '+item['id']+']' for item in attachments)
        source=await asyncio.to_thread(api.call,f'/api/v1/channels/{channel_id}/messages',dict(botId=bot_id,content=prompt),expected=201)
        with psycopg.connect(fixture['dsn']) as db:
            task_id,run_id=db.execute('SELECT s.task_id,r.id FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id '
                'WHERE s.legacy_run_id=%s',(source['run']['id'],)).fetchone()
        print(json.dumps(dict(stage='uploaded-and-submitted',mediaCount=2,originalBytes=sum(len(d) for _,_,d in originals()))),flush=True)
        handle=client.get_workflow_handle('openbot-work-v1-'+run_id)
        deadline=time.monotonic()+100
        while time.monotonic()<deadline:
            api.child.alive();snapshot=await asyncio.to_thread(api.snapshot,task_id)
            if snapshot['status']=='completed':break
            if snapshot['status'] in ('failed','cancelled'):
                raise AssertionError('Product task terminal before completion: '+snapshot['status'])
            await asyncio.sleep(.25)
        else:raise AssertionError('Product task did not complete; inspect owned process.log')
        result=await asyncio.wait_for(handle.result(),15)
        assert result['status']=='completed' and snapshot['resultSummary']==SUMMARY
        assert len(snapshot['artifacts'])==1
        assert await asyncio.to_thread(api.call,snapshot['artifacts'][0]['downloadUrl'],raw=True)==REPORT.encode()
        observations=[json.loads(line) for line in (directory/'provider/provider-observations.jsonl').read_text().splitlines()]
        assert [item['stage'] for item in observations]==['producer','producer','review']
        history=await handle.fetch_history();payload_count=check_history(history)
        (directory/'history.json').write_text(history.to_json());(directory/'history.json').chmod(0o600)
        with ThreadPoolExecutor(max_workers=2) as executor:
            await Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor).replay_workflow(history)
        with psycopg.connect(fixture['dsn']) as db:
            assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='task.completed'",(task_id,)).fetchone()[0]==1
            assert db.execute('SELECT count(*) FROM messages WHERE id=%s',('work-result:'+task_id,)).fetchone()[0]==1
            refs=db.execute("SELECT intent->'inputMedia' FROM work_actions WHERE task_id=%s AND intent->>'kind'='model' ORDER BY created_at",(task_id,)).fetchall()
            assert len(refs)==3 and all(row[0]==refs[0][0] for row in refs)
            assert set(refs[0][0])=={'version','sha256','sizeBytes'} and refs[0][0]['sizeBytes']<=12288
            manifest_ref=refs[0][0]
        manifest=json.loads((directory/'artifacts'/manifest_ref['sha256']).read_bytes())
        assert [item['mode'] for item in manifest['items']]==['binary','binary']
        record=dict(case='product-media-responses-v1',actualHTTP=True,actualPostgres=True,mutualTLS=True,
            actualWorker=True,syntheticModel=True,protocol='responses-v1',mediaCount=2,producerRequests=2,
            reviewRequests=1,exactOriginalBytes=True,originalChinesePdfFilename=True,
            taskCompleted=True,sourceMessagePublished=True,reportBytes=len(REPORT.encode()),
            originalHistoryOfflineReplay=True,decodedPayloadsChecked=payload_count,
            historyNoRawMediaOrKey=True,manifestBytes=manifest_ref['sizeBytes'])
        private_json(directory/'result.json',record);print(json.dumps(record),flush=True)
        if restore_container:
            # Freeze the completed product before pairing SQL with immutable/private files.
            await asyncio.to_thread(api.close)
            from product_restore_probe import qualify_restore
            assert Path(qualify_restore.__code__.co_filename).resolve().parent==Path(__file__).resolve().parent
            await qualify_restore(fixture['dsn'],directory,restore_container,cookies[0].value,
                task_id,channel_id,attachments,stopped=api.child.process.poll() is not None)
    finally:
        try:await asyncio.to_thread(api.close)
        except Exception as error:cleanup_errors.append('api:'+type(error).__name__)
        try:await asyncio.to_thread(engine.close)
        except Exception as error:cleanup_errors.append('compose:'+type(error).__name__)
        try:await asyncio.to_thread(cleanup_database,fixture['dsn'],bot_id,channel_id,session_digest)
        except Exception as error:cleanup_errors.append('database:'+type(error).__name__)
        private_json(directory/'cleanup.json',dict(apiStopped=not api.child or api.child.process.poll() is not None,
            composeProjects=engine.projects,errors=cleanup_errors))
        if cleanup_errors:raise RuntimeError('Owned cleanup incomplete: '+','.join(cleanup_errors))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo',type=Path,required=True,help='Checkout providing the reviewed product modules and existing journey helpers')
    parser.add_argument('--fixture',type=Path,required=True,help='Owned disposable canonical Control fixture')
    parser.add_argument('--output',type=Path,required=True,help='New private output directory')
    parser.add_argument('--restore-container',help='Explicit owned Control PostgreSQL container for stopped paired restore')
    args=parser.parse_args()
    asyncio.run(qualify(args.repo.resolve(),args.fixture.resolve(),args.output.resolve(),args.restore_container))


if __name__=='__main__':main()
