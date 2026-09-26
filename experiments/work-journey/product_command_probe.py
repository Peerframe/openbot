"""Actual product journey; default local synthetic Native, explicit remote qualification opt-in."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
from urllib.request import Request
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/server-python/src'),str(ROOT/'apps/agent-runtime-python/src')]
import psycopg
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding,PrivateFormat,PublicFormat,NoEncryption
from temporalio.worker import Replayer
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from active_restore_probe import ControlDatabase,private
from postgres_server import PostgresServer
from product_http_fixture import API,Process
from product_command_fixture import CSV,SUMMARY,REPORT,ARGUMENTS
from product_command_local_host import LocalHost
from product_command_remote import RemoteHost, RemoteOptions
from openbot_server.work_worker import OpenBotWork


def emit(**value):print(json.dumps(value),flush=True)


async def qualify(directory,bundle,remote_options=None):
    os.umask(0o077)
    if directory.exists():raise ValueError('Use a new owned output directory')
    directory.mkdir(mode=0o700)
    for child in ('artifacts','objects','provider','host'):(directory/child).mkdir(mode=0o700)
    postgres=ControlDatabase(directory,'command-product',
        'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0')
    engine=None;api=None;host=None;node=None;node_log=None;enrollment_issued=False
    remote=RemoteHost(remote_options,directory) if remote_options else None
    route=dict(nodeId='command-product-'+secrets.token_hex(6),providerId='linux-command',
        enforcementKeyId='product-enforcer-key',ledgerId=str(uuid4()))
    timing=dict(prepareBudgetMs=30000,challengeBudgetMs=5000,runtimeMaxMs=50000,stopAllowanceMs=5000,
        clockRateErrorPpm=1000,clockQuantizationMs=100,policyDigest='e'*64)
    keys={}
    for name in (('control',) if remote else ('control','enforcer')):
        key=Ed25519PrivateKey.generate()
        keys[name]=(key.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption()),
                    key.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))
    control=directory/'control.pem';control.write_bytes(keys['control'][0])
    pin=directory/'enforcer.pub'
    command_config=directory/'command.json'
    try:
        pin.write_bytes(await remote.stage(route,timing,keys['control'][1],bundle) if remote else keys['enforcer'][1])
        private(command_config,dict(version=1,route=route,timing=timing,
            policy=dict(id='offline-command',image='python@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af',
                limits=dict(nanoCPUs=1000000000,memoryMiB=256,pids=128,nofile=64,tmpMiB=16,
                            wallSeconds=60,outputMiB=64,capturedOutputKiB=1024)),
            control=dict(issuer='product-control',keyId='product-control-key',privateKeyPath=str(control)),
            enforcement=dict(issuer='product-enforcer',keyId=route['enforcementKeyId'],publicKeyPath=str(pin))))
        await asyncio.to_thread(postgres.start);await asyncio.to_thread(postgres.migrate,ROOT)
        with psycopg.connect(postgres.dsn) as db:
            canonical_migrations = db.execute('SELECT count(*) FROM drizzle.__drizzle_migrations').fetchone()[0]
        engine=PostgresServer(directory,mtls=True)
        engine.release_overlay=ROOT/'experiments/work-journey/terminal-recovery/resources.yaml'
        await asyncio.to_thread(engine.start);client=await engine.connect()
        emit(stage='engine-ready',actualPostgres=True,mutualTLS=True)
        engine_config=directory/'engine.json'
        private(engine_config,dict(temporal_address=engine.address,namespace='default',queue='product-command-'+secrets.token_hex(6),
            tls=engine.client_settings,interval_seconds=1,execution_timeout_seconds=600))
        provider_config=directory/'provider.json';private(provider_config,dict(directory=str(directory/'provider')))
        api=API(directory,postgres.dsn,directory/'artifacts')
        api.env.update(OPENBOT_CONTROL_AUTHORITY='product',OPENBOT_CONTROL_WORK_TOKEN_LIMIT='1000000',
            OPENBOT_CONTROL_OBJECT_ROOT=str(directory/'objects'),OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH=str(engine_config),
            OPENBOT_CONTROL_COMMAND_CONFIG_PATH=str(command_config),OPENBOT_COMMAND_PROBE_CONFIG=str(provider_config))
        api.child=Process([sys.executable,'-u','-B',str(Path(__file__).with_name('product_command_server.py'))],api.directory,api.env)
        async def until(function,seconds=75):
            deadline=time.monotonic()+seconds
            while time.monotonic()<deadline:
                api.child.alive()
                try:result=await asyncio.to_thread(function)
                except OSError:result=None
                if result:return result
                await asyncio.sleep(.2)
            raise AssertionError('Product command checkpoint timed out; private evidence retained')
        await until(lambda:api.call('/health').get('ok'),45)
        await asyncio.to_thread(api.call,'/api/v1/auth/login',dict(password=api.password))
        connection=(await asyncio.to_thread(api.call,'/api/v1/model-connections',dict(name='Synthetic command model',
            presetId='openai',baseUrl='https://api.openai.com/v1',apiKey='synthetic-command-key'),expected=201))['connection']
        bot=(await asyncio.to_thread(api.call,'/api/v1/bots',dict(name='Command product fixture',role='Synthetic evidence analyst',
            computerProfile='docker-linux',model=dict(connectionId=connection['id'],modelId='synthetic-command-model')),expected=201))['bot']
        channel=(await asyncio.to_thread(api.call,'/api/v1/channels',dict(name='Command qualification',botIds=[bot['id']]),expected=201))['channel']
        def upload():
            request=Request(api.url+f'/api/v1/channels/{channel["id"]}/attachments',CSV,
                {'Content-Type':'application/octet-stream','Origin':api.url,'X-OpenBot-Filename':'evidence.csv'})
            with api.opener.open(request,timeout=5) as response:
                assert response.status==201
                return json.load(response)['attachment']
        attachment=await asyncio.to_thread(upload)
        enrollment=await asyncio.to_thread(api.call,'/api/v1/nodes/enrollment-tokens',dict(nodeId=route['nodeId']),expected=201)
        enrollment_issued=True
        if remote:
            await remote.start(enrollment.pop('token'),int(api.url.rsplit(':',1)[1]))
        else:
            host=LocalHost(directory/'host',route,timing,keys['control'][1],keys['enforcer'][0])
            node_log=(directory/'node.log').open('w')
            node=subprocess.Popen(['node',str(bundle)],stdin=subprocess.PIPE,stdout=node_log,stderr=subprocess.STDOUT,start_new_session=True)
            node.stdin.write(json.dumps(dict(version=1,nodeId=route['nodeId'],serverUrl=api.url.replace('http:','ws:')+'/ws/nodes',
                socketPath=str(host.socket),selection=route,enrollmentToken=enrollment.pop('token'))).encode());node.stdin.close()
        await until(lambda:any(n['id']==route['nodeId'] for n in api.call('/api/v1/nodes')['nodes']),15)
        emit(stage='actual-node-connected',ephemeralEnrollment=True,realWebSocket=True,syntheticNative=remote is None)
        source=await asyncio.to_thread(api.call,f'/api/v1/channels/{channel["id"]}/messages',dict(botId=bot['id'],
            content='Copy the authorized CSV to result.csv using run_command, then calculate the sum and write a Markdown report. '
                    'Preserve all source rows. [OpenBot attachment: '+attachment['id']+']'),expected=201)
        with psycopg.connect(postgres.dsn) as db:
            tid,rid=db.execute('SELECT s.task_id,r.id FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id WHERE s.legacy_run_id=%s',
                (source['run']['id'],)).fetchone()
        private(directory/'identity.json',dict(taskId=tid,runId=rid,sourceRunId=source['run']['id'],route=route))
        def proposed():
            snapshot=api.snapshot(tid)
            assert snapshot['status'] not in ('failed','cancelled')
            return next((a for a in snapshot['actions'] if a['intent'].get('tool')=='run_command'),None)
        action=await until(proposed)
        assert action['status']=='proposed' and action['decision']=='pending'
        if remote:await remote.assert_unprepared()
        else:assert not host.calls
        assert action['intent']['arguments']==ARGUMENTS
        await asyncio.to_thread(api.call,f'/api/v1/actions/{action["id"]}/decision',dict(intentDigest=action['intentDigest'],approved=True))
        emit(stage='owner-approved-original-intent',noExecutionBeforeApproval=True)
        def completed():
            value=api.snapshot(tid)
            private(directory/'latest-snapshot.json',value)
            assert value['status'] not in ('failed','cancelled')
            return value if value['status']=='completed' else None
        snapshot=await until(completed)
        assert snapshot['resultSummary']==SUMMARY and len(snapshot['artifacts'])==2
        expected={'result.csv':CSV,'command-report.md':REPORT.encode()}
        for artifact in snapshot['artifacts']:
            assert await asyncio.to_thread(api.call,artifact['downloadUrl'],raw=True)==expected[artifact['name']]
        if host:assert host.calls.count('execute')==1 and host.calls.count('reserve')==1
        counts=json.loads((directory/'provider/provider-count.json').read_text())
        assert counts==dict(command=1,report=1,final=1,review=1)
        handle=client.get_workflow_handle('openbot-work-v1-'+rid)
        result=await asyncio.wait_for(handle.result(),20);assert result['status']=='completed'
        with psycopg.connect(postgres.dsn) as db:
            assert db.execute('SELECT count(*) FROM work_command_preparations WHERE task_id=%s',(tid,)).fetchone()[0]==1
            assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='command.permit_issued'",(tid,)).fetchone()[0]==1
            assert db.execute('SELECT status FROM work_actions WHERE id=%s',(action['id'],)).fetchone()==('applied',)
            if remote:
                rows=db.execute('SELECT binding FROM work_command_preparations WHERE task_id=%s AND action_id=%s',
                    (tid,action['id'])).fetchall()
                assert len(rows)==1
                binding=rows[0][0]
                assert all(binding[k]==v for k,v in dict(taskId=tid,runId=rid,actionId=action['id'],
                    intentDigest=action['intentDigest'],**route).items())
        history=await handle.fetch_history();(directory/'history.json').write_text(history.to_json())
        with ThreadPoolExecutor(max_workers=2) as executor:
            await Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor).replay_workflow(history)
        assert json.loads((directory/'provider/provider-count.json').read_text())==counts
        if host:assert host.calls.count('execute')==1
        if remote:
            remote_evidence=await remote.finish(binding)
            private(directory/'remote-result.json',remote_evidence)
        record=dict(case='product-command-remote-composition' if remote else 'product-command-local-composition',actualOwnerHTTP=True,actualWorkApproval=True,
            actualPostgres=True,canonicalMigrations=canonical_migrations,mutualTLS=True,actualProductEntry=True,actualNodeClient=True,
            actualWebSocket=True,actualUnixTransport=True,actualHostCrypto=True,syntheticNative=remote is None,syntheticPeerIdentity=remote is None,
            linuxIsolationQualified=remote is not None,oneOriginalCommand=True,fullOutputSha256=hashlib.sha256(CSV).hexdigest(),
            independentlyReviewed=True,artifactsDownloaded=2,offlineReplay=True,modelCounts=counts)
        private(directory/'result.json',record);emit(**record)
    finally:
        failing=sys.exc_info()[0] is not None
        cleanup_errors=[]
        async def cleanup(label,operation):
            try:await operation()
            except Exception:cleanup_errors.append(label)
        async def close_node():
            if node and node.poll() is None:
                os.killpg(node.pid,signal.SIGTERM)
                try:await asyncio.to_thread(node.wait,5)
                except subprocess.TimeoutExpired:os.killpg(node.pid,signal.SIGKILL);await asyncio.to_thread(node.wait,5)
            if node_log:node_log.close()
        await cleanup('node',close_node)
        if remote:await cleanup('remote-original-run',remote.close)
        async def revoke_node():
            # Waited/stopped the original peer before reading, so a late enroll cannot race this check.
            identities=(await asyncio.to_thread(api.call,'/api/v1/node-identities'))['identities']
            own=[v for v in identities if v['nodeId']==route['nodeId']]
            assert len(own)<=1
            if own and own[0]['status']=='active':
                await asyncio.to_thread(api.call,f'/api/v1/nodes/{route["nodeId"]}/revoke',{},expected=204)
        if api and enrollment_issued:await cleanup('node-revocation',revoke_node)
        if host:await cleanup('host',lambda:asyncio.to_thread(host.close))
        if api:await cleanup('api',lambda:asyncio.to_thread(api.close))
        if engine:await cleanup('engine',lambda:asyncio.to_thread(engine.close))
        await cleanup('postgres',lambda:asyncio.to_thread(postgres.close))
        control.unlink(missing_ok=True)
        emit(stage='owned-resources-closed',controlPrivateKeyRemoved=True,cleanupComplete=not cleanup_errors,cleanupFailures=cleanup_errors)
        if cleanup_errors and not failing:raise AssertionError('Owned cleanup failed: '+','.join(cleanup_errors))


def arguments(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--node-bundle',required=True,type=Path)
    parser.add_argument('--remote-ssh-target')
    parser.add_argument('--remote-ssh-identity',type=Path)
    parser.add_argument('--remote-known-hosts',type=Path)
    parser.add_argument('--remote-server-port',type=int)
    parser.add_argument('--remote-fixture-name',help='Explicit fresh product1..product999 directory under the fixed remote base.')
    parser.add_argument('--remote-upload-authorized',action='store_true',
        help='Acknowledge fresh operator authorization for the separately reviewed uploaded fixture; does not upload.')
    options=parser.parse_args(argv)
    remote=None
    values=(options.remote_ssh_identity,options.remote_known_hosts,options.remote_server_port,options.remote_fixture_name)
    if options.remote_ssh_target:
        if any(v is None for v in values):parser.error('All explicit remote connection options are required')
        try:remote=RemoteOptions(options.remote_ssh_target,options.remote_ssh_identity,
            options.remote_known_hosts,options.remote_server_port,options.remote_upload_authorized,options.remote_fixture_name)
        except ValueError as error:parser.error(str(error))
    elif any(v is not None for v in values) or options.remote_upload_authorized:
        parser.error('Remote options require an explicit --remote-ssh-target')
    return options,remote


if __name__=='__main__':
    options,remote=arguments()
    asyncio.run(qualify(options.output.resolve(),options.node_bundle.resolve(),remote))
