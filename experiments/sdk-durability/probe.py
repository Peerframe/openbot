"""Independent counts across real SDK+engine worker crashes; no private or product data."""
import argparse
import asyncio
from datetime import timedelta
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory,mkdtemp

import psycopg
from dbos import DBOSClient
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'durable-execution'))
from probe_temporal import Server
from probe import CLEAN_ENV,Effects,database,wait_for


class Worker:
    def __init__(self,root,engine,cfg):
        self.root=root;root.mkdir()
        config=root/'config.json';config.write_text(json.dumps({**cfg,'directory':str(root)}));config.chmod(0o600)
        self.log=(root/'worker.log').open('w')
        self.process=subprocess.Popen([sys.executable,'-B','-u',str(ROOT/(engine+'_worker.py'))],
            env={**CLEAN_ENV,'OPENBOT_SDK_PROBE_CONFIG':str(config)},stdout=self.log,stderr=subprocess.STDOUT,start_new_session=True)

    def wait(self,marker):
        def observed():
            if (self.root/marker).exists():return True
            if self.process.poll() is not None:
                raise AssertionError('SDK worker exited before '+marker+': '+(self.root/'worker.log').read_text()[-4500:])
            return False
        wait_for(observed,marker,timeout=35)

    def kill(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid,signal.SIGKILL);self.process.wait(timeout=5)
        self.log.close()


async def qualify(root,dsn,effects,server,selected):
    temporal=None
    if 'temporal' in selected:
        await server.connect()
        temporal=await Client.connect(server.address,plugins=[PydanticAIPlugin()])
    dbos=DBOSClient(system_database_url=dsn.replace('postgresql:','postgresql+psycopg:')) if 'dbos' in selected else None
    workers=[];records=[]
    def launch(engine,cfg):
        w=Worker(root/('worker-'+str(len(workers))),engine,cfg);workers.append(w);w.wait('ready');return w
    try:
        for engine in selected:
            modes=['portable-workflow','inline-replay','checkpoint-replay','approval-replay','revoked-replay'] if engine=='dbos' else ['checkpoint-replay','approval-replay','revoked-replay']
            for mode in modes:
                case=engine+'-'+mode+'-'+secrets.token_hex(5)
                with psycopg.connect(dsn) as db:
                    db.execute('INSERT INTO probe_authority VALUES (%s,true)',(case,))
                crash_read=mode in ('inline-replay','checkpoint-replay')
                cfg=dict(case=case,dsn=dsn,dbos_url=dsn.replace('postgresql:','postgresql+psycopg:'),
                    effect_url=effects.url,inline=mode=='inline-replay',start=True,portable=mode=='portable-workflow',
                    barrier='after-read' if crash_read else '',temporal_address=server.address if server else '')
                first=launch(engine,cfg)
                if engine=='temporal':
                    handle=await temporal.start_workflow('SDKWorkflow',id=case,task_queue=case,
                        execution_timeout=timedelta(seconds=110),id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE)
                first.wait('reached' if crash_read else 'waiting')
                assert effects.count(case,'read')==1 and effects.count(case,'model-first')==1
                assert effects.count(case,'write')==0
                if not crash_read:
                    # A filesystem marker alone precedes the engine checkpoint. Confirm it before
                    # killing; DBOS proves the deferred-wait boundary, not an instrumented recv call.
                    if engine=='dbos':
                        def waiting_committed():
                            with psycopg.connect(dsn) as db:
                                return bool(db.execute("SELECT 1 FROM dbos.operation_outputs WHERE workflow_uuid=%s AND function_name='probe.waiting' AND error IS NULL",(case,)).fetchone())
                        wait_for(waiting_committed,'deferred wait checkpoint')
                    else:
                        for _ in range(100):
                            if await asyncio.wait_for(handle.query('is_waiting'),3):break
                            await asyncio.sleep(.05)
                        else:raise AssertionError('Durable workflow did not enter wait state')
                first.kill()
                if mode=='revoked-replay':
                    with psycopg.connect(dsn) as db:db.execute('UPDATE probe_authority SET allowed=false WHERE case_id=%s',(case,))
                # Deliver the decision while no worker is alive. This is an engine signal/message,
                # not a complete OpenBot approval record (no content binding or expiration here).
                if engine=='temporal':await handle.signal('approve',{'approved':True})
                else:dbos.send(case,{'approved':True},topic='approval')
                second=launch(engine,{**cfg,'start':False,'barrier':''})
                if engine=='temporal':value=await asyncio.wait_for(handle.result(),35)
                else:
                    second.wait('result.json');value=json.loads((second.root/'result.json').read_text())
                revoked=mode=='revoked-replay'
                assert value['outcome']==('revoked' if revoked else 'Row 7 verified'),value
                assert value['requests']==(2 if revoked else 3),value
                counts={k:effects.count(case,k) for k in ('read','model-first','model-next','model-final','write')}
                expected={'read':2 if mode=='inline-replay' else 1,'model-first':1,'model-next':2 if crash_read else 1,
                          'model-final':0 if revoked else 1,'write':0 if revoked else 1}
                assert counts==expected,(engine,mode,counts,expected)
                second.kill()
                # Completed identity reuse cannot re-run SDK/model/tools.
                if engine=='temporal':
                    try:
                        await temporal.start_workflow('SDKWorkflow',id=case,task_queue=case,id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE)
                    except WorkflowAlreadyStartedError:pass
                    else:raise AssertionError('Completed workflow identity was reused')
                    assert await handle.result()==value
                    history=await handle.fetch_history()
                    encodings=set()
                    for e in history.events:
                        if e.HasField('activity_task_completed_event_attributes'):
                            for p in e.activity_task_completed_event_attributes.result.payloads:
                                encodings.add(p.metadata.get('encoding',b'').decode())
                    assert encodings=={'json/plain','binary/null'},encodings
                    serialization=sorted(encodings)
                else:
                    third=launch(engine,{**cfg,'barrier':''});third.wait('result.json')
                    assert json.loads((third.root/'result.json').read_text())==value;third.kill()
                    with psycopg.connect(dsn) as db:
                        serialization=sorted(r[0] for r in db.execute('SELECT DISTINCT serialization FROM dbos.operation_outputs WHERE workflow_uuid=%s',(case,)))
                        workflow_format=db.execute('SELECT serialization FROM dbos.workflow_status WHERE workflow_uuid=%s',(case,)).fetchone()[0]
                        if mode=='portable-workflow':assert workflow_format=='portable_json',workflow_format
                        model_formats=[r[0] for r in db.execute("SELECT serialization FROM dbos.operation_outputs WHERE workflow_uuid=%s AND function_name LIKE %s",(case,'%request%'))]
                        assert model_formats and set(model_formats)=={'py_pickle'},model_formats
                    assert serialization and 'py_pickle' in serialization,serialization
                assert counts=={k:effects.count(case,k) for k in counts}
                row=dict(engine=engine,case=mode,counts=counts,result=value,
                         **({'activityResultSerialization':serialization} if engine=='temporal' else {'operationSerialization':serialization}))
                records.append(row);print(json.dumps(row),flush=True)
        return records
    finally:
        for w in workers:w.kill()
        if dbos:dbos.destroy()


async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--temporal-cli',type=Path);parser.add_argument('--engine',choices=['dbos','temporal','both'],default='both');parser.add_argument('--keep',action='store_true')
    args=parser.parse_args()
    for package,pin in [('pydantic-ai-slim','2.47.0'),('dbos','3.0.0'),('temporalio','1.33.0')]:
        assert importlib.metadata.version(package)==pin,(package,pin)
    selected=['dbos','temporal'] if args.engine=='both' else [args.engine]
    if 'temporal' in selected:
        if not args.temporal_cli or not args.temporal_cli.is_file():parser.error('Supply the verified official Temporal CLI1.9.1 path')
        version=subprocess.check_output([str(args.temporal_cli),'--version'],text=True)
        assert all(v in version for v in ['1.9.1','1.32.0','2.54.1']),version
    temporary=None if args.keep else TemporaryDirectory(prefix='openbot-sdk-durability-')
    root=Path(mkdtemp(prefix='openbot-sdk-durability-')) if args.keep else Path(temporary.name)
    # Keep only synthetic logs on explicit request. Database credentials expire when its container
    # is removed, even when logs/config files are retained for independent failure inspection.
    print('Owned fixture directory: '+str(root),flush=True)
    effects=Effects();server=None
    try:
        if 'temporal' in selected:
            s=root/'temporal';s.mkdir();server=Server(args.temporal_cli,s);server.start()
        with database() as dsn:records=await qualify(root,dsn,effects,server,selected)
        (root/'results.json').write_text(json.dumps(records,indent=2)+'\n')
        print(f'PASS: {len(records)} official SDK durability cases',flush=True)
    finally:
        if server:server.close()
        effects.close()
        if temporary:temporary.cleanup()


if __name__=='__main__':asyncio.run(main())
