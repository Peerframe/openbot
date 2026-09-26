"""Actual pinned mTLS hard-close/restart/commit-ACK/replay qualification, no paid model."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import urlparse
from urllib.request import urlopen


def private(path,value):
    path.write_text(json.dumps(value,indent=2));path.chmod(0o600)


def emit(**value):print(json.dumps(value),flush=True)


def command(args):
    r=subprocess.run(args,capture_output=True,timeout=30)
    if r.returncode:raise RuntimeError('Owned preflight failed: '+args[0])
    return r.stdout


async def run(repo,fixture_path,output):
    probe_directory=Path(__file__).resolve().parent
    sys.path[:0]=[str(repo/'apps/server-python/src'),
                 str(repo/'apps/agent-runtime-python/src'),str(repo/'experiments/work-journey')]
    from openbot_server import work_terminal
    from openbot_server.work_store import PostgresWorkStore
    from openbot_server.work_files import LocalWorkFiles
    from openbot_server.work_worker import TYPE,OpenBotWork
    from openbot_server.work_closed_repair import ClosedRepair
    from openbot_server.work_reconciliation import ReconciliationStore
    from openbot_server.work_repair_binding import PREFIX
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio.worker import Replayer
    from temporalio.client import WorkflowExecutionStatus
    from postgres_server import PostgresServer
    from effect_service import EffectService
    import psycopg
    cfg=json.loads(fixture_path.read_text())
    parsed=urlparse(cfg['dsn'])
    # An explicitly supplied disposable loopback fixture; never an arbitrary database.
    assert parsed.hostname=='127.0.0.1' and re.fullmatch(r'/openbot_control_test_terminal_[a-z0-9_]+',parsed.path)
    assert fixture_path.stat().st_mode & 0o077 == 0
    if output.exists() and any(output.iterdir()):raise ValueError('Output must be empty')
    output.mkdir(parents=True,exist_ok=True,mode=0o700);os.umask(0o077)
    engine_root=output/'engine';engine_root.mkdir(mode=0o700)
    files=output/'artifacts';files.mkdir(mode=0o700)
    store=PostgresWorkStore(cfg['dsn'],files=LocalWorkFiles(files))
    await store.verify_schema()
    with psycopg.connect(cfg['dsn']) as db:
        assert db.execute('SELECT count(*) FROM work_tasks').fetchone()[0]==0
        bot=db.execute('SELECT id FROM bots ORDER BY id LIMIT 1').fetchone()[0]
    for image in re.findall(r'^\s+image: (\S+)$',(repo/'deploy/temporal/compose.yaml').read_text(),re.MULTILINE):
        await asyncio.to_thread(command,['docker','image','inspect',image,'--format','{{.Id}}'])
    server=PostgresServer(engine_root,mtls=True)
    server.release_overlay=probe_directory/'resources.yaml'
    effects=EffectService(output/'effects');processes=[];task_ids=[];records=[];all_histories=[]
    current=None;stage='initialize';started=time.monotonic()
    def ownership(cleaned=False):
        private(output/'ownership.json',dict(engineProjects=server.projects,processIds=[p.pid for p in processes],
            taskIds=task_ids,cleaned=cleaned,fixtureName='terminal',engineControlDatabaseSeparate=True))
    ownership()
    def kill():
        nonlocal current
        if current and current.poll() is None:
            os.killpg(current.pid,signal.SIGKILL);current.wait(timeout=10)
        current=None
    async def until(callback,label,timeout=50):
        async with asyncio.timeout(timeout):
            while True:
                value=callback()
                if hasattr(value,'__await__'):value=await value
                if value:return value
                if current and current.poll() is not None:raise AssertionError('Worker exited during '+label)
                await asyncio.sleep(.15)
    async def snapshot(task_id):return await store.snapshot(cfg['token'],task_id)
    async def snap_match(task_id,predicate):
        value=await snapshot(task_id)
        return value if predicate(value) else None
    def counts(task_id):
        with urlopen(effects.url+'/stats/'+task_id,timeout=3) as response:return json.load(response)
    async def launch(queue,timeout,*,pause=False,repair=False,fail=False):
        nonlocal current
        assert current is None
        directory=output/('worker-'+str(len(processes)));directory.mkdir(mode=0o700)
        product=directory/'temporal.json'
        private(product,dict(temporal_address=server.address,namespace='default',queue=queue,tls=server.client_settings,
            limit=8,item_timeout_seconds=10,execution_timeout_seconds=timeout,interval_seconds=1))
        config=directory/'config.json'
        private(config,dict(dsn=cfg['dsn'],artifact_root=str(files),temporal_address=server.address,engine_tls=server.client_settings,
            queue=queue,directory=str(directory),effect_url=effects.url,product_config=str(product),pause_terminal_commit=pause,
            enable_repair=repair,fail_planner=fail))
        environment={k:os.environ[k] for k in ('PATH','HOME','TMPDIR') if k in os.environ}
        environment.update(OPENBOT_TERMINAL_REPO=str(repo),OPENBOT_WORK_JOURNEY_CONFIG=str(config),PYTHONDONTWRITEBYTECODE='1')
        with (directory/'process.log').open('w') as log:
            current=subprocess.Popen([sys.executable,'-B',str(probe_directory/'worker.py')],cwd=repo,env=environment,
                                     stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        processes.append(current);ownership()
        await until(lambda:(directory/'ready').exists(),'service ready',35)
        return directory
    try:
        emit(stage=stage,topology=dict(ownedPersistentContainers=2,maximumTransientSchemaContainers=1,
            engineMemoryMiB=1536,postgresMemoryMiB=512,maximumWorkers=1,effectEndpoints=1))
        await asyncio.to_thread(server.start)
        client=await server.connect()
        # Existing pinned fixture proves mTLS rejects missing certificates and plaintext too.
        await server.qualify_transport()
        for case in ('terminated','timed_out','commit_ack_loss'):
            stage=case+'-prepare';emit(stage=stage)
            queue='terminal-'+secrets.token_hex(8);timeout=35 if case=='timed_out' else 240
            task=await store.create(cfg['token'],bot_id=bot,objective='Verify synthetic hard close '+case,
                token_limit=10,request_key='terminal-'+secrets.token_hex(12))
            task_id=task['id'];run_id=task['runs'][0]['id'];task_ids.append(task_id);ownership()
            await launch(queue,timeout)
            waiting=await until(lambda:snap_match(task_id,lambda s:s['attention']=='approval'),'approval')
            action=next(a for a in waiting['actions'] if a['decision']=='pending')
            effects.drop_write_response(task_id);effects.corrupt_receipt(task_id,malformed_json=True)
            await store.decide(cfg['token'],action['id'],intent_digest=action['intentDigest'],approved=True)
            unknown=await until(lambda:snap_match(task_id,lambda s:s['attention']=='reconciliation'),'unknown')
            assert counts(task_id)['writes']==1 and counts(task_id)['attempts']==2
            assert unknown['usage']==dict(tokenLimit=10,reservedTokens=2,spentTokens=3)
            original=client.get_workflow_handle('openbot-work-v1-'+run_id)
            description=await original.describe();first=description.run_id
            exact=client.get_workflow_handle('openbot-work-v1-'+run_id,run_id=first)
            kill();before=await snapshot(task_id);before_counts=counts(task_id)
            stage=case+'-engine-close';emit(stage=stage)
            if case!='timed_out':await exact.terminate('Synthetic owned hard-close qualification')
            expected=WorkflowExecutionStatus.TIMED_OUT if case=='timed_out' else WorkflowExecutionStatus.TERMINATED
            async def hard_closed():
                d=await exact.describe()
                return d if d.status==expected else None
            await until(hard_closed,'actual engine terminal',55)
            assert await snapshot(task_id)==before and counts(task_id)==before_counts
            # A new ProductWorkService process is the only normal terminal observer.
            stage=case+'-service-recovery';emit(stage=stage)
            directory=await launch(queue,timeout,pause=case=='commit_ack_loss',fail=True)
            closed=await until(lambda:snap_match(task_id,lambda s:s['status']=='failed'),'SQL closure')
            if case=='commit_ack_loss':
                await until(lambda:(directory/'terminal-committed').exists(),'post-commit barrier')
                kill();await launch(queue,timeout,fail=True)
            assert not closed['authorityActive'] and not closed['cancelRequested']
            assert closed['usage']==before['usage'] and counts(task_id)==before_counts
            assert closed['actions']==before['actions'] and closed['runs'][0]['status']=='failed'
            assert len([e for e in closed['events'] if e['kind']=='task.failed'])==1
            receipts=[e for e in closed['events'] if e['kind']=='run.engine_terminal'];assert len(receipts)==1
            assert receipts[0]['payload']['result']['publicCode']=='engine_'+('timed_out' if case=='timed_out' else 'terminated')
            assert [e for e in closed['events'] if e['kind']=='run.claimed']==[e for e in before['events'] if e['kind']=='run.claimed']
            await asyncio.sleep(1.2)
            assert await snapshot(task_id)==closed and counts(task_id)==before_counts
            # Exact original SDK proof can recover the receipt despite scan exclusion and closed SQL.
            async with store._transaction(trusted=True) as db:
                row=await (await db.execute('SELECT t.created_at,r.ordinal FROM work_tasks t JOIN work_runs r ON r.task_id=t.id WHERE r.id=%s',(run_id,))).fetchone()
            candidate=work_terminal.TerminalCandidate(work_terminal.TerminalCursor(row['created_at'],task_id,row['ordinal'],run_id),first)
            scope=dict(namespace='default',queue=queue,workflow_type=TYPE)
            proof=await work_terminal.observe_terminal(client,candidate,**scope)
            assert proof is not None
            assert await work_terminal.close_terminal(store,candidate,proof,**scope)==receipts[0]['payload']['result']
            assert await snapshot(task_id)==closed and counts(task_id)==before_counts
            kill()
            handles=[exact]
            if case=='terminated':
                stage=case+'-owner-lookup';emit(stage=stage)
                effects.repair_receipt(task_id)
                repair_command=await ReconciliationStore(store).request(cfg['token'],action['id'],intent_digest=action['intentDigest'],
                    request_key='terminal-lookup-'+secrets.token_hex(10),expected_sequence=0,reason='Verify the original synthetic receipt only')
                await launch(queue,timeout,repair=True,fail=True)
                resolved=await until(lambda:snap_match(task_id,lambda s:s['usage']['reservedTokens']==0),'Owner lookup settlement')
                repair=client.get_workflow_handle(PREFIX+repair_command['id'])
                assert await asyncio.wait_for(repair.result(),50)==dict(commandId=repair_command['id'],outcome='resolved')
                assert resolved['status']=='failed' and resolved['usage']['spentTokens']==5
                assert counts(task_id)['writes']==1 and counts(task_id)['attempts']==2
                assert await work_terminal.close_terminal(store,candidate,proof,**scope)==receipts[0]['payload']['result']
                kill();handles.append(repair)
            stage=case+'-replay';emit(stage=stage)
            before_replay=await snapshot(task_id);effect_replay=counts(task_id)
            histories=[]
            for index,handle in enumerate(handles):
                history=await handle.fetch_history();data=history.to_json().encode()
                path=output/(case+'-history-'+str(index)+'.json');path.write_bytes(data);path.chmod(0o600)
                histories.append(history);all_histories.append(dict(case=case,file=path.name,sha256=hashlib.sha256(data).hexdigest(),events=len(history.events)))
            with ThreadPoolExecutor(max_workers=2) as executor:
                replayer=Replayer(workflows=[OpenBotWork,ClosedRepair],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
                for history in histories:await replayer.replay_workflow(history)
            assert await snapshot(task_id)==before_replay and counts(task_id)==effect_replay
            assert (await original.describe()).run_id==first
            record=dict(case=case,actualMTLS=True,actualEngineStatus=expected.name,serviceRestartClosure=True,
                unknownReservationPreserved=True,originalReceiptReadback=True,oneTerminalEvent=True,
                postCountUnchanged=True,singleWrite=True,noNewClaim=True,offlineReplay='passed',
                ownerLookupOnly=case=='terminated',commitBeforeAckProcessKill=case=='commit_ack_loss')
            records.append(record);emit(**record)
        private(output/'evidence.json',dict(status='passed',seconds=round(time.monotonic()-started,2),records=records,
            history=all_histories,transport=server.evidence,productSourceSha256={name:hashlib.sha256((repo/'apps/server-python/src/openbot_server'/name).read_bytes()).hexdigest() for name in ('work_terminal.py','work_product_service.py','work_failure.py')}))
    except BaseException as error:
        private(output/'failure.json',dict(stage=stage,errorType=type(error).__name__))
        emit(status='failed',stage=stage,errorType=type(error).__name__)
        raise
    finally:
        kill()
        effects.close()
        await asyncio.to_thread(server.close)
        with psycopg.connect(cfg['dsn']) as db:
            db.execute('DELETE FROM work_reconciliation_requests WHERE command_id IN (SELECT c.id FROM work_reconciliation_commands c JOIN work_actions a ON a.id=c.action_id WHERE a.task_id=ANY(%s))',(task_ids,))
            db.execute('DELETE FROM work_reconciliation_commands WHERE action_id IN (SELECT id FROM work_actions WHERE task_id=ANY(%s))',(task_ids,))
            for table in ('work_tool_results','work_sources','work_actions','work_artifacts','work_correction_contexts','work_corrections','work_events'):
                db.execute('DELETE FROM '+table+' WHERE task_id=ANY(%s)',(task_ids,))
            for table in ('work_claims','work_admissions'):
                db.execute('DELETE FROM '+table+' WHERE run_id IN (SELECT id FROM work_runs WHERE task_id=ANY(%s))',(task_ids,))
            db.execute('DELETE FROM work_runs WHERE task_id=ANY(%s)',(task_ids,))
            db.execute('DELETE FROM work_tasks WHERE id=ANY(%s)',(task_ids,))
            remaining=db.execute('SELECT count(*) FROM work_tasks').fetchone()[0]
        assert remaining==0
        for project in server.projects:
            assert not command(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project]).strip()
            assert not command(['docker','volume','ls','-q','--filter','label=com.docker.compose.project='+project]).strip()
        ownership(True)
        # Generated credentials have no role after exact owned engine teardown.
        (engine_root/'engine.env').unlink(missing_ok=True)
        shutil.rmtree(engine_root/'pki',ignore_errors=True)
        for child in output.iterdir():
            if child.is_dir() and child.name.startswith('worker-'):
                for name in ('config.json','temporal.json'):(child/name).unlink(missing_ok=True)
        emit(cleanup='owned containers, volumes, processes and Task rows removed')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--fixture',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();asyncio.run(run(args.repo.resolve(),args.fixture.resolve(),args.output.resolve()))
