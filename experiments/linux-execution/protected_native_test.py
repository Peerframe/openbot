"""Native command/readback counterexamples. These never launch Linux processes or units."""
from copy import deepcopy
import hashlib
import os
from pathlib import Path
from types import SimpleNamespace
import pytest
import protected_native as n
from protected_io import Refused,exclusive,read_record

@pytest.mark.parametrize('mutation',['expired','boot','instance'])
def test_fixed_helper_checks_actual_local_guard(tmp_path,monkeypatch,mutation):
    path=tmp_path/'instance.json';exclusive(path,{'instanceId':'original'})
    monkeypatch.setattr(n,'read_record',lambda p:read_record(p,uid=os.getuid()))
    value={'bootId':'boot','enforcerInstanceId':'original','expiresBoottimeUs':5000}
    clock=lambda:(1000,1000,'boot')
    if mutation=='expired':clock=lambda:(5000,5000,'boot')
    if mutation=='boot':clock=lambda:(1000,1000,'another')
    if mutation=='instance':value['enforcerInstanceId']='old'
    with pytest.raises(Refused):n.guard(value,path,clock=clock)

def test_valid_guard_and_exact_native_duration(tmp_path,monkeypatch):
    path=tmp_path/'instance.json';exclusive(path,{'instanceId':'original'});monkeypatch.setattr(n,'read_record',lambda p:read_record(p,uid=os.getuid()))
    assert n.guard({'bootId':'boot','enforcerInstanceId':'original','expiresBoottimeUs':5000},path,clock=lambda:(1,2,'boot'))==(1,2)
    props=n.properties('unit',50000,'/opt/keys')
    assert props['RuntimeMaxSec']=='50000ms' and props['Restart']=='no' and props['KillMode']=='control-group' and props['InaccessiblePaths']=='/opt/keys'
    with pytest.raises(Refused):n.properties('unit',50001,'/opt/keys')
    with pytest.raises(Refused):n.properties('unit',True,'/opt/keys')

def test_libnetwork_and_shim_paths_preflight():
    n.preflight_paths(Path('/opt/obh/a123456789ab'))
    with pytest.raises(Refused):n.preflight_paths(Path('/opt/')/('a'*70))
    assert any('libnetwork/0123456789ab.sock' in str(p) for p in n.socket_paths(Path('/opt/x')))

def test_private_daemon_configuration_never_uses_default_socket():
    root=Path('/opt/obh/a123456789ab');daemon,containerd=n.config_values(root,'openbot-command-'+'a'*32+'.service',Path('/opt/bin'))
    assert daemon['containerd']==str(root/'containerd.sock') and daemon['hosts']==['unix://'+str(root/'docker.sock')]
    assert daemon['containerd-namespace']=='openbot-command' and daemon['live-restore'] is False
    assert all(daemon[k] is False for k in ('iptables','ip6tables','ip-forward','ip-masq','userland-proxy'))
    assert 'io.containerd.cri.v1' in containerd and str(root/'containerd-state') in containerd
    assert daemon['runtimes']['runsc']['runtimeArgs']==['--platform=systrap']
    assert daemon['log-opts']=={'max-size':'1m','max-file':'1','compress':'false'}

@pytest.mark.parametrize('mutation',['large','sparse','symlink','extra','fifo','nul','invalid_utf8'])
def test_native_output_is_one_bounded_utf8_regular_file(tmp_path,mutation):
    path=tmp_path/'proof.txt';path.write_bytes(b'good')
    if mutation=='large':path.write_bytes(b'x'*11)
    if mutation=='sparse':
        with path.open('wb') as out:out.truncate(100*1024**3)
    if mutation=='symlink':path.unlink();path.symlink_to('/etc/passwd')
    if mutation=='extra':(tmp_path/'other').write_bytes(b'x')
    if mutation=='fifo':path.unlink();os.mkfifo(path)
    if mutation=='nul':path.write_bytes(b'a\x00')
    if mutation=='invalid_utf8':path.write_bytes(b'\xff')
    with pytest.raises((Refused,OSError,UnicodeError)):n.bounded_output({'output':str(tmp_path)},dict(name='proof.txt',maxBytes=10))

def test_native_bounded_output_exact_bytes(tmp_path):
    (tmp_path/'proof.csv').write_bytes(b'x,y\n1,2\n')
    assert n.bounded_output({'output':str(tmp_path)},dict(name='proof.csv',maxBytes=1048576))==b'x,y\n1,2\n'

def test_execute_rechecks_guard_between_create_and_start(tmp_path,monkeypatch):
    root=tmp_path;exclusive(root/'launch.json',{'operation':{'command':{}},'guard':{'expiresBoottimeUs':5000000}})
    monkeypatch.setattr(n,'read_record',lambda p:read_record(p,uid=os.getuid()));monkeypatch.setattr(n,'join_original',lambda *a,**k:None)
    monkeypatch.setattr(n,'prepared',lambda *a:object());calls=[]
    class Cli:
        def create(self,*args,**kwargs):calls.append('create');return object()
        def start(self,*args,**kwargs):calls.append('start')
        def inspect(self,name):return {'Id':name,'HostConfig':{'LogConfig':{'Config':{'compress':'false'}}}}
    class Engine:
        cli=Cli()
        def create(self,prepared):self.cli.create([]);return {'container_id':'original'}
        def start_once(self,record):self.cli.start('original')
    engine=Engine();monkeypatch.setattr(n,'box',lambda r:engine);monkeypatch.setattr(n,'actual_clock',lambda:(1,1,'boot'))
    def guard(value,path):
        calls.append('guard')
        if 'create' in calls:raise Refused('expired')
    monkeypatch.setattr(n,'guard',guard)
    with pytest.raises(Refused):n.execute({'root':str(root),'instancePath':'fixed'})
    assert calls.count('create')==1 and 'start' not in calls

def test_unknown_unit_without_invocation_is_never_stopped(tmp_path,monkeypatch):
    native=n.LinuxNative.__new__(n.LinuxNative);native.config={};native.checked=lambda record:tmp_path
    native.show=lambda unit:{'LoadState':'loaded','InvocationID':'foreign','ControlGroup':'/system.slice/original'}
    calls=[];native.command=lambda *a,**k:calls.append(a)
    with pytest.raises(Refused):native.stop({'unit':'original'})
    assert not calls

def test_original_invocation_required_for_stop(tmp_path,monkeypatch):
    exclusive(tmp_path/'runtime-ready.json',{'invocationId':'original'});monkeypatch.setattr(n,'read_record',lambda p:read_record(p,uid=os.getuid()))
    native=n.LinuxNative.__new__(n.LinuxNative);native.config={};native.checked=lambda record:tmp_path
    native.show=lambda unit:{'LoadState':'loaded','InvocationID':'foreign'};native.command=lambda *a,**k:pytest.fail('wrong-unit stop')
    with pytest.raises(Refused):native.stop({'unit':'original'})


@pytest.mark.parametrize('mutation',['filesystem','size','shared','mode','missing_noexec'])
def test_private_shim_tmpfs_actual_readback_refuses(mutation):
    import stat
    mount={'id':5,'path':Path('/run/containerd'),'root':'/','filesystem':'tmpfs','options':{'rw','nosuid','nodev','noexec'},'super_options':{'rw'},'propagation':[]}
    identity=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700,st_dev=2,st_ino=3);size=16*1024**2
    if mutation=='filesystem':mount['filesystem']='ext4'
    if mutation=='size':size+=4096
    if mutation=='shared':mount['propagation']=['shared:1']
    if mutation=='mode':identity.st_mode=stat.S_IFDIR|0o755
    if mutation=='missing_noexec':mount['options'].remove('noexec')
    with pytest.raises(Refused):n.check_socket_mount_facts([mount],identity,5,size)


def test_private_shim_tmpfs_fixed_request_and_valid_readback():
    import stat
    assert n.properties('unit',50000,'/opt/keys')['MountFlags']=='private'
    assert n.properties('unit',50000,'/opt/keys')['TemporaryFileSystem']=='/run/containerd:rw,nosuid,nodev,noexec,mode=0700,size=16m'
    mount={'id':5,'path':Path('/run/containerd'),'root':'/','filesystem':'tmpfs','options':{'rw','nosuid','nodev','noexec'},'super_options':{'rw'},'propagation':[]}
    identity=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700,st_dev=2,st_ino=3)
    assert n.check_socket_mount_facts([mount],identity,5,16*1024**2)['filesystemBytes']==16*1024**2


def shim_facts():
    import stat
    return ({'id':5,'path':Path('/run/containerd'),'root':'/','filesystem':'tmpfs',
             'options':{'rw','nosuid','nodev','noexec'},'super_options':{'rw','size=16384k','mode=700'},'propagation':[]},
            SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700,st_dev=2,st_ino=3))


@pytest.mark.parametrize('mutation,code',[
    ('path','shim_mount_path'),('root','shim_mount_root'),('filesystem','shim_mount_filesystem'),
    ('options','shim_mount_options'),('readonly','shim_mount_readonly'),('shared','shim_mount_propagation'),
    ('slave','shim_mount_propagation'),('unknown_propagation','shim_mount_propagation'),
    ('uid','shim_mount_uid'),('mode','shim_mount_mode'),('size','shim_mount_capacity'),
    ('zero_size','shim_mount_capacity'),('missing','shim_mount_ambiguous'),('duplicate','shim_mount_ambiguous')])
def test_shim_refusal_remains_closed_with_exact_code(mutation,code):
    mount,identity=shim_facts();mounts=[mount];size=16*1024**2
    if mutation=='path':mount['path']=Path('/unexpected')
    if mutation=='root':mount['root']='/subtree'
    if mutation=='filesystem':mount['filesystem']='ext4'
    if mutation=='options':mount['options'].remove('noexec')
    if mutation=='readonly':mount['super_options'].add('ro')
    if mutation=='shared':mount['propagation']=['shared:123']
    if mutation=='slave':mount['propagation']=['master:123']
    if mutation=='unknown_propagation':mount['propagation']=['future:unknown']
    if mutation=='uid':identity.st_uid=1000
    if mutation=='mode':identity.st_mode=0o40755
    if mutation=='size':size+=4096
    if mutation=='zero_size':size=0
    if mutation=='missing':mounts=[]
    if mutation=='duplicate':mounts.append(dict(mount))
    with pytest.raises(Refused,match='^'+code+'$'):n.check_socket_mount_facts(mounts,identity,5,size)


def test_shim_snapshot_excludes_arbitrary_path_and_option_values():
    import json
    mount,identity=shim_facts();mount.update(path=Path('/private-secret-path'),root='/private-subtree',filesystem='private-fs-name')
    mount['options'].add('sensitive=secret_value');mount['super_options'].add('context=secret_label')
    mount['propagation']=['shared:123','master:2','propagate_from:4','unbindable','secret_field']
    value=n.socket_mount_snapshot([mount],identity,5,16*1024**2);encoded=json.dumps(value)
    assert all(s not in encoded for s in ('private-secret','private-subtree','private-fs-name','secret_value','secret_label','secret_field','sensitive='))
    assert value['mount']['filesystem']=='other' and value['mount']['unknownFlagCount']==1
    assert value['mount']['propagation']==[{'kind':'shared','group':123},{'kind':'master','group':2},{'kind':'propagate_from','group':4},{'kind':'unbindable'},{'kind':'unknown'}]
    assert value['mode']==0o700 and value['filesystemBytes']==16*1024**2


def test_failed_shim_check_persists_safe_protected_snapshot_before_refusal(tmp_path,monkeypatch):
    original_open=os.open;original_fstat=os.fstat;descriptor=[]
    def open_owned(path,flags,*args,**kwargs):
        if str(path)=='/run/containerd':
            fd=original_open(tmp_path,flags);descriptor.append(fd);return fd
        return original_open(path,flags,*args,**kwargs)
    mount,identity=shim_facts();mount['propagation']=['shared:123']
    with monkeypatch.context() as m:
        m.setattr(n.os,'open',open_owned)
        m.setattr(n.os,'fstat',lambda fd:identity if descriptor and fd==descriptor[0] else original_fstat(fd))
        m.setattr(n.os,'fstatvfs',lambda fd:SimpleNamespace(f_blocks=4096,f_frsize=4096))
        m.setattr(n,'_mount_id',lambda fd:5)
        m.setattr(n,'_read_text',lambda path:'synthetic kernel mountinfo')
        m.setattr(n,'_mounts',lambda text:[mount])
        with pytest.raises(Refused,match='^shim_mount_propagation$'):
            n.verify_runtime_socket_mount(record_path=tmp_path/'shim.json')
    value=read_record(tmp_path/'shim.json',uid=os.getuid())
    assert value['mount']['propagation']==[{'kind':'shared','group':123}]
    assert (tmp_path/'shim.json').stat().st_mode&0o777==0o600
    with pytest.raises(OSError):os.fstat(descriptor[0])


def test_shim_record_error_does_not_turn_into_acceptance(monkeypatch,tmp_path):
    mount,identity=shim_facts();fd=os.open(tmp_path,os.O_RDONLY|os.O_DIRECTORY);original_open=os.open
    with monkeypatch.context() as m:
        m.setattr(n.os,'open',lambda path,flags:fd)
        m.setattr(n.os,'fstat',lambda fd:identity)
        m.setattr(n.os,'fstatvfs',lambda fd:SimpleNamespace(f_blocks=4096,f_frsize=4096))
        m.setattr(n,'_mount_id',lambda fd:5);m.setattr(n,'_read_text',lambda path:'same');m.setattr(n,'_mounts',lambda text:[mount])
        m.setattr(n,'exclusive',lambda *a:(_ for _ in ()).throw(OSError('synthetic fsync failure')))
        with pytest.raises(OSError):n.verify_runtime_socket_mount(record_path=tmp_path/'refused.json')
    with pytest.raises(OSError):os.fstat(fd)


@pytest.mark.parametrize('value',[
    {'type':'s','data':'private'},{'type':'u','data':262144},
    {'type':'t','data':'262144'},{'type':'t','data':True},{'type':'t','data':262144.0},
    {'type':'t','data':[262144]},{'type':'t','data':0},{'type':'t','data':524288},
    {'type':'t','data':1048576},{'type':'t','data':278528},
    {'type':'t','data':262144,'extra':0},{'type':'t'},[],None])
def test_typed_mount_flags_require_only_uint64_private(value):
    import json
    replies=iter([{'type':'o','data':['/org/freedesktop/systemd1/unit/original']},value])
    with pytest.raises(Refused,match='^unit_mount_flags_changed$'):
        n.private_mount_flags('original.service',lambda args:json.dumps(next(replies)))


@pytest.mark.parametrize('value',[
    {'type':'s','data':['/org/freedesktop/systemd1/unit/original']},
    {'type':'o','data':'/org/freedesktop/systemd1/unit/original'},
    {'type':'o','data':[]},{'type':'o','data':['/elsewhere']},
    {'type':'o','data':['/org/freedesktop/systemd1/unit/original','second']},
    {'type':'o','data':[False]},[],None])
def test_mount_flags_resolve_only_typed_unit_object(value):
    import json
    calls=[]
    def command(args):calls.append(args);return json.dumps(value)
    with pytest.raises(Refused,match='^unit_mount_object_changed$'):
        n.private_mount_flags('original.service',command)
    assert len(calls)==1


def test_mount_flags_read_original_service_exact_property():
    import json
    calls=[];replies=iter([{'type':'o','data':['/org/freedesktop/systemd1/unit/original_2eservice']},{'type':'t','data':262144}])
    def command(args):calls.append(args);return json.dumps(next(replies))
    assert n.private_mount_flags('original.service',command)=={'type':'t','data':262144}
    assert calls[0][-3:]==['GetUnit','s','original.service']
    assert calls[1]==['/usr/bin/busctl','--json=short','get-property','org.freedesktop.systemd1',
        '/org/freedesktop/systemd1/unit/original_2eservice','org.freedesktop.systemd1.Service','MountFlags']


def test_daemon_mount_flag_refusal_is_before_any_producer(tmp_path,monkeypatch):
    calls=[]
    monkeypatch.setattr(n,'read_record',lambda p:{})
    monkeypatch.setattr(n,'guard',lambda *a:calls.append('guard'))
    monkeypatch.setattr(n,'verify_runtime_socket_mount',lambda **kw:calls.append('mount'))
    def refuse(*args):calls.append('flags');raise Refused('unit_mount_flags_changed')
    monkeypatch.setattr(n,'private_mount_flags',refuse)
    monkeypatch.setattr(n.subprocess,'Popen',lambda *a,**kw:pytest.fail('producer started'))
    with pytest.raises(Refused,match='^unit_mount_flags_changed$'):
        n.daemon({'root':str(tmp_path),'unit':'original.service','instancePath':'original-instance'})
    assert calls==['guard','mount','flags']
