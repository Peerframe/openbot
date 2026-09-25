"""Bounded cold paired restore of pending/unknown/cancelled product Work (scripted ports)."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from urllib.request import HTTPCookieProcessor,urlopen


def emit(**value):print(json.dumps(value),flush=True)

def digest(data):return hashlib.sha256(data).hexdigest()

def private(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2));path.chmod(0o600)


def command(args,*,data=None,timeout=60):
    result=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
    if result.returncode or len(result.stdout)>64*1024*1024:
        raise AssertionError('Owned native command failed: '+args[0]+' (details suppressed)')
    return result.stdout


class ControlDatabase:
    """Only random containers/volumes recorded before creation; no existing installation."""
    def __init__(self,directory,label,image):
        self.directory=directory;self.name='openbot-active-restore-'+label+'-'+secrets.token_hex(6)
        self.volume=self.name+'-data';self.image=image;self.identity=None
        self.database='openbot_control_test_active_'+secrets.token_hex(8)
        self.password=secrets.token_hex(24)
        self.env=directory/(label+'-postgres.env')
        self.env.write_text('POSTGRES_PASSWORD='+self.password+'\nPOSTGRES_DB='+self.database+'\n');self.env.chmod(0o600)
        self.record(False)
    def record(self,removed):
        private(self.directory/(self.name+'.ownership.json'),dict(name=self.name,containerId=self.identity,
            volume=self.volume,database=self.database,removed=removed))
    def start(self):
        assert not command(['docker','ps','-aq','--filter','name=^/'+self.name+'$']).strip()
        assert not command(['docker','volume','ls','-q','--filter','name=^'+self.volume+'$']).strip()
        command(['docker','volume','create','--label','openbot.active-restore='+self.name,self.volume])
        self.identity=command(['docker','run','-d','--name',self.name,'--label','openbot.active-restore='+self.name,
            '--env-file',str(self.env),'-p','127.0.0.1::5432','--mount','type=volume,src='+self.volume+',dst=/var/lib/postgresql/data',self.image]).decode().strip()
        self.record(False)
        ports=json.loads(command(['docker','inspect',self.identity,'--format','{{json .NetworkSettings.Ports}}']))
        binding=ports['5432/tcp'];assert len(binding)==1 and binding[0]['HostIp']=='127.0.0.1'
        self.dsn='postgresql://postgres:'+self.password+'@127.0.0.1:'+binding[0]['HostPort']+'/'+self.database
        import psycopg
        deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            try:
                with psycopg.connect(self.dsn,connect_timeout=1) as db:
                    assert db.execute("SELECT count(*) FROM pg_tables WHERE schemaname='public'").fetchone()[0]==0
                return
            except psycopg.OperationalError:time.sleep(.1)
        raise AssertionError('Owned Control database readiness timed out')
    def migrate(self,repo):
        cfg=self.directory/'migration.json';private(cfg,dict(dsn=self.dsn))
        script="import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';"\
            "const {createDatabase}=await import(pathToFileURL(process.argv[1]));"\
            "const {dsn}=JSON.parse(await readFile(process.argv[2]));const u=new URL(dsn);"\
            "if(u.hostname!=='127.0.0.1'||!/^\\/openbot_control_test_active_[a-f0-9]+$/.test(u.pathname))throw Error('fixture');"\
            "const db=createDatabase(dsn);try{await db.migrate()}finally{await db.close()}"
        command(['node','--input-type=module','-e',script,str(repo/'packages/db/dist/index.js'),str(cfg)],timeout=45)
    def dump(self):
        data=command(['docker','exec',self.identity,'pg_dump','-U','postgres','--format=custom','--no-owner','--no-privileges',self.database])
        assert data[:5]==b'PGDMP';return data
    def restore(self,data):
        command(['docker','exec','-i',self.identity,'pg_restore','-U','postgres','--single-transaction',
            '--exit-on-error','--no-owner','--no-privileges','-d',self.database],data=data)
    def stop(self):command(['docker','stop',self.identity])
    def close(self):
        found=command(['docker','ps','-aq','--filter','name=^/'+self.name+'$']).decode().strip()
        if found:
            info=json.loads(command(['docker','inspect',self.name,'--format','{{json .}}']))
            assert info['Id']==self.identity and info['Config']['Labels']['openbot.active-restore']==self.name
            command(['docker','rm','-f',self.identity])
        volumes=command(['docker','volume','ls','-q','--filter','name=^'+self.volume+'$']).decode().splitlines()
        if volumes:
            assert volumes==[self.volume]
            info=json.loads(command(['docker','volume','inspect',self.volume]))[0]
            assert info['Labels']['openbot.active-restore']==self.name
            command(['docker','volume','rm',self.volume])
        self.record(True)


def engine_snapshot(server):
    """Hash native table representations while the engine is stopped, including visibility."""
    result={}
    for database in ('temporal','temporal_visibility'):
        names=server.sql(database,"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").stdout.decode().splitlines()
        assert len(names)<=256
        tables={}
        for name in names:
            assert re.fullmatch('[a-z0-9_]+',name)
            data=server.sql(database,f'SET timezone=UTC; SELECT to_jsonb(t)::text FROM "{name}" t ORDER BY to_jsonb(t)::text COLLATE "C";').stdout
            assert data.startswith(b'SET\n') and len(data)<=16*1024*1024
            tables[name]={'rows':len(data.splitlines())-1,'sha256':digest(data[4:])}
        sequences={}
        for name in server.sql(database,"SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename;").stdout.decode().splitlines():
            assert re.fullmatch('[a-z0-9_]+',name)
            sequences[name]=server.sql(database,f'SELECT last_value,is_called FROM "{name}";').stdout.decode().strip()
        result[database]=dict(tables=tables,sequences=sequences)
    return result


def tls_snapshot(root):
    result={}
    for path in sorted(root.rglob('*')):
        assert not path.is_symlink()
        if path.is_dir():assert stat.S_IMODE(path.stat().st_mode)==0o700;continue
        data=path.read_bytes();assert len(data)<=65536
        mode=stat.S_IMODE(path.stat().st_mode)
        assert mode==(0o444 if path.parent.name=='engine' else 0o600)
        result[str(path.relative_to(root))]=dict(sha256=digest(data),sizeBytes=len(data),mode=mode)
    return result


async def qualify(repo,output):
    canonical_count=len(json.loads((repo/'packages/db/migrations/meta/_journal.json').read_text())['entries'])
    sys.path[:0]=[str(Path(__file__).resolve().parent),str(repo/'experiments/work-journey'),
        str(repo/'apps/server-python/src'),str(repo/'apps/agent-runtime-python/src')]
    import httpx2
    import psycopg
    from product_http_fixture import API,Process,CLEAN_ENV
    from postgres_server import PostgresServer
    from product_restore_probe import (IMAGE,snapshot,file_snapshot,seed_disabled_plugin,connection_service,
        CONNECTION_ENDPOINT,verify_connection,negative_keys,negative_connection_keys)
    from product_media_fixture import originals,check_history
    from effect_service import EffectService
    from openbot_server.database import PostgresReadStore
    from openbot_server.model_settings import ModelSettingsService
    from openbot_server.plugin_store import FilePluginStore
    from openbot_server.owner_files import OwnerFiles
    from openbot_server.authority import OwnerTransactions
    from openbot_server.identity_inputs import CreateBotInput
    from openbot_server.identity_store import PostgresIdentityStore
    from openbot_server.work_store import PostgresWorkStore
    from openbot_server.work_files import LocalWorkFiles
    from openbot_server.work_handoff import HandoffStore
    from openbot_server.work_dispatcher import dispatch_one
    from openbot_server.temporal_engine import TemporalEnginePort
    from openbot_server.work_worker import OpenBotWork,TYPE
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from temporalio.worker import Replayer
    from temporalio.client import WorkflowFailureError
    if output.exists() and any(output.iterdir()):raise ValueError('Output must be empty')
    output.mkdir(mode=0o700,parents=True,exist_ok=True);output.chmod(0o700)
    os.umask(0o077)
    source=output/'source';source.mkdir(mode=0o700)
    files=source/'files';files.mkdir(mode=0o700)
    for child in ('artifacts','objects'):(files/child).mkdir(mode=0o700)
    bundle=output/'bundle';bundle.mkdir(mode=0o700)
    destination=output/'destination';destination.mkdir(mode=0o700)
    source_db=ControlDatabase(output,'source',IMAGE);target_db=None
    engine=PostgresServer(source,mtls=True);processes=[];apis=[];effects=None
    started=time.monotonic();safe={};cleanup=[]
    def ownership():private(output/'ownership.json',dict(engineProjects=engine.projects,
        controlContainers=[db.name for db in (source_db,target_db) if db],processIds=[p.process.pid for p in processes]))
    ownership()
    async def wait(predicate,label,timeout=45):
        async with asyncio.timeout(timeout):
            while True:
                result=predicate()
                if result:return result
                await asyncio.sleep(.15)
    async def start_api(directory,dsn,root,previous=None):
        api=API(directory,dsn,root/'artifacts');api.env['OPENBOT_CONTROL_AUTHORITY']='work'
        if previous:api.opener=previous.opener;api.password=previous.password;api.env['OPENBOT_CONTROL_OWNER_PASSWORD']=api.password
        apis.append(api)
        api.child=Process([sys.executable,'-u','-B',str(repo/'apps/server-python/scripts/serve.py')],api.directory,api.env)
        processes.append(api.child);ownership()
        def ready():
            api.child.alive()
            try:return api.call('/health')['ok']
            except OSError:return False
        await wait(ready,'API ready');return api
    async def worker(directory,dsn,root,*,restored=False):
        directory.mkdir(mode=0o700)
        cfg=dict(dsn=dsn,artifact_root=str(root/'artifacts'),temporal_address=engine.address,queue=queue,
            engine_tls=engine.client_settings,directory=str(directory),effect_url=effects.url,
            execution_timeout_seconds=600,enable_repair=True,fail_planner=restored,
            forbid_apply=[tasks[1]['id'],tasks[2]['id']] if restored else [])
        config=directory/'config.json';private(config,cfg)
        child=Process([sys.executable,'-u','-B',str(Path(__file__).with_name('active_restore_worker.py')),
            '--repo',str(repo)],directory,{**CLEAN_ENV,'PYTHONDONTWRITEBYTECODE':'1','OPENBOT_WORK_JOURNEY_CONFIG':str(config)})
        processes.append(child);ownership()
        def ready():child.alive();return (directory/'ready').exists()
        await wait(ready,'Worker ready');return child
    def counts(task_id):
        with urlopen(effects.url+'/stats/'+task_id,timeout=3) as response:return json.load(response)
    async def replay(histories):
        with ThreadPoolExecutor(max_workers=2) as executor:
            replayer=Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
            for history in histories:await replayer.replay_workflow(history)
    try:
        images=re.findall(r'^\s+image: (\S+)$',(repo/'deploy/temporal/compose.yaml').read_text(),re.MULTILINE)
        assert len(images)==3 and IMAGE in images and all('@sha256:' in image for image in images)
        for image in images:await asyncio.to_thread(command,['docker','image','inspect',image,'--format','{{.Id}}'])
        await asyncio.to_thread(source_db.start);await asyncio.to_thread(source_db.migrate,repo)
        await PostgresReadStore(source_db.dsn).verify_schema()
        await asyncio.to_thread(engine.start);client=await engine.connect()
        emit(stage='source-ready',mutualTLS=True,ownDatabases=True)
        api=await start_api(source,source_db.dsn,files)
        api.call('/api/v1/auth/login',{'password':api.password})
        cookies=[c for h in api.opener.handlers if isinstance(h,HTTPCookieProcessor) for c in h.cookiejar]
        assert len(cookies)==1;token=cookies[0].value
        bot=api.call('/api/v1/bots',dict(name='Active restore fixture',role='Reviewed CSV correction'),expected=201)['bot']
        channel=api.call('/api/v1/channels',dict(name='Restore data fixture',botIds=[bot['id']]),expected=201)['channel']
        (files/'objects/attachments').mkdir(mode=0o700)
        ownerfiles=OwnerFiles(files/'objects/attachments');attachments=[]
        async with ownerfiles.lock():
            async with OwnerTransactions(source_db.dsn).transaction(token):
                for name,_mime,data in originals():attachments.append(ownerfiles.persist(channel['id'],name,data))
        settings=ModelSettingsService(files/'model',lambda _:httpx2.Response(200,json={'id':'synthetic-restore'}))
        await settings.save(dict(provider='openai',model='synthetic-restore',apiKey='synthetic-active-restore-key',revision=None,agentEnabled=True))
        model=await settings.active();plugin=await seed_disabled_plugin(files)
        connection=await connection_service(source_db.dsn,files/'objects/model-connections.key')
        saved=await connection.create(token,dict(name='Active restore synthetic connection',presetId='custom',baseUrl=CONNECTION_ENDPOINT,
            apiKey='synthetic-active-'+secrets.token_hex(16)))
        selection=dict(connectionId=saved['id'],modelId='synthetic-restore-model')
        selected_bot=await PostgresIdentityStore(source_db.dsn,model_connections=connection).create_bot(token,
            CreateBotInput(name='Active restore credential fixture',role='Data only',computerProfile='model',model=selection))
        connection_data=dict(public=saved,selection=selection,bot=selected_bot.model_dump(mode='json'),
            resolved=await connection.resolve(token,selection,expected_revision=saved['revision']))
        blob=LocalWorkFiles(files/'artifacts').put(b'Active restore immutable seed\n')
        effects=EffectService(output/'external-receipts')
        queue='active-restore-'+secrets.token_hex(8)
        tasks=[api.call('/api/v1/tasks',dict(botId=bot['id'],objective='Restore '+label,
            tokenLimit=10,requestKey=secrets.token_hex(12)),expected=202) for label in ('pending','unknown','cancelled')]
        running=await worker(source/'worker',source_db.dsn,files)
        handoff=HandoffStore(PostgresWorkStore(source_db.dsn,files=LocalWorkFiles(files/'artifacts')))
        for task in tasks:
            admitted=await dispatch_one(task['id'],task['runs'][0]['id'],'default',queue,TYPE,600,handoff,TemporalEnginePort(client))
            assert admitted.acknowledged,admitted.reason
        handles=[client.get_workflow_handle('openbot-work-v1-'+t['runs'][0]['id']) for t in tasks]
        engine_runs=[(await h.describe()).run_id for h in handles]
        pending=[]
        for task in tasks:
            state=await wait(lambda:(s if (s:=api.snapshot(task['id']))['attention']=='approval' else None),'pending approval')
            pending.append(next(a for a in state['actions'] if a['decision']=='pending'))
            assert state['usage']['spentTokens']==3 and counts(task['id'])['writes']==0
        effects.corrupt_receipt(tasks[1]['id'],malformed_json=True)
        api.call('/api/v1/actions/'+pending[1]['id']+'/decision',dict(intentDigest=pending[1]['intentDigest'],approved=True))
        api.call('/api/v1/tasks/'+tasks[2]['id']+'/cancel',{})
        await wait(lambda:(s if (s:=api.snapshot(tasks[1]['id']))['attention']=='reconciliation' else None),'unknown')
        try:await asyncio.wait_for(handles[2].result(),40)
        except WorkflowFailureError:pass
        assert api.snapshot(tasks[2]['id'])['status']=='cancelled'
        async with asyncio.timeout(30):
            while True:
                history=await handles[1].fetch_history()
                completed={e.activity_task_completed_event_attributes.scheduled_event_id for e in history.events if e.HasField('activity_task_completed_event_attributes')}
                execution=[e.event_id for e in history.events if e.HasField('activity_task_scheduled_event_attributes') and
                    e.activity_task_scheduled_event_attributes.activity_type.name=='openbot.execute_tool.v1']
                if len(execution)==1 and execution[0] in completed:break
                await asyncio.sleep(.1)
        before=[api.snapshot(t['id']) for t in tasks];external_before=[counts(t['id']) for t in tasks]
        assert before[0]['attention']=='approval' and next(a for a in before[0]['actions'] if a['id']==pending[0]['id'])['decision']=='pending'
        assert before[1]['usage']==dict(tokenLimit=10,spentTokens=3,reservedTokens=2)
        assert external_before[1]['writes']==1 and external_before[1]['attempts']==2
        source_histories=[await h.fetch_history() for h in handles]
        for i,h in enumerate(source_histories):private(source/('history-'+str(i)+'.json'),json.loads(h.to_json()))
        running.kill();api.close()
        assert all(p.process.poll() is not None for p in processes)
        # Freeze all writers; keep the external receipt service independent and never roll it back.
        await asyncio.to_thread(engine.backup,bundle/'engine',restart_engine=False)
        sql_source=await asyncio.to_thread(snapshot,source_db.dsn)
        engine_source=await asyncio.to_thread(engine_snapshot,engine)
        assert sql_source['tables']['drizzle.__drizzle_migrations']['rows']==canonical_count
        file_source=file_snapshot(files);tls_source=tls_snapshot(source/'pki')
        data=await asyncio.to_thread(source_db.dump);(bundle/'control.dump').write_bytes(data)
        shutil.copytree(files,bundle/'files');shutil.copytree(source/'pki',bundle/'pki')
        shutil.copy2(engine.env_file,bundle/'engine.env')
        private(bundle/'control-config.json',dict(ownerPassword=api.password,ownerSessionToken=token,queue=queue,
            authority='work',engineNamespace='default',sourceDatabase=source_db.database))
        manifest=dict(version=1,controlArchive=dict(sha256=digest(data),sizeBytes=len(data)),controlSQL=sql_source,
            engineSQL=engine_source,files=file_source,tls=tls_source,taskIds=[t['id'] for t in tasks],
            workRunIds=[t['runs'][0]['id'] for t in tasks],workflowIds=[h.id for h in handles],engineRunIds=engine_runs,
            configurationHashes={name:digest((bundle/name).read_bytes()) for name in ('engine.env','control-config.json')})
        private(bundle/'paired-manifest.json',manifest)
        await asyncio.to_thread(source_db.stop);await asyncio.to_thread(engine.command,'stop','postgresql')
        emit(stage='source-frozen',states=['pending','unknown','cancelled'],unknownWrites=1,unknownReserved=2,
             controlTables=len(sql_source['tables']),engineTables=sum(len(v['tables']) for v in engine_source.values()))
        target_db=ControlDatabase(output,'destination',IMAGE);ownership();await asyncio.to_thread(target_db.start)
        restored=destination/'files';shutil.copytree(bundle/'files',restored)
        shutil.copytree(bundle/'pki',destination/'pki')
        assert file_snapshot(restored)==file_source and tls_snapshot(destination/'pki')==tls_source
        archive=(bundle/'control.dump').read_bytes();assert digest(archive)==manifest['controlArchive']['sha256']
        await asyncio.to_thread(target_db.restore,archive)
        # Point every engine/client TLS path at the paired restored copy before any target start.
        for name,expected in manifest['configurationHashes'].items():assert digest((bundle/name).read_bytes())==expected
        restored_cfg=json.loads((bundle/'control-config.json').read_text())
        assert restored_cfg['queue']==queue and restored_cfg['ownerPassword']==api.password and restored_cfg['ownerSessionToken']==token
        restored_env=destination/'engine.env'
        restored_env.write_text((bundle/'engine.env').read_text().replace(str(source/'pki'),str(destination/'pki')))
        restored_env.chmod(0o600);engine.env_file=restored_env
        engine.client_settings={k:(str(destination/'pki'/Path(v).name) if k!='server_name' else v) for k,v in engine.client_settings.items()}
        await asyncio.to_thread(engine.restore,bundle/'engine',start_engine=False);ownership()
        assert await asyncio.to_thread(snapshot,target_db.dsn)==sql_source
        assert await asyncio.to_thread(engine_snapshot,engine)==engine_source
        assert not engine.command('ps','-q','temporal').stdout.strip()
        reader=PostgresReadStore(target_db.dsn);await reader.verify_schema()
        assert (await reader.read(token,'session')).expires_at is not None
        assert (await reader.read('A'*43,'session')).expires_at is None
        target_store=PostgresWorkStore(target_db.dsn,files=LocalWorkFiles(restored/'artifacts'))
        assert [await target_store.snapshot(token,t['id']) for t in tasks]==before
        assert LocalWorkFiles(restored/'artifacts').read(blob['sha256'],blob['sizeBytes'])==b'Active restore immutable seed\n'
        rf=OwnerFiles(restored/'objects/attachments')
        async with rf.lock():
            for descriptor,(_n,_m,data) in zip(attachments,originals(),strict=True):assert rf.read(channel['id'],descriptor['id'])==(descriptor,data)
        assert await ModelSettingsService(restored/'model').active()==model
        assert await FilePluginStore(restored/'objects/plugins/state.json').read()==plugin
        await verify_connection(target_db.dsn,restored,token,connection_data)
        failed=await negative_keys(restored,output)
        failed+=await negative_connection_keys(target_db.dsn,restored,output,token,connection_data)
        assert len(failed)==6 and [counts(t['id']) for t in tasks]==external_before
        # Incomplete file sets are checked while held; no product recovery authority is inferred.
        incomplete=output/'incomplete';shutil.copytree(restored,incomplete)
        (incomplete/'artifacts'/blob['sha256']).unlink()
        assert file_snapshot(incomplete)!=manifest['files']
        safe.update(rowHashesEqual=True,fileHashesEqual=True,tlsHashesEqual=True,negativeKeyCases=failed,
            incompleteSetHeld=True,controlTables=len(sql_source['tables']),controlRows=sum(t['rows'] for t in sql_source['tables'].values()),
            engineTables={k:len(v['tables']) for k,v in engine_source.items()},files=len(file_source),tlsFiles=len(tls_source),
            controlDumpBytes=manifest['controlArchive']['sizeBytes'])
        emit(stage='paired-data-verified',**safe)
        await asyncio.to_thread(engine.command,'up','-d','temporal');client=await engine.connect()
        handles=[client.get_workflow_handle(h.id) for h in handles]
        for i,h in enumerate(handles):assert (await h.describe()).run_id==engine_runs[i]
        # Visibility is restored from its independent archive, not synthesized by new starts.
        async with asyncio.timeout(30):
            while True:
                visible={w.id:w.run_id async for w in client.list_workflows()}
                if all(visible.get(h.id)==engine_runs[i] for i,h in enumerate(handles)):break
                await asyncio.sleep(.2)
        restored_histories=[await h.fetch_history() for h in handles]
        for original,current in zip(source_histories,restored_histories,strict=True):
            assert [e.SerializeToString(deterministic=True) for e in original.events]==[
                e.SerializeToString(deterministic=True) for e in current.events[:len(original.events)]]
        await replay(restored_histories)
        assert [counts(t['id']) for t in tasks]==external_before
        restored_api=await start_api(destination,target_db.dsn,restored,api)
        assert [restored_api.snapshot(t['id']) for t in tasks]==before
        running=await worker(destination/'worker',target_db.dsn,restored,restored=True)
        # A real Worker polls the restored histories while decisions remain unchanged.
        await asyncio.sleep(3)
        p=restored_api.snapshot(tasks[0]['id']);u=restored_api.snapshot(tasks[1]['id']);c=restored_api.snapshot(tasks[2]['id'])
        assert p['attention']=='approval' and next(a for a in p['actions'] if a['id']==pending[0]['id'])['decision']=='pending'
        assert len(p['actions'])==2 and counts(tasks[0]['id'])['writes']==0
        assert u['attention']=='reconciliation' and u['usage']==before[1]['usage']
        assert counts(tasks[1]['id'])['attempts']==2 and counts(tasks[1]['id'])['writes']==1
        assert c==before[2] and counts(tasks[2]['id'])==external_before[2]
        assert not (running.directory/'forbidden-apply').exists()
        restored_api.call('/api/v1/actions/'+pending[0]['id']+'/decision',dict(intentDigest=pending[0]['intentDigest'],approved=True))
        effects.repair_receipt(tasks[1]['id'])
        request=dict(intentDigest=pending[1]['intentDigest'],requestKey=secrets.token_hex(12),expectedSequence=0,reason='Verify original restored unknown CSV effect')
        repair_path='/api/v1/actions/'+pending[1]['id']+'/reconcile'
        repair=restored_api.call(repair_path,request,expected=202)
        assert restored_api.call(repair_path,request,expected=202)['id']==repair['id']
        for handle in handles[:2]:await asyncio.wait_for(handle.result(),100)
        final=[restored_api.snapshot(t['id']) for t in tasks];external_final=[counts(t['id']) for t in tasks]
        for index in (0,1):
            assert final[index]['status']=='completed' and final[index]['usage']==dict(tokenLimit=10,spentTokens=8,reservedTokens=0)
            assert len(final[index]['actions'])==3 and sum(a['id']==pending[index]['id'] for a in final[index]['actions'])==1
            assert external_final[index]['writes']==1 and external_final[index]['attempts']==3
            assert restored_api.call(final[index]['artifacts'][0]['downloadUrl'],raw=True)==b'row,value\n7,fixed\n'
            assert (await handles[index].describe()).run_id==engine_runs[index]
        assert final[2]==before[2] and external_final[2]==external_before[2]
        repair=restored_api.call(repair_path,request,expected=202)
        assert repair['delivered'] and repair['outcome']=='resolved'
        lookups=[json.loads(line)['actionId'] for line in (running.directory/'lookup-observations.jsonl').read_text().splitlines()]
        assert pending[1]['id'] in lookups and not (running.directory/'forbidden-apply').exists()
        running.kill();restored_api.close()
        histories=[await h.fetch_history() for h in handles]
        for i,h in enumerate(histories):private(destination/('history-'+str(i)+'.json'),json.loads(h.to_json()))
        sql_before=await asyncio.to_thread(snapshot,target_db.dsn)
        await replay(histories)
        payloads=sum(check_history(h) for h in histories)
        # Traverse decoded protobuf bytes in addition to the media fixture's sentinels.
        forbidden=[token.encode(),api.password.encode(),source_db.password.encode(),target_db.password.encode(),
            model['apiKey'].encode(),connection_data['resolved'].api_key.encode(),
            (restored/'objects/model-connections.key').read_bytes()]
        def private_payloads(message):
            if message.DESCRIPTOR.full_name=='temporal.api.common.v1.Payload':
                assert all(value not in message.data for value in forbidden)
            for field,value in message.ListFields():
                if field.message_type is None:continue
                if field.message_type.GetOptions().map_entry:
                    for child in value.values():
                        if hasattr(child,'ListFields'):private_payloads(child)
                elif field.is_repeated:
                    for child in value:private_payloads(child)
                else:private_payloads(value)
        for history in histories:
            for event in history.events:private_payloads(event)
        assert await asyncio.to_thread(snapshot,target_db.dsn)==sql_before
        assert [counts(t['id']) for t in tasks]==external_final
        for database in ('temporal','temporal_visibility'):
            flags=engine.sql(database,"SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user; SELECT has_schema_privilege(current_user,'public','CREATE');",runtime=True).stdout.decode().splitlines()
            assert flags==['f|f|f','f']
            for table in ('schema_version','schema_update_history'):
                assert engine.sql(database,f'DELETE FROM {table} WHERE false;',runtime=True,check=False).returncode!=0
        safe.update(case='active-paired-cold-restore',scope='actual product Worker + HTTP/PG/mTLS Temporal; scripted ports, no live provider',
            originalWorkflowRunAction=True,restoredVisibility=True,ownerApprovalAfterRestore=True,
            unknownOnlyOriginalLookup=True,unknownReservationPreserved=True,cancelNotRevived=True,
            pendingHistoryReplay='passed',terminalHistoryReplay='passed',offlineReplaySideEffects=0,
            originalHistoryPrefixPreserved=True,decodedPayloadsChecked=payloads,noMediaOrCredentialsInHistory=True,canonicalMigrations=canonical_count,
            externalBefore=external_before,externalAfter=external_final,runtimeSchemaAuthorityUnchanged=True,
            sourceAndDestinationExecutionNeverOverlap=True,elapsedSeconds=round(time.monotonic()-started,2))
        private(output/'evidence.json',safe);emit(stage='active-restore-complete',**safe)
    finally:
        for child in reversed(processes):
            try:child.kill()
            except Exception as error:cleanup.append(type(error).__name__)
        if effects:
            try:effects.close()
            except Exception as error:cleanup.append(type(error).__name__)
        try:await asyncio.to_thread(engine.close)
        except Exception as error:cleanup.append(type(error).__name__)
        for database in (target_db,source_db):
            if database:
                try:await asyncio.to_thread(database.close)
                except Exception as error:cleanup.append(type(error).__name__)
        alive=[p.process.pid for p in processes if p.process.poll() is None]
        private(output/'cleanup.json',dict(errors=cleanup,aliveProcesses=alive,ownedResourcesRemoved=not cleanup and not alive))
        emit(stage='cleanup',errors=cleanup,aliveProcesses=alive)
        if cleanup or alive:raise AssertionError('Owned fixture cleanup incomplete')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    async def bounded():
        async with asyncio.timeout(600):await qualify(args.repo.resolve(),args.output.resolve())
    asyncio.run(bounded())


if __name__=='__main__':main()
