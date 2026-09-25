"""Thin-fixture bounds, without SSH, Linux processes, Node, DB or unit effects."""
import copy,json,os
from pathlib import Path
from uuid import uuid4
import pytest
import product_host_fixture as f
from protected_io import exclusive,read_record
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat


def binding():
    return dict(taskId='task',runId='run',actionId='action',preparationId=str(uuid4()),connectionId=str(uuid4()),
      originalEpoch=1,authorityGeneration=1,profileDigest='1'*64,intentDigest='2'*64,operationFingerprint='3'*64,
      nodeId='node',providerId='command',enforcementKeyId='enforcer',ledgerId=str(uuid4()))


def route(b):return {k:b[k] for k in ('nodeId','providerId','enforcementKeyId','ledgerId')}


def test_first_original_reservation_precedes_native_and_second_cannot_start(tmp_path):
    b=binding();path=tmp_path/'once.json';calls=[]
    class Native:
        def reserve(self,*args):
            assert read_record(path,uid=os.getuid())['binding']==b;calls.append(args);return {'only':'original'}
    n=f.OneActionNative(Native(),route(b),{'bootId':'boot','startedBoottimeMs':100},path,read=None,write=exclusive,now=lambda:(200,'boot'))
    assert n.reserve(b,{},'instance')=={'only':'original'}
    for candidate in (b,{**b,'actionId':'different','preparationId':str(uuid4())}):
        with pytest.raises(FileExistsError):n.reserve(candidate,{},'instance')
    assert len(calls)==1
    # Reconstructed process wrapper still cannot rearm the durable original.
    restarted=f.OneActionNative(Native(),route(b),{'bootId':'boot','startedBoottimeMs':100},path,read=None,write=exclusive,now=lambda:(201,'boot'))
    with pytest.raises(FileExistsError):restarted.reserve(b,{},'different-instance')
    assert len(calls)==1


def test_native_failure_keeps_tombstone(tmp_path):
    b=binding();path=tmp_path/'once.json';calls=[]
    class Native:
        def reserve(self,*args):calls.append(args);raise OSError('synthetic original failure')
    n=f.OneActionNative(Native(),route(b),{'bootId':'boot','startedBoottimeMs':100},path,read=None,write=exclusive,now=lambda:(200,'boot'))
    with pytest.raises(OSError):n.reserve(b,{},'instance')
    assert path.exists()
    with pytest.raises(FileExistsError):n.reserve(b,{},'instance')
    assert len(calls)==1


@pytest.mark.parametrize('field',['nodeId','providerId','enforcementKeyId','ledgerId'])
def test_wrong_route_refuses_before_reservation(tmp_path,field):
    b=binding();changed={**b,field:str(uuid4())};path=tmp_path/'never'
    with pytest.raises(RuntimeError,match='fixture_route_changed'):
        f.reserve_one(path,changed,route(b),{'bootId':'boot','startedBoottimeMs':100},read=None,write=exclusive,now=lambda:(200,'boot'))
    assert not path.exists()


@pytest.mark.parametrize('now',[(99,'boot'),(70100,'boot'),(70101,'boot'),(200,'changed-boot')])
def test_reservation_cutoff_and_reboot_refuse(tmp_path,now):
    b=binding();path=tmp_path/'never'
    with pytest.raises(RuntimeError,match='fixture_admission_closed'):
        f.reserve_one(path,b,route(b),{'bootId':'boot','startedBoottimeMs':100},read=None,write=exclusive,now=lambda:now)
    assert not path.exists()


def table(address,port=39195):return 'header\n0: '+address+':'+f'{port:04X}'+' 00000000:0000 0A rest\n'


def test_single_actual_ipv4_loopback_listener():f.validate_listeners(table('0100007F'),'header\n',39195)


@pytest.mark.parametrize('v4,v6',[(table('00000000'),'header\n'),('header\n',table('0'*32)),
    (table('0100007F'),table('00000000000000000000000001000000')),('header\n','header\n'),
    (table('0100007F')+table('0100007F').split('\n',1)[1],'header\n'),(table('0200007F'),'header\n')])
def test_missing_wildcard_duplicate_or_ipv6_listener_refuses(v4,v6):
    with pytest.raises(RuntimeError,match='forward_not_loopback_only'):f.validate_listeners(v4,v6,39195)


def public():
    return dict(version=1,route=route(binding()),timing=dict(prepareBudgetMs=30000,challengeBudgetMs=5000,runtimeMaxMs=50000,stopAllowanceMs=5000,clockRateErrorPpm=1000,clockQuantizationMs=100,policyDigest='a'*64),
        controlIssuer='control',controlKid='control-key',enforcementIssuer='enforcement',nodeBundleSha256='b'*64,serverPort=39195,
        controlPublicPem=Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo).decode())


def test_stage_accepts_public_pin_only():
    value=public();assert f.validate_public(value)==value


@pytest.mark.parametrize('mutation',['private_key','extra_dsn','extra_cookie','bool_port','low_port','bad_hash','too_long_runtime','roles'])
def test_invalid_stage_configuration(mutation):
    value=public()
    if mutation=='private_key':value['controlPublicPem']='-----BEGIN PRIVATE KEY-----\nno\n-----END PRIVATE KEY-----'
    if mutation=='extra_dsn':value['dsn']='forbidden'
    if mutation=='extra_cookie':value['ownerCookie']='forbidden'
    if mutation=='bool_port':value['serverPort']=True
    if mutation=='low_port':value['serverPort']=22
    if mutation=='bad_hash':value['nodeBundleSha256']='x'*64
    if mutation=='too_long_runtime':value['timing']['runtimeMaxMs']=60000
    if mutation=='roles':value['enforcementIssuer']='control'
    with pytest.raises((ValueError,RuntimeError)):f.validate_public(value)


@pytest.fixture
def staged_root(tmp_path,monkeypatch):
    """Real private files/crypto/flock; privileged ownership and external preflight are simulated."""
    import stat,protected_io
    from cryptography.hazmat.primitives.serialization import PrivateFormat,NoEncryption
    root=tmp_path/'product1';root.mkdir(mode=0o700)
    for name in ('secrets','evidence'):(root/name).mkdir(mode=0o700)
    value=public();exclusive(root/'stage-reserved.json',{'version':1,'route':value['route']})
    exclusive(root/'public.json',value)
    def write(name,data):
        path=root/'secrets'/name;path.write_bytes(data);path.chmod(0o600)
    write('control.pub',value['controlPublicPem'].encode())
    key=Ed25519PrivateKey.generate()
    write('enforcer.pem',key.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption()))
    write('enforcer.pub',key.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))
    original_read=protected_io.read_bytes
    def read_bytes(path,maximum,**kw):return original_read(path,maximum,uid=os.getuid(),private=kw.get('private',True))
    def directory(path,*args,**kwargs):
        path=Path(path);assert path.resolve()==path and path.is_relative_to(tmp_path)
        s=path.lstat();assert stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700
        return path
    monkeypatch.setattr(protected_io,'read_bytes',read_bytes)
    monkeypatch.setattr(protected_io,'directory',directory)
    monkeypatch.setattr(f,'ROOT',root)
    monkeypatch.setattr(f,'require_peer_free',lambda:None)
    monkeypatch.setattr(f.subprocess,'Popen',lambda *a,**k:pytest.fail('No process may spawn in preflight tests'))
    return root,value,write


def refuse():raise RuntimeError('synthetic_preflight_failure')


def status(root):return read_record(root/'evidence/pre-run-cleanup.json',uid=os.getuid())


def test_run_entry_failure_records_then_removes_only_verified_unused_key(staged_root,monkeypatch,capsys):
    root,value,write=staged_root
    before={p.relative_to(root).as_posix():p.read_bytes() for p in root.rglob('*') if p.is_file()}
    monkeypatch.setattr(f,'run_preflight',refuse)
    with pytest.raises(RuntimeError,match='synthetic_preflight_failure'):f.run()
    assert not (root/'secrets/enforcer.pem').exists()
    for name,data in before.items():
        if name!='secrets/enforcer.pem':assert (root/name).read_bytes()==data
    assert not (root/'run-reserved.json').exists() and not (root/'single-action.json').exists()
    found=status(root);source=found.pop('source')
    assert source['file']=='product_host_fixture.py' and source['function']=='run' and type(source['line']) is int
    assert found==dict(version=1,preRunFailure=True,code='synthetic_preflight_failure',errorType='RuntimeError',errorRecorded=True,
        keyCleanupVerified=True,cleanupUncertain=False)
    output=capsys.readouterr()
    assert output.out=='' and json.loads(output.err)==status(root)
    assert value['controlPublicPem'] not in output.err and 'PRIVATE KEY' not in output.err


def test_error_evidence_write_failure_does_not_skip_cleanup(staged_root,monkeypatch):
    import protected_io
    root,_,_=staged_root;original=protected_io.exclusive
    def fail_error_record(path,value):
        if path.name=='pre-run-error.json':raise OSError('evidence_write_failed')
        return original(path,value)
    monkeypatch.setattr(protected_io,'exclusive',fail_error_record)
    monkeypatch.setattr(f,'run_preflight',refuse)
    with pytest.raises(RuntimeError,match='synthetic_preflight_failure'):f.run()
    assert not (root/'secrets/enforcer.pem').exists()
    found=status(root)
    assert found['errorRecorded'] is False and found['recordCode']=='evidence_write_failed'
    assert found['keyCleanupVerified'] is True and found['cleanupUncertain'] is False


@pytest.mark.parametrize('drift',['route','control','pair','private_mode','peer','missing_public'])
def test_unprovable_cleanup_keeps_key_and_safe_evidence(staged_root,monkeypatch,drift,capsys):
    root,value,write=staged_root
    if drift=='route':
        (root/'public.json').unlink();exclusive(root/'public.json',{**value,'route':{**value['route'],'nodeId':'other'}})
    if drift=='control':write('control.pub',b'changed')
    if drift=='pair':write('enforcer.pub',Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))
    if drift=='private_mode':(root/'secrets/enforcer.pem').chmod(0o644)
    if drift=='peer':monkeypatch.setattr(f,'require_peer_free',lambda:(_ for _ in ()).throw(RuntimeError('fixture_uid_occupied')))
    if drift=='missing_public':(root/'public.json').unlink()
    monkeypatch.setattr(f,'run_preflight',refuse)
    with pytest.raises(RuntimeError,match='synthetic_preflight_failure'):f.run()
    assert (root/'secrets/enforcer.pem').exists()
    found=status(root)
    assert found['errorRecorded'] is True and found['keyCleanupVerified'] is False and found['cleanupUncertain'] is True
    assert 'PRIVATE KEY' not in capsys.readouterr().err


@pytest.mark.parametrize('name',['run-reserved.json','single-action.json'])
@pytest.mark.parametrize('symlink',[False,True])
def test_any_existing_run_or_action_refuses_before_new_cleanup(staged_root,monkeypatch,name,symlink):
    root,_,_=staged_root;calls=[]
    if symlink:(root/name).symlink_to(root/'missing')
    else:exclusive(root/name,{'retained':True})
    monkeypatch.setattr(f,'run_preflight',lambda:calls.append('preflight'))
    monkeypatch.setattr(f,'record_prerun_failure',lambda *args:calls.append('cleanup'))
    with pytest.raises(RuntimeError,match='already_reserved'):f.run()
    assert calls==[] and (root/'secrets/enforcer.pem').exists() and not list((root/'evidence').iterdir())


@pytest.mark.parametrize('write_before_error',[False,True])
def test_any_reservation_attempt_is_outside_new_cleanup(staged_root,monkeypatch,write_before_error):
    import protected_io
    root,_,_=staged_root;calls=[];original=protected_io.exclusive
    monkeypatch.setattr(f,'run_preflight',lambda:(None,None,None,None,100,'boot'))
    monkeypatch.setattr(f,'record_prerun_failure',lambda *args:calls.append('cleanup'))
    def uncertain(path,value):
        assert path==root/'run-reserved.json'
        if write_before_error:original(path,value)
        raise OSError('uncertain_reservation_write')
    monkeypatch.setattr(protected_io,'exclusive',uncertain)
    with pytest.raises(OSError,match='uncertain_reservation_write'):f.run()
    assert calls==[] and (root/'secrets/enforcer.pem').exists()
    assert (root/'run-reserved.json').exists() is write_before_error
    assert not list((root/'evidence').iterdir())


def test_lock_conflict_is_nonblocking_and_cannot_cleanup_other_attempt(staged_root,monkeypatch):
    import fcntl
    root,_,_=staged_root;calls=[]
    fd=os.open(root/'stage-reserved.json',os.O_RDONLY)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        monkeypatch.setattr(f,'run_preflight',lambda:calls.append('preflight'))
        monkeypatch.setattr(f,'record_prerun_failure',lambda *args:calls.append('cleanup'))
        with pytest.raises(BlockingIOError):f.run()
        assert calls==[] and (root/'secrets/enforcer.pem').exists()
    finally:os.close(fd)


def test_real_lock_is_held_during_cleanup_then_released(staged_root,monkeypatch):
    import fcntl
    root,_,_=staged_root;calls=[]
    def peer_check():
        fd=os.open(root/'stage-reserved.json',os.O_RDONLY)
        try:
            with pytest.raises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            calls.append('locked')
        finally:os.close(fd)
    monkeypatch.setattr(f,'require_peer_free',peer_check)
    monkeypatch.setattr(f,'run_preflight',refuse)
    with pytest.raises(RuntimeError):f.run()
    assert calls==['locked'] and not (root/'secrets/enforcer.pem').exists()
    fd=os.open(root/'stage-reserved.json',os.O_RDONLY)
    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    finally:os.close(fd)


def test_raw_error_secret_never_enters_records_or_output(staged_root,monkeypatch,capsys):
    root,_,_=staged_root;secret='obenr_'+'A'*43
    def fail():raise ValueError('untrusted '+secret+' -----BEGIN PRIVATE KEY-----')
    monkeypatch.setattr(f,'run_preflight',fail)
    with pytest.raises(RuntimeError,match='^fixture_failed$'):f.run()
    all_records=b''.join(p.read_bytes() for p in (root/'evidence').iterdir())
    output=capsys.readouterr()
    assert secret.encode() not in all_records and b'PRIVATE KEY' not in all_records
    assert secret not in output.err and 'PRIVATE KEY' not in output.err and output.out==''


@pytest.mark.parametrize('case',['valid','exact-bound','over-bound','duplicate','malformed','wrong-token'])
def test_preflight_reads_real_bounded_enrollment_stdin(staged_root,monkeypatch,case):
    import io,protected_host,protected_native,protected_io
    from types import SimpleNamespace
    root,value,_=staged_root;calls=[]
    token='obenr_'+'A'*43
    payload=json.dumps({'version':1,'enrollmentToken':token}).encode()
    if case=='exact-bound':payload+=b' '*(512-len(payload))
    if case=='over-bound':payload+=b' '*(513-len(payload))
    if case=='duplicate':payload=b'{"version":1,"version":1,"enrollmentToken":"'+token.encode()+b'"}'
    if case=='malformed':payload=payload[:-1]
    if case=='wrong-token':payload=json.dumps({'version':1,'enrollmentToken':'invalid'}).encode()
    cfg=SimpleNamespace(route=value['route'],policy=value['timing'],native={})
    monkeypatch.setattr(protected_host.Configuration,'load',lambda path:cfg)
    monkeypatch.setattr(protected_native,'LinuxNative',lambda *a,**k:object())
    monkeypatch.setattr(f.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(payload)))
    monkeypatch.setattr(f,'check_loopback',lambda port:calls.append(port))
    monkeypatch.setattr(f,'BASE',root.parent)
    monkeypatch.setattr(f,'clock',lambda:(100,'synthetic-boot'))
    exclusive(root.parent/'MANIFEST.json',{'relay/node':'c'*64})
    monkeypatch.setattr(protected_io,'digest',lambda path:value['nodeBundleSha256']
        if path.name=='product-command-node.cjs' else 'c'*64)
    if case in ('valid','exact-bound'):
        result=f.run_preflight()
        assert result[3]=={'version':1,'enrollmentToken':token}
        assert calls==[value['serverPort']]
    else:
        with pytest.raises((ValueError,RuntimeError)):f.run_preflight()
        assert calls==[]
    assert not (root/'run-reserved.json').exists() and not (root/'single-action.json').exists()


@pytest.mark.parametrize('step',['configuration','token','listener','bundle','node'])
def test_real_preflight_entry_failure_points(staged_root,monkeypatch,step):
    import protected_host,protected_native,protected_io
    from types import SimpleNamespace
    root,value,_=staged_root
    cfg=SimpleNamespace(route=value['route'],policy=value['timing'],native={})
    def load(path):
        if step=='configuration':raise RuntimeError('configuration_refused')
        return cfg
    monkeypatch.setattr(protected_host.Configuration,'load',load)
    monkeypatch.setattr(protected_native,'LinuxNative',lambda *a,**k:object())
    monkeypatch.setattr(f,'read_stdin',lambda n:{'version':1,'enrollmentToken':'bad' if step=='token' else 'obenr_'+'A'*43})
    monkeypatch.setattr(f,'check_loopback',lambda p:(_ for _ in ()).throw(RuntimeError('listener_refused')) if step=='listener' else None)
    monkeypatch.setattr(f,'BASE',root.parent)
    exclusive(root.parent/'MANIFEST.json',{'relay/node':'c'*64})
    monkeypatch.setattr(protected_io,'digest',lambda path:('d'*64 if step=='bundle' else value['nodeBundleSha256'])
        if path.name=='product-command-node.cjs' else ('d'*64 if step=='node' else 'c'*64))
    with pytest.raises(RuntimeError):f.run()
    assert status(root)['keyCleanupVerified'] is True and not (root/'run-reserved.json').exists()
    assert not (root/'secrets/enforcer.pem').exists()


def test_preflight_lock_released_after_reservation_before_process_setup(staged_root,monkeypatch):
    import fcntl
    from types import SimpleNamespace
    root,_,_=staged_root;calls=[]
    class NativeConfig(dict):
        def __getitem__(self,name):
            assert name=='pythonPath' and (root/'run-reserved.json').exists()
            fd=os.open(root/'stage-reserved.json',os.O_RDONLY)
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);calls.append('released')
            finally:os.close(fd)
            raise RuntimeError('stop_before_process_setup')
    cfg=SimpleNamespace(native=NativeConfig())
    monkeypatch.setattr(f,'run_preflight',lambda:(cfg,None,None,None,100,'boot'))
    monkeypatch.setattr(f,'record_prerun_failure',lambda *args:calls.append('incorrect_cleanup'))
    with pytest.raises(RuntimeError,match='stop_before_process_setup'):f.run()
    assert calls==['released'] and (root/'run-reserved.json').exists() and (root/'secrets/enforcer.pem').exists()
    assert not list((root/'evidence').iterdir())


@pytest.fixture
def import_gate(monkeypatch):
    import sys,protected_io
    checked=[]
    monkeypatch.setattr(f.sys,'platform','linux')
    monkeypatch.setattr(f.os,'geteuid',lambda:0)
    monkeypatch.setattr(sys,'path',sys.path.copy())
    monkeypatch.setattr(protected_io,'directory',lambda path:checked.append(path))
    monkeypatch.setattr(protected_io,'digest',lambda path:f.CASE_PINS[path.relative_to(f.CASE).as_posix()])
    monkeypatch.setattr(protected_io,'read_record',lambda path:{'success':True})
    return checked


@pytest.mark.parametrize('name',['product1','product2','product999'])
def test_import_gate_accepts_only_exact_selected_root(import_gate,monkeypatch,name):
    root=f.BASE/name
    monkeypatch.setattr(f,'ROOT',root)
    monkeypatch.setattr(f,'__file__',str(root/'product_host_fixture.py'))
    f.imports()
    assert import_gate==[f.BASE,f.CASE,root,f.CASE/'source',f.CASE/'python',f.BASE/'deps']


@pytest.mark.parametrize('root',['/opt/openbot-command-0925/product0','/opt/openbot-command-0925/product01',
    '/opt/openbot-command-0925/product1000','/opt/openbot-command-0925/product2/subdir',
    '/tmp/product2','/opt/openbot-command-0925-other/product2'])
def test_wrong_host_location_refuses_before_dependency_imports(import_gate,monkeypatch,root):
    monkeypatch.setattr(f,'ROOT',Path(root))
    monkeypatch.setattr(f,'__file__',str(Path(root)/'product_host_fixture.py'))
    with pytest.raises(RuntimeError,match='invalid_fixture_directory'):f.imports()
    assert import_gate==[]


@pytest.mark.parametrize('alias',['file','directory'])
def test_real_local_script_alias_cannot_select_consumed_root(import_gate,tmp_path,alias):
    import importlib.util
    root=tmp_path/'product1';root.mkdir()
    source=root/'product_host_fixture.py';source.write_bytes(Path(f.__file__).read_bytes())
    other=tmp_path/'product2'
    if alias=='directory':other.symlink_to(root,target_is_directory=True)
    else:
        other.mkdir();(other/'product_host_fixture.py').symlink_to(source)
    spec=importlib.util.spec_from_file_location('alias_fixture',other/'product_host_fixture.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    assert module.ROOT==root.resolve()
    module.BASE=tmp_path.resolve()  # Test the production alias comparison under an owned local base.
    with pytest.raises(RuntimeError,match='fixture_path_alias'):module.imports()
    assert import_gate==[]


def test_source_pins_and_native_runner_deadlines_unchanged():
    assert f.RUNNER_MS==150000 and f.RESERVE_MS==70000 and f.SESSION_MS==80000
    assert f.CASE_PINS=={
        'source/protected_native.py':'83499d136d20f649531e94f7293454a0ea48353070b6fad6074dfd5ded061718',
        'source/protected_host.py':'3ae3729d9ec874ce425278d6f58e6cc83956a8167935b144c3e4a315e972be80',
        'python/openbot_server/work_command_v2_crypto.py':'c483104faa6d255c5f55b6cd6462671a6d98611a51b8172dad9b7b8edcb90ded'}
    value=public();assert f.validate_public(value)['timing']['runtimeMaxMs']==50000


@pytest.mark.parametrize('failure,kind',[('missing','FileNotFoundError'),('directory','IsADirectoryError'),('bad_fd','OSError')])
def test_real_os_error_has_safe_location_and_independent_cleanup(staged_root,monkeypatch,capsys,failure,kind):
    root,_,_=staged_root
    secret='obenr_'+'A'*43
    def fail():
        if failure=='missing':(root/secret).read_bytes()
        elif failure=='directory':(root/'secrets').write_bytes(b'never')
        else:os.read(-1,1)
    monkeypatch.setattr(f,'run_preflight',fail)
    with pytest.raises(RuntimeError,match='^fixture_failed$'):f.run()
    found=status(root);error=read_record(root/'evidence/pre-run-error.json',uid=os.getuid())
    for record in (found,error):
        assert record['errorType']==kind and record['source']['file']=='product_host_fixture.py'
        assert record['source']['function']=='run' and type(record['source']['line']) is int
    assert found['keyCleanupVerified'] is True and found['cleanupUncertain'] is False
    assert not (root/'run-reserved.json').exists() and not (root/'secrets/enforcer.pem').exists()
    captured=capsys.readouterr();assert captured.out==''
    assert json.loads(captured.err)==found
    data=captured.err+json.dumps(error)
    assert secret not in data and str(root) not in data and 'PRIVATE KEY' not in data
    for path in (root/'evidence').iterdir():assert path.stat().st_mode&0o777==0o600


@pytest.mark.parametrize('source',['protected_io.py','protected_host.py','protected_native.py'])
def test_diagnostic_uses_last_exact_known_source_only(source):
    namespace={}
    exec(compile('def checked():\n    raise OSError("untrusted /private/path PEM token")\n',str(f.CASE/'source'/source),'exec'),namespace)
    try:namespace['checked']()
    except OSError as error:
        assert f.failure_details(error)=={'errorType':'OSError','source':{'file':source,'function':'checked','line':2}}


def test_unknown_source_and_secret_metadata_are_not_copied():
    secret='obenr_'+'A'*43;namespace={}
    # Matching basename in an unrelated directory is not an accepted source.
    exec(compile('def '+secret+'():\n    raise OSError("-----BEGIN PRIVATE KEY-----")\n',
        '/untrusted/'+secret+'/protected_io.py','exec'),namespace)
    try:namespace[secret]()
    except OSError as error:assert f.failure_details(error)=={'errorType':'OSError'}
    unknown=type(secret,(Exception,),{})('private')
    assert f.failure_details(unknown)=={'errorType':'Exception'}


def test_cleanup_error_also_retains_safe_location_and_unknown_state(staged_root,monkeypatch,capsys):
    root,_,_=staged_root;(root/'secrets/enforcer.pub').unlink()
    monkeypatch.setattr(f,'run_preflight',refuse)
    with pytest.raises(RuntimeError):f.run()
    found=status(root)
    assert found['cleanupError']['errorType']=='FileNotFoundError'
    assert found['cleanupError']['source']['file']=='product_host_fixture.py'
    assert found['cleanupError']['source']['function']=='cleanup_prerun_key'
    assert found['keyCleanupVerified'] is False and found['cleanupUncertain'] is True
    assert (root/'secrets/enforcer.pem').exists()
    assert str(root) not in capsys.readouterr().err
