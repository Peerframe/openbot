"""One owned product command lifecycle. Preparation only until separately authorized."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

BASE=Path('/opt/openbot-command-0925')
ROOT=Path(__file__).resolve().parent
CASE=BASE/'case2'
PUBLIC=Path('/opt/oc25p')
NODE=Path('/opt/oc25n/node')
SOCKET=Path('/run/oc25/command.sock')
UID=62425
RUNNER_MS=150000
RESERVE_MS=70000
SESSION_MS=80000
# These are the frozen case2 implementation files; qualification must also have succeeded.
CASE_PINS={'source/protected_native.py':'83499d136d20f649531e94f7293454a0ea48353070b6fad6074dfd5ded061718',
 'source/protected_host.py':'3ae3729d9ec874ce425278d6f58e6cc83956a8167935b144c3e4a315e972be80',
 'python/openbot_server/work_command_v2_crypto.py':'c483104faa6d255c5f55b6cd6462671a6d98611a51b8172dad9b7b8edcb90ded'}


def require(value,code):
    if not value:raise RuntimeError(code)


def clock():
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME)//1000000,Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def validate_public(value):
    from openbot_server.work_command_contract import CommandRoute,Identity,parse
    from openbot_server.work_command_v2_contract import TimingPolicy
    from pydantic import TypeAdapter
    from cryptography.hazmat.primitives.serialization import load_pem_public_key
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    expected={'version','route','timing','controlIssuer','controlKid','controlPublicPem','enforcementIssuer','nodeBundleSha256','serverPort'}
    require(type(value) is dict and set(value)==expected and type(value['version']) is int and value['version']==1,'invalid_public_configuration')
    route=parse(CommandRoute,value['route']).model_dump();timing=parse(TimingPolicy,value['timing']).model_dump()
    require(timing['runtimeMaxMs']==50000 and timing['stopAllowanceMs']==5000 and timing['challengeBudgetMs']==5000,'unqualified_timing')
    for k in ('controlIssuer','controlKid','enforcementIssuer'):TypeAdapter(Identity).validate_python(value[k],strict=True)
    require(value['controlIssuer']!=value['enforcementIssuer'],'roles_not_distinct')
    require(type(value['controlPublicPem']) is str and len(value['controlPublicPem'])<=4096,'invalid_public_pin')
    require(isinstance(load_pem_public_key(value['controlPublicPem'].encode()),Ed25519PublicKey),'invalid_public_pin')
    require(type(value['serverPort']) is int and 1024<=value['serverPort']<=65535,'invalid_loopback_port')
    require(type(value['nodeBundleSha256']) is str and re.fullmatch('[0-9a-f]{64}',value['nodeBundleSha256']) is not None,'invalid_bundle_pin')
    return {**value,'route':route,'timing':timing}


def read_stdin(maximum):
    from openbot_server.work_command_contract import strict_json
    data=sys.stdin.buffer.read(maximum+1)
    require(len(data)<=maximum,'stdin_bound')
    return strict_json(data,maximum=maximum)


def reserve_one(path,binding,route,guard,*,read,write,now=clock):
    from openbot_server.work_command_v2_contract import PreparationBinding
    from openbot_server.work_command_contract import parse
    binding=parse(PreparationBinding,binding).model_dump()
    require(all(binding[k]==v for k,v in route.items()),'fixture_route_changed')
    current,boot=now()
    require(boot==guard['bootId'] and guard['startedBoottimeMs']<=current<guard['startedBoottimeMs']+RESERVE_MS,'fixture_admission_closed')
    # Exclusive/fsynced file creation, not a read-then-write race. Uncertain write never unlinks.
    write(path,{'binding':binding,'bootId':boot,'reservedBoottimeMs':current})
    return binding


class OneActionNative:
    """Experiment-only ceiling. The unchanged Host verifies Control authority first."""
    def __init__(self,native,route,guard,path,*,read,write,now=clock):
        self.inner=native;self.route=route;self.guard=guard;self.path=path;self.read=read;self.write=write;self.now=now
    @property
    def instance_path(self):return self.inner.instance_path
    @instance_path.setter
    def instance_path(self,value):self.inner.instance_path=value
    def __getattr__(self,name):return getattr(self.inner,name)
    def reserve(self,binding,authorization,instance):
        reserve_one(self.path,binding,self.route,self.guard,read=self.read,write=self.write,now=self.now)
        return self.inner.reserve(binding,authorization,instance)


def validate_listeners(tcp,tcp6,port):
    found=[]
    for family,table in ((4,tcp),(6,tcp6)):
        require(len(table)<=4*1024*1024,'listener_read_bound')
        for line in table.splitlines()[1:]:
            fields=line.split()
            require(len(fields)>=4,'invalid_listener_readback')
            address,p=fields[1].split(':')
            if fields[3]=='0A' and int(p,16)==port:found.append((family,address))
    require(found==[(4,'0100007F')],'forward_not_loopback_only')


def check_loopback(port):
    values=[]
    for name in ('tcp','tcp6'):
        with Path('/proc/net',name).open() as f:values.append(f.read(4*1024*1024+1))
    validate_listeners(*values,port)


def imports():
    require(sys.platform=='linux' and os.geteuid()==0,'linux_root_required')
    require(ROOT.parent==BASE and re.fullmatch(r'product[1-9][0-9]{0,2}',ROOT.name) is not None,
        'invalid_fixture_directory')
    # A new pathname must not be a symlink alias for a consumed fixture identity.
    require(Path(__file__).absolute()==ROOT/'product_host_fixture.py','fixture_path_alias')
    sys.path[:0]=[str(BASE/'deps'),str(CASE/'python'),str(CASE/'source')]
    from protected_io import directory,digest,read_record
    for path in (BASE,CASE,ROOT,CASE/'source',CASE/'python',BASE/'deps'):directory(path)
    for name,pin in CASE_PINS.items():require(digest(CASE/name)==pin,'case_source_changed')
    require(read_record(CASE/'evidence/safe-result.json').get('success') is True,'native_qualification_not_passed')


def safe_code(error):
    value=str(error)
    return value if re.fullmatch('[a-z_]{1,64}',value) else 'fixture_failed'


def failure_details(error):
    # Retain code location without traceback formatting, source text, locals or exception values.
    kinds=(FileNotFoundError,PermissionError,FileExistsError,NotADirectoryError,IsADirectoryError,
        BlockingIOError,TimeoutError,OSError,ValueError,TypeError,RuntimeError,KeyError)
    details={'errorType':next((kind.__name__ for kind in kinds if isinstance(error,kind)),'Exception')}
    sources={str(Path(__file__).resolve()):'product_host_fixture.py',**{
        str(CASE/'source'/name):name for name in ('protected_io.py','protected_host.py','protected_native.py')}}
    trace=error.__traceback__
    while trace is not None:
        code=trace.tb_frame.f_code
        if code.co_filename in sources and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',code.co_name):
            details['source']={'file':sources[code.co_filename],'function':code.co_name,'line':trace.tb_lineno}
        trace=trace.tb_next
    return details


def production():
    old=Path('/opt/openbot-qualification-20260925-c8b2')
    def run(args):
        r=subprocess.run(args,capture_output=True,text=True,timeout=2)
        require(r.returncode==0 and len(r.stdout)<1048576,'production_readback_failed');return r.stdout.strip()
    cli=[str(old/'bin/docker'),'--config',str(old/'docker-config'),'--host','unix:///var/run/docker.sock']
    before=json.loads((old/'evidence/production-before.json').read_text());ids=run(cli+['ps','--all','--quiet','--no-trunc']).splitlines()
    require(len(ids)==10 and set(ids)=={v['id'] for v in before},'production_identity_changed')
    template='{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"status":{{json .State.Status}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}}}'
    now=[json.loads(line) for line in run(cli+['inspect','--format',template,*ids]).splitlines()]
    for a in before:
        b=next(v for v in now if v['id']==a['id'])
        require(a['name'].lstrip('/')==b['name'].lstrip('/') and a['image'] in (b['image'],b['imageId']) and all(a[k]==b[k] for k in ('status','startedAt','restartCount')),'production_state_changed')
    def normalized(value):return [' '.join(re.sub(r'\[[^\]]*\]','',line).split()) for line in (value.splitlines() if isinstance(value,str) else value) if line.strip() and not line.startswith('#')]
    rules=json.loads((old/'evidence/firewall-semantic-baseline.json').read_text())
    for name,value in rules.items():
        require(name in ('iptables-save','ip6tables-save') and normalized(run(['/usr/sbin/'+name]))==normalized(value['rules']),'firewall_changed')
    return {'containerCount':10,'identitiesAndStateUnchanged':True,'ipv4Ipv6SemanticsUnchanged':True}


def require_peer_free():
    for lookup in (pwd.getpwuid,grp.getgrgid):
        try:lookup(UID)
        except KeyError:pass
        else:raise RuntimeError('fixture_uid_occupied')
    require(not any(p.stat().st_uid==UID for p in Path('/proc').iterdir() if p.name.isdecimal()),'fixture_uid_occupied')
    require(not SOCKET.exists() and not SOCKET.is_symlink(),'fixture_socket_occupied')


def stage():
    from protected_io import read_record,read_bytes,exclusive,directory,digest,fsync_dir
    from protected_host import Configuration
    from protected_native import LinuxNative
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding,PrivateFormat,PublicFormat,NoEncryption
    value=validate_public(read_stdin(16384));require_peer_free()
    require(not PUBLIC.exists() and not PUBLIC.is_symlink(),'public_directory_occupied')
    bundle=ROOT/'product-command-node.cjs';read_bytes(bundle,8*1024*1024)
    require(digest(NODE)==read_record(BASE/'MANIFEST.json')['relay/node'],'node_binary_changed')
    require(digest(bundle)==value['nodeBundleSha256'],'node_bundle_changed')
    exclusive(ROOT/'stage-reserved.json',{'version':1,'route':value['route']})
    for name in ('state','secrets','evidence'):(ROOT/name).mkdir(mode=0o700)
    for name in ('control.pub',):
        fd=os.open(ROOT/'secrets'/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
        try:os.write(fd,value['controlPublicPem'].encode());os.fsync(fd)
        finally:os.close(fd)
    key=Ed25519PrivateKey.generate()
    private=key.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption())
    public=key.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo)
    for name,data in (('enforcer.pem',private),('enforcer.pub',public)):
        with (ROOT/'secrets'/name).open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        (ROOT/'secrets'/name).chmod(0o600)
    old=read_record(CASE/'config.json');directory(old['native']['base']);directory(SOCKET.parent,private=False)
    require(old['nodeUid']==UID and old['nodeGid']==UID and old['native']['base']=='/opt/oc25','native_layout_changed')
    cfg={**old,'state':str(ROOT/'state'),'socket':str(SOCKET),'route':value['route'],'policy':value['timing'],
         'controlIssuer':value['controlIssuer'],'enforcementIssuer':value['enforcementIssuer'],
         'privateKey':str(ROOT/'secrets/enforcer.pem'),'controlPins':[{'kid':value['controlKid'],'path':str(ROOT/'secrets/control.pub')}],
         'native':{**old['native'],'secretsDirectory':str(ROOT/'secrets')}}
    exclusive(ROOT/'config.json',cfg);exclusive(ROOT/'public.json',value);fsync_dir(ROOT/'secrets')
    loaded=Configuration.load(ROOT/'config.json');LinuxNative(loaded.native,route=loaded.route,policy=loaded.policy)
    PUBLIC.mkdir(mode=0o750);PUBLIC.chmod(0o750);os.chown(PUBLIC,0,UID)
    out=PUBLIC/'product-command-node.cjs'
    with out.open('xb') as f:f.write(bundle.read_bytes());f.flush();os.fsync(f.fileno())
    out.chmod(0o640);os.chown(out,0,UID);fsync_dir(PUBLIC)
    print(json.dumps({'version':1,'stageReady':True,'route':value['route'],'enforcementIssuer':value['enforcementIssuer'],
        'enforcementKeyId':value['route']['enforcementKeyId'],'enforcementPublicPem':public.decode(),
        'serverUrl':f"ws://127.0.0.1:{value['serverPort']}/ws/nodes"}),flush=True)


def host():
    from protected_io import read_record,exclusive
    from protected_host import Host,UnixService,Configuration
    from protected_native import LinuxNative
    cfg=Configuration.load(ROOT/'config.json');guard=read_record(ROOT/'run-reserved.json')
    native=LinuxNative(cfg.native,route=cfg.route,policy=cfg.policy)
    native=OneActionNative(native,cfg.route,guard,ROOT/'single-action.json',read=read_record,write=exclusive)
    UnixService(Host(cfg,native)).serve()


def close_owned(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:process.wait(timeout=3)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)


def cleanup(cfg,evidence):
    from protected_io import read_record
    from protected_native import LinuxNative
    import deadline_probe as prior
    gate=ROOT/'single-action.json'
    if not gate.exists():evidence['actionCount']=0;return
    binding=read_record(gate)['binding'];evidence['actionCount']=1;evidence['binding']=binding
    root=Path(cfg.native['base'])/binding['preparationId'].replace('-','')[:12]
    if not (root/'native.json').exists():
        evidence['nativeReservationIncomplete']=True;return
    record=read_record(root/'native.json');require(record['binding']==binding,'native_binding_changed')
    native=LinuxNative(cfg.native,route=cfg.route,policy=cfg.policy)
    observed=read_record(root/'unit-observed.json');unit=record['unit'];facts=native.show(unit)
    require(facts['InvocationID']==observed['invocationId'],'invocation_changed')
    active=int(facts['ActiveEnterTimestampMonotonic']);end=active/1000000+55
    while facts.get('ActiveState') in ('active','activating','deactivating') and time.monotonic()<end:
        time.sleep(.1);facts=native.show(unit)
    require(facts['InvocationID']==observed['invocationId'] and facts['MainPID']=='0' and facts['NRestarts']=='0'
        and facts['ActiveState'] in ('failed','inactive'),'native_not_terminal')
    observed_stop=evidence.pop('_stopObservationUs',time.monotonic_ns()//1000)
    require(active<=observed_stop<=int(end*1000000),'native_stop_observation_late')
    require(not prior.cgroup_members(Path('/sys/fs/cgroup/system.slice')/unit),'native_cgroup_not_empty')
    native.cleanup(record);native.command(['/usr/bin/systemctl','reset-failed',unit])
    require(native.show(unit).get('LoadState')=='not-found','unit_not_released')
    evidence['native']={'unit':unit,'invocationId':observed['invocationId'],'result':facts['Result'],
        'originalCgroupEmpty':True,'stopObservedWithin5SecondMargin':True,'unitReleased':True,'reservationRetained':True,
        'privateRuntimeAbsent':all(not (root/n).exists() for n in ('docker-data','docker-exec','containerd-data','containerd-state')),
        'backingAbsent':not (root/'output.ext4').exists()}


def require_unreserved():
    for name in ('run-reserved.json','single-action.json'):
        try:(ROOT/name).lstat()
        except FileNotFoundError:continue
        raise RuntimeError('run_or_action_already_reserved')


@contextmanager
def preflight_lock():
    """One cooperative nonblocking gate on the existing immutable stage inode, not PID authority."""
    from protected_io import directory,read_record
    directory(ROOT)
    fd=os.open(ROOT/'stage-reserved.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        stage=read_record(ROOT/'stage-reserved.json')
        opened=os.fstat(fd);named=(ROOT/'stage-reserved.json').lstat()
        require((opened.st_dev,opened.st_ino)==(named.st_dev,named.st_ino),'stage_inode_changed')
        require(type(stage) is dict and set(stage)=={'version','route'} and type(stage['version']) is int
            and stage['version']==1,'invalid_stage_reservation')
        yield stage
    finally:os.close(fd)


def cleanup_prerun_key(stage):
    # Called only while preflight_lock is held and before any run-reserved write attempt.
    from protected_io import directory,read_record,read_bytes,fsync_dir
    from cryptography.hazmat.primitives.serialization import load_pem_private_key,load_pem_public_key,Encoding,PublicFormat
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey,Ed25519PublicKey
    directory(ROOT);directory(ROOT/'secrets');require_unreserved()
    value=validate_public(read_record(ROOT/'public.json'))
    require(stage=={'version':1,'route':value['route']},'stage_route_changed')
    require(read_bytes(ROOT/'secrets/control.pub',4096)==value['controlPublicPem'].encode(),'stage_control_changed')
    key=ROOT/'secrets/enforcer.pem';before=key.lstat()
    private=load_pem_private_key(read_bytes(key,4096),password=None)
    public=load_pem_public_key(read_bytes(ROOT/'secrets/enforcer.pub',4096))
    require(isinstance(private,Ed25519PrivateKey) and isinstance(public,Ed25519PublicKey),'stage_key_type_changed')
    require(private.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw)==
        public.public_bytes(Encoding.Raw,PublicFormat.Raw),'stage_key_pair_changed')
    del private,public
    require_peer_free();require_unreserved()
    after=key.lstat()
    require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==
        (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'stage_key_changed')
    key.unlink();fsync_dir(ROOT/'secrets')
    require(not key.exists() and not key.is_symlink(),'stage_key_cleanup_incomplete')


def record_prerun_failure(stage,error):
    from protected_io import directory,exclusive
    diagnostic={'version':1,'preRunFailure':True,'code':safe_code(error),**failure_details(error)}
    status={**diagnostic,'errorRecorded':False,
            'keyCleanupVerified':False,'cleanupUncertain':True}
    # Evidence IO failure must not skip a separately provable cleanup.
    try:
        directory(ROOT/'evidence')
        exclusive(ROOT/'evidence/pre-run-error.json',diagnostic)
        status['errorRecorded']=True
    except Exception as failure:
        status['recordCode']=safe_code(failure);status['recordError']=failure_details(failure)
    try:
        cleanup_prerun_key(stage)
        status['keyCleanupVerified']=True;status['cleanupUncertain']=False
    except Exception as failure:
        status['cleanupCode']=safe_code(failure);status['cleanupError']=failure_details(failure)
    try:
        directory(ROOT/'evidence');exclusive(ROOT/'evidence/pre-run-cleanup.json',status)
    except Exception as failure:
        status['outcomeRecordCode']=safe_code(failure);status['outcomeRecordError']=failure_details(failure)
    # The controller captures stderr privately. No input, PEM or raw exception is printed.
    print(json.dumps(status),file=sys.stderr,flush=True)


def run_preflight():
    from protected_io import exclusive,read_record,digest
    from protected_host import Configuration
    from protected_native import LinuxNative
    cfg=Configuration.load(ROOT/'config.json');native=LinuxNative(cfg.native,route=cfg.route,policy=cfg.policy);value=read_record(ROOT/'public.json')
    secret=read_stdin(512)
    require(type(secret) is dict and set(secret)=={'version','enrollmentToken'} and type(secret['version']) is int and secret['version']==1
        and type(secret['enrollmentToken']) is str and re.fullmatch('obenr_[A-Za-z0-9_-]{43}',secret['enrollmentToken']) is not None,'invalid_enrollment_input')
    require_peer_free();check_loopback(value['serverPort'])
    require(digest(PUBLIC/'product-command-node.cjs')==value['nodeBundleSha256'],'node_bundle_changed')
    require(digest(NODE)==read_record(BASE/'MANIFEST.json')['relay/node'],'node_binary_changed')
    started,boot=clock()
    return cfg,native,value,secret,started,boot


def run():
    from protected_io import exclusive,read_record
    with preflight_lock() as stage:
        require_unreserved()
        try:cfg,native,value,secret,started,boot=run_preflight()
        except Exception as error:
            record_prerun_failure(stage,error)
            raise RuntimeError(safe_code(error)) from None
        # Outside the caught block: a failed/uncertain write also consumes this attempt.
        exclusive(ROOT/'run-reserved.json',{'startedBoottimeMs':started,'bootId':boot,'maximumMs':RUNNER_MS})
    evidence={'version':1,'productAuthorityLocal':True,'workSuccessNotInferred':True};process=node=None;failure=None
    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':os.pathsep.join(cfg.native['pythonPath'])}
    def interrupted(signum,frame):raise RuntimeError('fixture_interrupted')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    try:
        evidence['before']=production()
        process=subprocess.Popen(['/usr/bin/python3',str(ROOT/'product_host_fixture.py'),'host'],env=env,
            stdin=subprocess.DEVNULL,stdout=(ROOT/'evidence/host-private.log').open('xb'),stderr=subprocess.STDOUT)
        end=time.monotonic()+5
        while not SOCKET.exists():
            require(process.poll() is None and time.monotonic()<end,'host_not_ready');time.sleep(.02)
        node=subprocess.Popen(['/usr/bin/setpriv',f'--reuid={UID}',f'--regid={UID}','--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs',str(NODE),str(PUBLIC/'product-command-node.cjs')],
            env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},stdin=subprocess.PIPE,
            stdout=(ROOT/'evidence/node-private.log').open('xb'),stderr=subprocess.STDOUT)
        status=dict(line.split(':',1) for line in Path(f'/proc/{node.pid}/status').read_text().splitlines() if ':' in line)
        # setpriv is asynchronous. Check the Node process after its fixed executable takes over.
        end=time.monotonic()+3
        while (status['Uid'].split()!=[str(UID)]*4 or os.readlink(f'/proc/{node.pid}/exe')!=str(NODE)) and time.monotonic()<end:
            time.sleep(.01);require(node.poll() is None,'node_not_ready')
            status=dict(line.split(':',1) for line in Path(f'/proc/{node.pid}/status').read_text().splitlines() if ':' in line)
        require(os.readlink(f'/proc/{node.pid}/exe')==str(NODE) and status['Uid'].split()==[str(UID)]*4 and status['Gid'].split()==[str(UID)]*4 and not status['Groups'].strip()
            and all(int(status[k],16)==0 for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')) and status['NoNewPrivs'].strip()=='1','node_credentials_changed')
        data={'version':1,'nodeId':cfg.route['nodeId'],'serverUrl':f"ws://127.0.0.1:{value['serverPort']}/ws/nodes",
              'socketPath':str(SOCKET),'selection':cfg.route,'enrollmentToken':secret.pop('enrollmentToken')}
        node.stdin.write(json.dumps(data).encode()+b'\n');node.stdin.close();data.clear();secret.clear()
        print(json.dumps({'version':1,'event':'remote_ready','socketReady':True,'nodeSpawned':True,'nodeUid':UID,'serverAuthenticated':False}),flush=True)
        while clock()[0]<started+SESSION_MS and node.poll() is None and process.poll() is None:
            gate=ROOT/'single-action.json'
            if gate.exists():
                binding=read_record(gate)['binding'];root=Path(cfg.native['base'])/binding['preparationId'].replace('-','')[:12]
                if (root/'unit-observed.json').exists():
                    observed=read_record(root/'unit-observed.json');record=read_record(root/'native.json')
                    facts=native.show(record['unit'])
                    require(facts['InvocationID']==observed['invocationId'],'invocation_changed')
                    if facts['ActiveState'] in ('failed','inactive'):
                        evidence['_stopObservationUs']=time.monotonic_ns()//1000;break
            time.sleep(.25)
    except Exception as error:failure=safe_code(error)
    finally:
        close_owned(node);close_owned(process)
        try:cleanup(cfg,evidence)
        except Exception as error:evidence['cleanupFailure']=safe_code(error);failure=failure or 'cleanup_failed'
        try:evidence['after']=production()
        except Exception as error:evidence['productionFailure']=safe_code(error);failure=failure or 'production_comparison_failed'
        key=ROOT/'secrets/enforcer.pem'
        if key.exists():key.unlink()
        evidence['enforcerKeyRemoved']=not key.exists();evidence['socketAbsent']=not SOCKET.exists()
        evidence['runnerWithin150s']=clock()[0]<=started+RUNNER_MS
        evidence['runnerSucceeded']=failure is None and evidence.get('actionCount')==1 and evidence.get('native',{}).get('unitReleased') is True and evidence['runnerWithin150s']
        if failure:evidence['failure']=failure
        exclusive(ROOT/'evidence/safe-result.json',evidence)
        print(json.dumps({'event':'remote_finished',**evidence}),flush=True)
    return 0 if evidence['runnerSucceeded'] else 1


def main():
    os.umask(0o077);imports()
    require(sys.argv[1:] in (['stage'],['host'],['run']),'invalid_mode')
    if sys.argv[1]=='stage':stage();return 0
    if sys.argv[1]=='host':host();return 0
    return run()


if __name__=='__main__':sys.exit(main())
