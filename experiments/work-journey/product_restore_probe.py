"""Owned, stopped product snapshot: native PostgreSQL archive plus paired private files."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
from urllib.parse import urlsplit,unquote
from uuid import uuid4

IMAGE='postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'
CONNECTION_ENDPOINT='https://restore-model.invalid/v1'


def no_provider(*_args,**_kwargs):
    raise AssertionError('Provider network is forbidden in the restoration fixture')


async def connection_service(dsn,path):
    from openbot_server.model_connections import ModelConnectionsService
    return await ModelConnectionsService.from_key_path(dsn,path,
        custom_base_urls=(CONNECTION_ENDPOINT,),transport_factory=no_provider)


def record(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2));path.chmod(0o600)


def docker(args, data=None):
    result=subprocess.run(['docker',*args],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if result.returncode or len(result.stdout)>32*1024*1024:
        raise AssertionError('Owned PostgreSQL tool failed; output suppressed')
    return result.stdout


def inspect_container(name,dsn):
    if not re.fullmatch(r'openbot-[a-z0-9-]{1,100}',name):raise ValueError('Explicit fixture container required')
    raw=docker(['container','inspect',name,'--format','{{json .Id}}\n{{json .Name}}\n{{json .NetworkSettings.Ports}}\n{{json .Config.Image}}'])
    identity,actual,ports,image=(json.loads(line) for line in raw.decode().splitlines())
    parsed=urlsplit(dsn)
    role=unquote(parsed.username or '')
    assert re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,62}',role)
    assert re.fullmatch('[a-f0-9]{64}',identity) and actual=='/'+name and image==IMAGE
    assert parsed.hostname=='127.0.0.1' and re.fullmatch('/openbot_control_test_[a-z0-9_]+',parsed.path)
    assert ports['5432/tcp']==[{'HostIp':'127.0.0.1','HostPort':str(parsed.port)}]
    version=docker(['exec',identity,'pg_dump','--version']).decode().strip()
    assert version.startswith('pg_dump (PostgreSQL) 17.11 ')
    return identity,parsed.path[1:],version,role


def snapshot(dsn):
    import psycopg
    from psycopg import sql
    result={'tables':{},'sequences':{}}
    with psycopg.connect(dsn,options='-c timezone=UTC -c statement_timeout=5000') as db:
        db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        names=db.execute("SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' "
            "AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name").fetchall()
        assert len(names)<=256
        for schema,name in names:
            assert schema in ('public','drizzle')
            rows=db.execute(sql.SQL('SELECT to_jsonb(t)::text FROM {}.{} t ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 10001')
                .format(sql.Identifier(schema),sql.Identifier(name))).fetchall()
            assert len(rows)<=10000
            encoded=json.dumps([row[0] for row in rows],ensure_ascii=False,separators=(',',':')).encode()
            assert len(encoded)<=16*1024*1024
            result['tables'][schema+'.'+name]={'rows':len(rows),'sha256':hashlib.sha256(encoded).hexdigest()}
        sequences=db.execute("SELECT sequence_schema,sequence_name FROM information_schema.sequences "
            "WHERE sequence_schema IN ('public','drizzle') ORDER BY sequence_schema,sequence_name").fetchall()
        for schema,name in sequences:
            result['sequences'][schema+'.'+name]=list(db.execute(sql.SQL('SELECT last_value,is_called FROM {}.{}')
                .format(sql.Identifier(schema),sql.Identifier(name))).fetchone())
    return result


def file_snapshot(root):
    result={};total=0
    for path in sorted(root.rglob('*')):
        info=path.lstat();mode=stat.S_IMODE(info.st_mode)
        assert not path.is_symlink() and not mode&0o077
        if stat.S_ISDIR(info.st_mode):continue
        assert stat.S_ISREG(info.st_mode) and info.st_size<=8*1024*1024
        data=path.read_bytes();total+=len(data)
        assert len(result)<512 and total<=64*1024*1024
        result[str(path.relative_to(root))]={'sizeBytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mode':mode}
    return result


async def seed_disabled_plugin(directory):
    from openbot_server.plugin_store import FilePluginStore
    from openbot_server.plugin_inputs import now,audit
    store=FilePluginStore(directory/'objects/plugins/state.json')
    assert await store.read()=={'plugins':[],'audit':[]}
    identity=str(uuid4())
    def change(state):
        state['plugins'].append(dict(id=identity,name='Synthetic restore fixture only',endpoint='https://restore.invalid/mcp',
            digest='a'*64,revision=str(uuid4()),enabled=False,createdAt=now(),token='synthetic-disabled-plugin-restore-token',
            tools=[],grants=[]))
        audit(state,'fixture.restore.seed',identity)
    await store.transaction(change)
    return await store.read()


@asynccontextmanager
async def connection_fixture(dsn,directory,token,output):
    """Owner service writes only; separate model Bot never changes the completed media source."""
    import psycopg
    from openbot_server.identity_inputs import CreateBotInput
    from openbot_server.identity_store import PostgresIdentityStore
    path=directory/'objects/model-connections.key'
    service=await connection_service(dsn,path)
    assert (await service.snapshot(token))['connections']==[]
    assert path.stat().st_size==32 and stat.S_IMODE(path.stat().st_mode)==0o600
    owned={'connectionId':None,'profileBotId':None,'connectionRemoved':False,'profileRemoved':False}
    record(output/'connection-ownership.json',owned)
    try:
        key='synthetic-restore-'+secrets.token_hex(16)
        connection=await service.create(token,dict(name='Synthetic paired restoration',presetId='custom',
            baseUrl=CONNECTION_ENDPOINT,apiKey=key))
        owned['connectionId']=connection['id'];record(output/'connection-ownership.json',owned)
        assert connection['enabled'] and connection['hasApiKey'] and connection['revision']==1
        assert key not in json.dumps(connection)
        selection=dict(connectionId=connection['id'],modelId='synthetic-restore-model')
        bot=await PostgresIdentityStore(dsn,model_connections=service).create_bot(token,CreateBotInput(
            name='Synthetic connection restore profile',role='Local restore fixture only',
            computerProfile='model',model=selection))
        owned['profileBotId']=bot.id;record(output/'connection-ownership.json',owned)
        resolved=await service.resolve(token,selection,expected_revision=connection['revision'])
        assert resolved.api_key==key and resolved.source=='saved' and resolved.model_id==selection['modelId']
        with psycopg.connect(dsn) as db:
            encrypted=db.execute('SELECT encrypted_api_key FROM model_connections WHERE id=%s',(connection['id'],)).fetchone()[0]
            assert encrypted.startswith('v1.') and key not in encrypted
        yield dict(public=connection,selection=selection,bot=bot.model_dump(mode='json'),resolved=resolved)
    finally:
        with psycopg.connect(dsn) as db:
            if owned['profileBotId']:
                assert not db.execute('SELECT 1 FROM work_tasks WHERE bot_id=%s',(owned['profileBotId'],)).fetchone()
                db.execute('DELETE FROM run_events WHERE bot_id=%s',(owned['profileBotId'],))
                db.execute('DELETE FROM bots WHERE id=%s',(owned['profileBotId'],))
                owned['profileRemoved']=True
            if owned['connectionId']:
                db.execute("DELETE FROM run_events WHERE type='MODEL_CONNECTION_CREATED' AND payload->>'id'=%s",(owned['connectionId'],))
                db.execute('DELETE FROM model_connections WHERE id=%s',(owned['connectionId'],))
                owned['connectionRemoved']=True
        record(output/'connection-ownership.json',owned)


async def verify_connection(dsn,root,token,connection):
    from openbot_server.database import PostgresReadStore
    import psycopg
    path=root/'objects/model-connections.key'
    assert path.stat().st_size==32 and stat.S_IMODE(path.stat().st_mode)==0o600
    service=await connection_service(dsn,path)
    snapshot=await service.snapshot(token)
    assert snapshot['connections']==[connection['public']]
    rows=(await PostgresReadStore(dsn).read(token,'bots')).rows
    bot=next(row for row in rows if row['id']==connection['bot']['id'])
    assert bot['computer_profile']=='model' and bot['configuration']['model']==connection['selection']
    actual=await service.resolve(token,bot['configuration']['model'],expected_revision=connection['public']['revision'])
    assert actual==connection['resolved']
    assert actual.api_key not in json.dumps(snapshot)
    with psycopg.connect(dsn) as db:
        assert db.execute("SELECT count(*) FROM run_events WHERE type='MODEL_CONNECTION_CREATED' AND payload->>'id'=%s",
            (connection['public']['id'],)).fetchone()[0]==1
        assert db.execute("SELECT count(*) FROM run_events WHERE type='BOT_CREATED' AND bot_id=%s",(bot['id'],)).fetchone()[0]==1


async def verify_python(dsn,root,token,task_id,channel_id,attachments,model,plugin,connection):
    from openbot_server.database import PostgresReadStore
    from openbot_server.work_store import PostgresWorkStore
    from openbot_server.work_files import LocalWorkFiles
    from openbot_server.owner_files import OwnerFiles
    from openbot_server.model_settings import ModelSettingsService
    from openbot_server.plugin_store import FilePluginStore
    from product_media_fixture import REPORT,SUMMARY,originals
    import psycopg
    store=PostgresReadStore(dsn);await store.verify_schema()
    assert (await store.read(token,'session')).expires_at is not None
    assert (await store.read('A'*43,'session')).expires_at is None
    files=LocalWorkFiles(root/'artifacts');files.verify()
    task=await PostgresWorkStore(dsn,files=files).snapshot(token,task_id)
    assert task['status']=='completed' and task['resultSummary']==SUMMARY and len(task['artifacts'])==1
    report=task['artifacts'][0]
    assert files.read(report['sha256'],report['sizeBytes'])==REPORT.encode()
    blobs=0
    for path in sorted((root/'artifacts').iterdir()):
        assert re.fullmatch('[0-9a-f]{64}',path.name)
        files.read(path.name,path.stat().st_size);blobs+=1
    assert blobs>=4
    with psycopg.connect(dsn) as db:
        for table in ('work_model_receipts','work_tool_results','work_artifacts'):
            rows=db.execute('SELECT sha256,size_bytes FROM '+table+' WHERE task_id=%s',(task_id,)).fetchall()
            assert rows
            for digest,size in rows:files.read(digest,size)
        assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='task.completed'",(task_id,)).fetchone()[0]==1
        assert db.execute('SELECT count(*) FROM messages WHERE id=%s',('work-result:'+task_id,)).fetchone()[0]==1
        assert db.execute('SELECT count(*) FROM run_events WHERE channel_id=%s',(channel_id,)).fetchone()[0]>0
    owner_files=OwnerFiles(root/'objects/attachments')
    async with owner_files.lock():
        for descriptor,(name,mime,data) in zip(attachments,originals(),strict=True):
            actual,content=owner_files.read(channel_id,descriptor['id'])
            assert actual==descriptor and content==data and actual['name']==name and actual['mediaType']==mime
    assert await ModelSettingsService(root/'model').active()==model
    assert await FilePluginStore(root/'objects/plugins/state.json').read()==plugin
    await verify_connection(dsn,root,token,connection)
    return blobs


async def negative_keys(root,directory):
    from openbot_server.model_settings import ModelSettingsService,ModelSettingsError
    from openbot_server.plugin_store import FilePluginStore
    from openbot_server.plugin_inputs import PluginError
    results=[]
    for kind in ('model','plugin'):
        for mutation in ('missing','wrong'):
            destination=directory/(kind+'-'+mutation)
            source=root/'model' if kind=='model' else root/'objects/plugins'
            shutil.copytree(source,destination)
            key=destination/('encryption.key' if kind=='model' else 'state.json.key')
            if mutation=='missing':key.unlink()
            else:key.write_bytes(secrets.token_hex(32).encode() if kind=='model' else secrets.token_bytes(32))
            try:
                if kind=='model':await ModelSettingsService(destination).active()
                else:await FilePluginStore(destination/'state.json').read()
            except (ModelSettingsError,PluginError):results.append(kind+'-'+mutation)
            else:raise AssertionError('Incomplete paired key unexpectedly readable')
    return results


async def negative_connection_keys(dsn,root,directory,token,connection):
    from openbot_server.control_errors import ControlError
    failures=[]
    for mutation in ('missing','wrong'):
        destination=directory/('connection-'+mutation);destination.mkdir(mode=0o700)
        key=destination/'model-connections.key'
        if mutation=='wrong':
            original=(root/'objects/model-connections.key').read_bytes()
            key.write_bytes(bytes([original[0]^1])+original[1:]);key.chmod(0o600)
        try:
            service=await connection_service(dsn,key)
            # Missing key must refuse at loading, not be regenerated and fail later.
            assert mutation!='missing'
            await service.resolve(token,connection['selection'],expected_revision=connection['public']['revision'])
        except ControlError as error:
            assert error.status==503 and error.code=='model_credential_unavailable'
            if mutation=='missing':assert not key.exists()
            failures.append('connection-'+mutation)
        else:raise AssertionError('Incomplete connection key pair unexpectedly readable')
    return failures


async def qualify_restore(dsn,directory,container,token,task_id,channel_id,attachments,*,stopped):
    assert stopped
    output=directory/'restore';output.mkdir(mode=0o700)
    await asyncio.to_thread(inspect_container,container,dsn)
    async with connection_fixture(dsn,directory,token,output) as connection:
        return await _qualify_restore(dsn,directory,container,token,task_id,channel_id,attachments,connection,stopped=stopped)


async def _qualify_restore(dsn,directory,container,token,task_id,channel_id,attachments,connection,*,stopped):
    """Only invoked after the caller joins its product process; no background writers permitted."""
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    from openbot_server.model_settings import ModelSettingsService
    assert stopped
    output=directory/'restore'
    identity,source_name,version,role=await asyncio.to_thread(inspect_container,container,dsn)
    target_name='openbot_control_test_restore_'+uuid4().hex
    target_dsn=make_conninfo(dsn,dbname=target_name)
    ownership={'containerId':identity,'containerName':container,'sourceDatabase':source_name,'restoreDatabase':target_name,'created':False,'dropped':False}
    record(output/'ownership.json',ownership)
    with psycopg.connect(dsn) as db:
        assert db.execute('SHOW server_version_num').fetchone()[0]=='170011'
        assert db.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()').fetchone()[0]==0
        assert db.execute("SELECT count(*) FROM work_tasks WHERE status<>'completed'").fetchone()[0]==0
    plugin=await seed_disabled_plugin(directory)
    model=await ModelSettingsService(directory/'model').active();assert model and model['agentEnabledAt']
    before=await asyncio.to_thread(snapshot,dsn)
    assert before['tables']['drizzle.__drizzle_migrations']['rows']==40
    backup=output/'backup';backup.mkdir(mode=0o700)
    paired=backup/'paired';paired.mkdir(mode=0o700)
    for name in ('artifacts','objects','model'):shutil.copytree(directory/name,paired/name)
    files_before=file_snapshot(paired)
    archive=await asyncio.to_thread(docker,['exec',identity,'pg_dump','-U',role,'-d',source_name,
        '--format=custom','--no-owner','--no-privileges'])
    assert archive.startswith(b'PGDMP')
    (backup/'database.dump').write_bytes(archive);(backup/'database.dump').chmod(0o600)
    record(backup/'manifest.json',{'version':1,'snapshot':'completed-product-stopped','databaseSha256':hashlib.sha256(archive).hexdigest(),
        'database':before,'files':files_before})
    assert await asyncio.to_thread(snapshot,dsn)==before
    restored=output/'restored'
    try:
        with psycopg.connect(dsn,autocommit=True) as db:
            assert not db.execute('SELECT 1 FROM pg_database WHERE datname=%s',(target_name,)).fetchone()
            db.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(target_name)))
            ownership['created']=True
            ownership['databaseOid']=db.execute('SELECT oid FROM pg_database WHERE datname=%s',(target_name,)).fetchone()[0]
        record(output/'ownership.json',ownership)
        assert snapshot(target_dsn)=={'tables':{},'sequences':{}}
        assert hashlib.sha256((backup/'database.dump').read_bytes()).hexdigest()==json.loads((backup/'manifest.json').read_text())['databaseSha256']
        await asyncio.to_thread(docker,['exec','-i',identity,'pg_restore','-U',role,'-d',target_name,
            '--single-transaction','--exit-on-error','--no-owner','--no-privileges'],archive)
        shutil.copytree(paired,restored)
        assert file_snapshot(restored)==files_before
        assert await asyncio.to_thread(snapshot,target_dsn)==before
        blob_count=await verify_python(target_dsn,restored,token,task_id,channel_id,attachments,model,plugin,connection)
        failed_closed=await negative_keys(restored,output)
        failed_closed+=await negative_connection_keys(target_dsn,restored,output,token,connection)
        assert await asyncio.to_thread(snapshot,target_dsn)==before
        assert await asyncio.to_thread(snapshot,dsn)==before
        assert file_snapshot(restored)==files_before
        result=dict(case='product-completed-paired-restore-v1',stoppedProduct=True,actualNativeDumpRestore=True,
            postgresVersion=version,allTableRowHashesEqual=True,tableCount=len(before['tables']),
            rowCount=sum(item['rows'] for item in before['tables'].values()),sequenceStateEqual=True,
            canonicalMigrations=40,pairedFileHashesEqual=True,pairedFileCount=len(files_before),
            actualTaskRead=True,actualOwnerAuthentication=True,actualMediaReads=2,actualBlobReads=blob_count,
            actualSettingsDecryption=True,actualDisabledPluginDecryption=True,pluginAuditRows=len(plugin['audit']),
            actualSqlAuditPreserved=True,enabledSavedConnections=1,actualModelProfileRead=True,
            actualConnectionResolve=True,connectionSecretAndProvenanceEqual=True,connectionKeyBytes=32,
            connectionMissingKeyNotRegenerated=True,connectionKeyErrorCode='model_credential_unavailable',
            connectionProviderRequests=0,keyFailuresClosed=failed_closed,activeTemporalRestore=False)
        record(output/'result.json',result);print(json.dumps(result),flush=True)
        return result
    finally:
        if ownership['created']:
            assert inspect_container(container,dsn)[0]==identity
            with psycopg.connect(dsn,autocommit=True) as db:
                assert db.execute('SELECT oid FROM pg_database WHERE datname=%s',(target_name,)).fetchone()==(ownership['databaseOid'],)
                db.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(target_name)))
                assert not db.execute('SELECT 1 FROM pg_database WHERE datname=%s',(target_name,)).fetchone()
            ownership['dropped']=True;record(output/'ownership.json',ownership)
