"""Explicit disposable-container product qualification; no existing DB, external model or SSH."""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import time

HERE=Path(__file__).resolve().parent
PYTHON='/opt/openbot/venv/bin/python'


def docker(*args,input=None,timeout=30,check=True):
    result=subprocess.run(['docker',*args],input=input,capture_output=True,timeout=timeout)
    if check and result.returncode:raise RuntimeError('docker_operation_failed:'+args[0])
    return result.stdout.decode().strip()


def inspect(name):return json.loads(docker('inspect',name))[0]


def ready(name):
    until=time.monotonic()+80
    while time.monotonic()<until:
        state=inspect(name)['State']
        if state.get('Health',{}).get('Status')=='healthy':return
        if state['Status']!='running':raise RuntimeError('container_stopped_before_healthy')
        time.sleep(.5)
    raise RuntimeError('container_health_deadline')


def stopped(name):
    until=time.monotonic()+25
    while time.monotonic()<until:
        state=inspect(name)['State']
        if state['Status']!='running':
            if state['ExitCode']==0:raise RuntimeError('invalid_preflight_succeeded')
            return
        time.sleep(.25)
    raise RuntimeError('invalid_preflight_did_not_stop')


def qualify(image):
    # Image must already exist. The script does not build or select another image as a fallback.
    metadata=json.loads(docker('image','inspect',image))[0]
    assert metadata['Config']['User']=='1000:1000'
    suffix=secrets.token_hex(6);prefix='openbot-product-smoke-'+suffix
    network=prefix+'-net';pg=prefix+'-pg';server=prefix+'-api';volume=prefix+'-state'
    created=[];made_network=made_volume=False;result=None;cleanup=[]
    try:
        docker('network','create','--internal',network);made_network=True
        docker('volume','create',volume);made_volume=True
        created.append(pg)
        docker('run','-d','--name',pg,'--network',network,'--tmpfs','/var/lib/postgresql/data',
            '-e','POSTGRES_DB=openbot','-e','POSTGRES_USER=openbot','-e','POSTGRES_PASSWORD=synthetic-product-db',
            '--health-cmd','pg_isready -U openbot -d openbot','--health-interval','1s','--health-timeout','3s',
            '--health-retries','60','postgres:17.11-bookworm');ready(pg)
        dsn='postgres://openbot:synthetic-product-db@'+pg+':5432/openbot'
        common=['--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
            '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700',
            '--mount','type=volume,src='+volume+',dst=/var/lib/openbot','-e','OPENBOT_CONTROL_DATABASE_URL='+dsn,
            '-e','OPENBOT_CONTROL_COOKIE_MODE=loopback','-e','OPENBOT_CONTROL_ALLOWED_ORIGINS=http://localhost:3001']
        def sql(statement):return docker('exec',pg,'psql','-U','openbot','-d','openbot','-Atc',statement)
        for kind in ('missing-owner','invalid-origin','invalid-temporal','broken-python'):
            name=prefix+'-'+kind
            args=[*common]
            if kind!='missing-owner':args+=['-e','OPENBOT_CONTROL_OWNER_PASSWORD=openbot-product-smoke-synthetic-owner']
            if kind=='invalid-origin':args+=['-e','OPENBOT_CONTROL_ALLOWED_ORIGINS=*']
            if kind=='invalid-temporal':args+=['-e','OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH=/missing-private-temporal.json']
            if kind=='broken-python':args+=['--tmpfs','/opt/openbot/venv/lib/python3.12/site-packages:ro,noexec,size=1m']
            created.append(name)
            docker('run','-d','--name',name,*args,image);stopped(name)
            assert sql("select count(*) from pg_namespace where nspname='drizzle'")=='0'
        created.append(server)
        docker('run','-d','--name',server,*common,'-e','OPENBOT_CONTROL_OWNER_PASSWORD=openbot-product-smoke-synthetic-owner',image)
        ready(server)
        assert sql('select count(*) from drizzle.__drizzle_migrations')=='43'
        before=sql('select hash,created_at from drizzle.__drizzle_migrations order by id')
        client=(HERE/'product-smoke-client.py').read_bytes()
        first=json.loads(docker('exec','-i',server,PYTHON,'-I','-B','-',f'http://{server}:3001','create',input=client,timeout=150))
        state=inspect(server);assert state['HostConfig']['ReadonlyRootfs'] and state['Config']['User']=='1000:1000'
        assert docker('exec',server,'/usr/local/bin/node','--version')=='v24.21.0'
        docker('exec',server,PYTHON,'-I','-B','/workspace/apps/server-python/scripts/verify_environment.py','--worker')
        # The image ships no TS business Server/oracle or Node build tools.
        docker('exec',server,PYTHON,'-I','-B','-c',"from pathlib import Path; assert all(not Path('/workspace',p).exists() for p in ['apps/server','tests/oracles','node_modules/typescript','node_modules/vite'])")
        docker('stop','--time','20',server);assert inspect(server)['State']['ExitCode'] in (0,143)
        docker('start',server);ready(server)
        second=json.loads(docker('exec','-i',server,PYTHON,'-I','-B','-',f'http://{server}:3001','restart',input=client,timeout=40))
        assert sql('select hash,created_at from drizzle.__drizzle_migrations order by id')==before
        docker('stop','--time','20',server);assert inspect(server)['State']['ExitCode'] in (0,143)
        result={'ok':True,'architecture':metadata['Architecture'],'migrations':43,'first':first,'restart':second,
            'preflightBeforeSchema':True,'sigtermExitWithoutKill':True,'temporalConfigured':False,'realModelCalled':False}
    finally:
        for name in reversed(created):
            try:docker('rm','-f',name)
            except Exception:cleanup.append('container')
        if made_volume:
            try:docker('volume','rm',volume)
            except Exception:cleanup.append('volume')
        if made_network:
            try:docker('network','rm',network)
            except Exception:cleanup.append('network')
        if cleanup:raise RuntimeError('owned_cleanup_incomplete:'+','.join(cleanup))
    result['ownedResourcesRemoved']=True
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--image',required=True)
    value=parser.parse_args()
    if not value.image or value.image.startswith('-'):parser.error('An explicit existing image is required.')
    print(json.dumps(qualify(value.image),sort_keys=True))
