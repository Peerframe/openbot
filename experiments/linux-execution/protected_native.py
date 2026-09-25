"""Fixed Linux native adapter over the reviewed Docker/runsc precursor; never arbitrary RPC."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import stat
import subprocess
import sys
import time

import sandbox
import deadline_probe as prior
from output_capacity import verify_output_capacity, _mounts, _read_text, _mount_id
from protected_io import Refused, require, directory, digest, exclusive, read_record, fsync_dir, read_bytes
from openbot_server.work_command_contract import Command, parse, bounded_value

SOURCES=('protected_native.py','protected_io.py','sandbox.py','output_capacity.py','deadline_probe.py')
BINS=prior.BINARY_FILES
REVIEWED_BINARY_HASHES={'containerd': '8260dd2b405520c10d44f1b75ace6b58e2579d10113cadc6d6b8df533ff68f6e', 'containerd-shim-runsc-v1': '4b0c2a8eb7414d8b5f3d032e158784b454e9c98ffa3fdebbdd79047faf930d7c', 'docker': '9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581', 'dockerd': '809c45f959337b17be8b413d96fdcaad826393eef643b4e476a5df918d25a162', 'gvisor-bin/checkpointgofer': 'e29be2ab32a10eb885c4a46635f47b80ad661be6f23b5d7903f11906941c7aab', 'gvisor-bin/gvisor-sentry-prewarmer': '3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0', 'gvisor-bin/gvisor_sentry': 'aff3ed7dfac54b04aab14de2dde53e021402f0ba238bc7ece3ac7d4b6604b055', 'gvisor-bin/runsc-fd-parking': '03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11', 'gvisor-bin/runsc-metric-server': '02bb563cd060fe7992ccd00927024b02b70e0803b61abfa015e158d9d7e88507', 'runsc': 'c0f4ec0ac1198975d5cf919a78f2302426de096f69eebd33e50125c3ca42d699'}
ENV_BASE={'LANG':'C','LC_ALL':'C'}

def hash_value(value):return hashlib.sha256(bounded_value(value,maximum=32768)).hexdigest()
def actual_clock():return time.monotonic_ns()//1000,time.clock_gettime_ns(time.CLOCK_BOOTTIME)//1000,Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def guard(value,instance_path,*,clock=actual_clock):
    mono,boot,identity=clock()
    require(identity==value['bootId'] and boot<value['expiresBoottimeUs'] and value['enforcerInstanceId']==read_record(instance_path)['instanceId'],'native_guard_expired')
    return mono,boot

def socket_paths(root):
    # containerd hashes shim socket names under its fixed state socket directory. libnetwork does not.
    return [root/'docker.sock',root/'containerd.sock',root/'docker-exec/libnetwork/0123456789ab.sock',
        root/'containerd-state/s'/('0'*64),Path('/run/containerd/s')/('0'*64)]

def preflight_paths(root):
    require(all(len(os.fsencode(p))<=106 for p in socket_paths(root)),'native_socket_path_too_long')

def properties(unit,runtime_ms,secrets):
    require(type(runtime_ms) is int and 1<=runtime_ms<=50000,'unqualified_runtime')
    return {**prior.UNIT_PROPERTIES,'RuntimeMaxSec':str(runtime_ms)+'ms','InaccessiblePaths':str(secrets),'MountFlags':'private','TemporaryFileSystem':'/run/containerd:rw,nosuid,nodev,noexec,mode=0700,size=16m'}

def private_mount_flags(unit,command):
    # systemd 255 exports uint64 MS_PRIVATE, not its textual unit-file value.
    service='org.freedesktop.systemd1'
    found=json.loads(command(['/usr/bin/busctl','--json=short','call',service,
        '/org/freedesktop/systemd1',service+'.Manager','GetUnit','s',unit]))
    require(type(found) is dict and set(found)=={'type','data'} and found['type']=='o'
        and type(found['data']) is list and len(found['data'])==1,'unit_mount_object_changed')
    path=found['data'][0]
    require(type(path) is str and re.fullmatch('/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+',path) is not None,'unit_mount_object_changed')
    value=json.loads(command(['/usr/bin/busctl','--json=short','get-property',service,path,
        service+'.Service','MountFlags']))
    require(type(value) is dict and set(value)=={'type','data'} and value['type']=='t'
        and type(value['data']) is int and value['data']==1<<18,'unit_mount_flags_changed')
    return value

def socket_mount_snapshot(mounts,identity,mount_id,filesystem_bytes):
    """Only finite kernel facts; never persist raw mount tables or option values."""
    matches=[m for m in mounts if m['id']==mount_id]
    value=dict(version=1,mountId=mount_id,matchCount=len(matches),device=identity.st_dev,inode=identity.st_ino,
        uid=identity.st_uid,mode=stat.S_IMODE(identity.st_mode),filesystemBytes=filesystem_bytes)
    if len(matches)==1:
        mount=matches[0];known={'rw','ro','nosuid','suid','nodev','dev','noexec','exec','relatime','strictatime','noatime','lazytime','sync','dirsync'}
        propagation=[]
        for field in mount['propagation']:
            match=re.fullmatch(r'(shared|master|propagate_from):([0-9]{1,16})',field)
            if match and int(match[2])<2**53:propagation.append(dict(kind=match[1],group=int(match[2])))
            else:propagation.append(dict(kind='unbindable' if field=='unbindable' else 'unknown'))
        value['mount']=dict(expectedPath=mount['path']==Path('/run/containerd'),filesystemRoot=mount['root']=='/',
            filesystem=mount['filesystem'] if mount['filesystem'] in ('tmpfs','ext4','overlay') else 'other',
            flags=sorted(mount['options']&known),unknownFlagCount=len(mount['options']-known),
            superReadOnly='ro' in mount['super_options'],propagation=propagation)
    return value


def check_socket_mount_facts(mounts,identity,mount_id,filesystem_bytes):
    matches=[m for m in mounts if m['id']==mount_id]
    require(len(matches)==1,'shim_mount_ambiguous');mount=matches[0]
    require(mount['path']==Path('/run/containerd'),'shim_mount_path')
    require(mount['root']=='/','shim_mount_root')
    require(mount['filesystem']=='tmpfs','shim_mount_filesystem')
    require({'rw','nosuid','nodev','noexec'}<=mount['options'],'shim_mount_options')
    require('ro' not in mount['super_options'],'shim_mount_readonly')
    require(not mount['propagation'],'shim_mount_propagation')
    require(identity.st_uid==0,'shim_mount_uid')
    require(stat.S_IMODE(identity.st_mode)==0o700,'shim_mount_mode')
    require(0<filesystem_bytes<=16*1024**2,'shim_mount_capacity')
    return {'mountId':mount_id,'device':identity.st_dev,'inode':identity.st_ino,'filesystemBytes':filesystem_bytes}


def verify_runtime_socket_mount(*,record_path=None):
    fd=os.open('/run/containerd',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        before=_read_text(Path('/proc/self/mountinfo'));stats=os.fstatvfs(fd)
        mounts=_mounts(before);identity=os.fstat(fd);mount_id=_mount_id(fd);size=stats.f_blocks*stats.f_frsize
        # The fixed daemon owns this path. Failed validation remains an original preparation failure.
        if record_path is not None:exclusive(record_path,socket_mount_snapshot(mounts,identity,mount_id,size))
        result=check_socket_mount_facts(mounts,identity,mount_id,size)
        require(_read_text(Path('/proc/self/mountinfo'))==before,'shim_mount_race');return result
    finally:os.close(fd)

def config_values(root,unit,bins):
    daemon={'hosts':['unix://'+str(root/'docker.sock')],'data-root':str(root/'docker-data'),
        'exec-root':str(root/'docker-exec'),'pidfile':str(root/'dockerd.pid'),'bridge':'none','iptables':False,
        'ip6tables':False,'ip-forward':False,'ip-masq':False,'userland-proxy':False,'live-restore':False,
        'runtimes':{'runsc':{'path':str(bins/'runsc'),'runtimeArgs':['--platform=systrap']}},'default-runtime':'runsc',
        'exec-opts':['native.cgroupdriver=cgroupfs'],'cgroup-parent':'/system.slice/'+unit,
        'log-driver':'local','log-opts':{'max-size':'1m','max-file':'1','compress':'false'},'containerd':str(root/'containerd.sock'),
        'containerd-namespace':'openbot-command','containerd-plugins-namespace':'openbot-command-plugins'}
    containerd=(f'version = 3\nroot = "{root}/containerd-data"\nstate = "{root}/containerd-state"\n'
        'disabled_plugins = ["io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime"]\n'
        f'[grpc]\n  address = "{root}/containerd.sock"\n')
    return daemon,containerd

class LinuxNative:
    def __init__(self,config,*,route,policy):
        self.config=config;self.route=route;self.policy=policy;self.instance_path=None
        require(sys.platform=='linux' and os.geteuid()==0,'linux_root_required')
        require(set(config)=={'base','binaries','archive','archiveSha256','image','imageTag','sources','sourceHashes','binaryHashes','python','pythonPath','secretsDirectory'},'invalid_native_config')
        for key in ('base','binaries','sources','secretsDirectory'):directory(config[key])
        require(config['binaryHashes']==REVIEWED_BINARY_HASHES and set(config['sourceHashes'])==set(SOURCES),'missing_native_pin')
        require(config['archiveSha256']==prior.ARCHIVE_SHA and config['image']==prior.IMAGE,'unreviewed_image')
        for name,expected in config['binaryHashes'].items():
            p=Path(config['binaries'])/name;prior.trusted_file(p);require(digest(p)==expected,'binary_changed')
        for name,expected in config['sourceHashes'].items():
            p=Path(config['sources'])/name;read_bytes(p,1024*1024,private=False);require(digest(p)==expected,'source_changed')
        archive=Path(config['archive']);directory(archive.parent);read_bytes(archive,0,private=False) if archive.stat().st_size==0 else None
        require(archive.is_file() and not archive.is_symlink() and archive.stat().st_uid==0 and not archive.stat().st_mode&0o022 and digest(archive)==config['archiveSha256'],'archive_changed')
        python=Path(config['python']);require(python.is_absolute() and python.is_file(),'invalid_python')
        directory(python.parent,private=False);prior.trusted_file(python.resolve())
        for path in config['pythonPath']:directory(path,private=False)
        require(config['imageTag'].split(':')[0]==config['image'].split('@')[0],'image_tag_changed')
        prior.ENV=self.env()
        require(self.command(['/usr/bin/systemctl','--version']).splitlines()[0].startswith('systemd 255'),'systemd_version_changed')
    def env(self):
        return {**ENV_BASE,'PATH':self.config['binaries']+':/usr/sbin:/usr/bin:/sbin:/bin','PYTHONPATH':os.pathsep.join(self.config['pythonPath'])}
    def command(self,argv,timeout=3,limit=1048576):
        result=sandbox.SubprocessCommander(binary=argv[0],extra_environment=self.env(),capture_limit_bytes=limit).run(argv[1:],timeout=timeout)
        require(result.ok,'native_command_unknown');return result.stdout.strip()
    def show(self,unit):
        runner=sandbox.SubprocessCommander(binary='/usr/bin/systemctl',extra_environment=self.env(),capture_limit_bytes=65536)
        value=runner.run(('show',unit,'--all','--no-pager','--property='+','.join(prior.SHOW)),timeout=3)
        facts=dict(line.split('=',1) for line in value.stdout.splitlines() if '=' in line)
        require(value.ok or value.status==1 and facts.get('LoadState')=='not-found','native_readback_unknown');return facts
    def reserve(self,binding,authorization,instance):
        require(authorization['staging']['image']==self.config['image'] and authorization['staging']['limits']['outputMiB']==64,'unsupported_image_or_capacity')
        root=Path(self.config['base'])/binding['preparationId'].replace('-','')[:12];preflight_paths(root)
        unit='openbot-command-'+binding['preparationId'].replace('-','')+'.service'
        require(self.show(unit).get('LoadState')=='not-found','unit_already_exists')
        root.mkdir(mode=0o700);fsync_dir(root.parent)
        for name in ('config','docker-config','work'):(root/name).mkdir(mode=0o700)
        for name in ('input','output'):(root/'work'/name).mkdir(mode=0o700)
        record={'root':str(root),'unit':unit,'input':str(root/'work/input'),'output':str(root/'work/output'),
            'binding':binding,'instanceId':instance,'instancePath':str(self.instance_path),'configuration':self.config,
            'runtimeMaxMs':authorization['timing']['runtimeMaxMs'],'timingPolicyDigest':authorization['timing']['policyDigest']}
        exclusive(root/'native.json',record)
        daemon,containerd=config_values(root,unit,Path(self.config['binaries']));exclusive(root/'config/daemon.json',daemon)
        fd=os.open(root/'config/containerd.toml',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:os.write(fd,containerd.encode());os.fsync(fd)
        finally:os.close(fd)
        fsync_dir(root/'config');return record
    def checked(self,record):
        root=Path(record['root']);require(root.parent==Path(self.config['base']) and root.resolve()==root,'native_root_changed')
        require(read_record(root/'native.json')==record,'native_record_changed');return root
    def helper_argv(self,record,mode):
        return [self.config['python'],str(Path(self.config['sources'])/'protected_native.py'),mode,'--root',record['root']]
    def prepare(self,record,authorization,start):
        root=self.checked(record)
        expiry=start[1]+authorization['timing']['challengeBudgetMs']*1000
        startup={'bootId':start[2],'enforcerInstanceId':record['instanceId'],'expiresBoottimeUs':expiry}
        exclusive(root/'startup.json',startup);guard(startup,record['instancePath'])
        exclusive(root/'unit-reserved.json',{'unit':record['unit'],'guard':startup})
        args=['/usr/bin/systemd-run','--unit='+record['unit'],'--service-type=exec',
            *('--property='+k+'='+v for k,v in properties(record['unit'],record['runtimeMaxMs'],self.config['secretsDirectory']).items()),
            '--setenv=PATH='+self.env()['PATH'],'--setenv=PYTHONPATH='+self.env()['PYTHONPATH'],*self.helper_argv(record,'daemon')]
        self.command(args,timeout=3)
        # Only observe this original job. Missing ACK or late readiness never resubmits it.
        end=time.monotonic()+min(authorization['timing']['prepareBudgetMs']/1000,record['runtimeMaxMs']/1000-1)
        while time.monotonic()<end:
            state=self.show(record['unit']);require(state.get('ActiveState') not in ('failed','inactive'),'native_preparation_failed')
            if state.get('ActiveState')=='active' and not (root/'unit-observed.json').exists():
                pid=int(state['MainPID']);argv=Path(f'/proc/{pid}/cmdline').read_bytes().rstrip(b'\x00').decode().split('\x00')
                require(argv==self.helper_argv(record,'daemon'),'native_main_process_changed')
                exclusive(root/'unit-observed.json',{'invocationId':state['InvocationID'],'pid':pid})
            if (root/'runtime-ready.json').exists():
                self.check_alive(record);return
            time.sleep(.025)
        raise Refused('native_preparation_unknown')
    def check_alive(self,record):
        root=self.checked(record);value=self.show(record['unit']);value.update(prior.stop_hooks(record['unit']))
        private_mount_flags(record['unit'],self.command)
        exact={'Type':'exec','KillMode':'control-group','KillSignal':'9','FinalKillSignal':'9','SendSIGKILL':'yes',
            'Restart':'no','NRestarts':'0','NotifyAccess':'none','ExecStop':'','ExecStopPost':'','TriggeredBy':'',
            'PrivateNetwork':'yes','PrivateMounts':'yes','DelegateSubgroup':'supervisor','MemoryMax':str(2500*1024**2),
            'MemorySwapMax':'0','TasksMax':'1536','ControlGroup':'/system.slice/'+record['unit'],'ActiveState':'active'}
        require(all(value.get(k)==v for k,v in exact.items()),'unit_shape_changed')
        require(prior.seconds(value['RuntimeMaxUSec'])*1000==record['runtimeMaxMs'] and prior.seconds(value['RuntimeRandomizedExtraUSec'])==0
            and prior.seconds(value['TimeoutStopUSec'])==1 and prior.seconds(value['CPUQuotaPerSecUSec'])==1.5,'unit_resources_changed')
        require(re.fullmatch('[a-f0-9]{32}',value['InvocationID']) is not None,'unit_identity_missing')
        group=Path('/sys/fs/cgroup')/value['ControlGroup'].lstrip('/');identity=group.stat().st_ino
        observed=read_record(root/'runtime-ready.json')
        require(value['InvocationID']==observed['invocationId'] and identity==observed['cgroupInode'],'unit_identity_changed')
        active=int(value['ActiveEnterTimestampMonotonic']);mono,boot,bootid=actual_clock()
        require(active>0 and mono<active+record['runtimeMaxMs']*1000 and bootid==observed['bootId'],'native_expired')
        members=prior.cgroup_members(group);require({observed['supervisorPid'],observed['containerdPid'],observed['dockerPid']}.issubset({m['pid'] for m in members}),'runtime_escaped')
        for ns in ('mnt','net'):
            require(os.readlink(f"/proc/{observed['supervisorPid']}/ns/{ns}")==observed['namespaces'][ns]
                and observed['namespaces'][ns]!=os.readlink('/proc/1/ns/'+ns),'namespace_changed')
        return value,observed,mono,boot
    def readiness(self,record,authorization):
        value,observed,mono,boot=self.check_alive(record);root=Path(record['root'])
        manifest=sandbox.hash_input_tree(root/'work/input').as_detail();require(manifest['digest']==authorization['staging']['inputDigest'],'input_readback_changed')
        os.chmod(root/'work/input',0o555)
        return dict(bootId=observed['bootId'],enforcerInstanceId=record['instanceId'],unitName=record['unit'],invocationId=observed['invocationId'],
            cgroupPath=value['ControlGroup'],cgroupInode=observed['cgroupInode'],activeMonotonicUs=int(value['ActiveEnterTimestampMonotonic']),
            runtimeMaxUs=record['runtimeMaxMs']*1000,observedMonotonicUs=mono,observedBoottimeUs=boot,
            runtimeIdentityDigest=observed['runtimeIdentityDigest'],runtimeShapeDigest=observed['runtimeShapeDigest'],
            timingPolicyDigest=record['timingPolicyDigest'],startAttempts=0)
    def execute(self,record,operation,launch):
        root=self.checked(record);self.check_alive(record);guard(launch,record['instancePath'])
        exclusive(root/'launch.json',{'operation':operation,'guard':launch})
        self.command(self.helper_argv(record,'execute'),timeout=min(5,max(.01,(launch['expiresBoottimeUs']-actual_clock()[1])/1000000)))
    def lookup(self,record,operation,*,include_output):
        root=self.checked(record)
        ledger=sandbox.EventLedger(root/'work/events.jsonl');attempts=ledger.counters(record['binding']['actionId'],record['binding']['originalEpoch']).start_attempts if ledger.path.exists() else 0
        unknown=dict(phase='unknown',containerId=None,startAttempts=min(1,attempts),exitCode=None,sequence=1,runtimeShapeDigest=None,outputs=[],truncated=False)
        try:
            self.check_alive(record)
            result=json.loads(self.command(self.helper_argv(record,'lookup-output' if include_output else 'lookup'),timeout=3,limit=2*1048576))
            observation=result['observation'];data=base64.b64decode(result['data'],validate=True) if include_output and result['data'] is not None else None
            if not include_output:observation['outputs']=[]
            return observation,data
        except (Refused,OSError,ValueError):return unknown,None
    def stop(self,record):
        root=self.checked(record);current=self.show(record['unit'])
        if current.get('LoadState')=='not-found':return
        if (root/'runtime-ready.json').exists():require(current.get('InvocationID')==read_record(root/'runtime-ready.json')['invocationId'],'unit_identity_changed')
        else:
            require((root/'unit-observed.json').exists(),'unit_identity_unknown')
            require(current.get('InvocationID')==read_record(root/'unit-observed.json')['invocationId'],'unit_identity_changed')
        self.command(['/usr/bin/systemctl','stop',record['unit']],timeout=5)

    def cleanup(self,record):
        """Explicit operator cleanup only, after transport stop; never a Node wire method."""
        root=self.checked(record);current=self.show(record['unit'])
        observed=read_record(root/'runtime-ready.json') if (root/'runtime-ready.json').exists() else read_record(root/'unit-observed.json')
        require(current.get('InvocationID')==observed['invocationId'] and current.get('ActiveState') in ('inactive','failed')
            and current.get('NRestarts')=='0','original_unit_not_terminal')
        group=Path('/sys/fs/cgroup/system.slice')/record['unit']
        require(not prior.cgroup_members(group),'runtime_tree_not_empty')
        if (root/'loop.json').exists():
            loop=read_record(root/'loop.json');disk=Path(loop['backing'])
            require(disk==root/'output.ext4' and disk.lstat().st_ino==loop['inode'] and stat.S_ISREG(disk.lstat().st_mode),'backing_changed')
            found=json.loads(self.command(['/usr/sbin/losetup','--json','--list','--output','NAME,BACK-FILE',loop['device']]))
            require(found.get('loopdevices')==[{'name':loop['device'],'back-file':str(disk)}],'loop_identity_changed')
            self.command(['/usr/sbin/losetup','--detach',loop['device']]);disk.unlink();fsync_dir(root)
        elif (root/'loop-reserved.json').exists():
            raise Refused('loop_ack_unknown')
        require(shutil.rmtree.avoids_symlink_attacks,'unsupported_safe_cleanup')
        for name in ('docker-data','docker-exec','containerd-data','containerd-state'):
            target=root/name
            if target.exists():
                require(target.resolve()==target and target.lstat().st_uid==0 and stat.S_ISDIR(target.lstat().st_mode),'cleanup_path_changed')
                shutil.rmtree(target)
        exclusive(root/'cleaned.json',{'invocationId':observed['invocationId'],'originalReservationRetained':True})


def child_record(root):
    require(sys.platform=='linux' and os.geteuid()==0,'linux_root_required');directory(root)
    record=read_record(root/'native.json');require(record['root']==str(root),'native_root_changed')
    cfg=record['configuration'];require(root.parent==Path(cfg['base']),'native_root_changed')
    for source,sha in cfg['sourceHashes'].items():require(digest(Path(cfg['sources'])/source)==sha,'helper_source_changed')
    return record

def child_env(record):return {**ENV_BASE,'PATH':record['configuration']['binaries']+':/usr/sbin:/usr/bin:/sbin:/bin'}
def child_command(record,argv,timeout=3):
    result=sandbox.SubprocessCommander(binary=argv[0],extra_environment=child_env(record),capture_limit_bytes=1048576).run(argv[1:],timeout=timeout)
    require(result.ok,'native_command_unknown');return result.stdout.strip()
def cli(record):
    root=Path(record['root']);return sandbox.DockerCli(sandbox.SubprocessCommander(binary=str(Path(record['configuration']['binaries'])/'docker'),extra_environment=child_env(record),
        global_arguments=('--config',str(root/'docker-config'),'--host','unix://'+str(root/'docker.sock'))),default_timeout=2)

def daemon(record):
    root=Path(record['root']);startup=read_record(root/'startup.json');guard(startup,record['instancePath'])
    socket_mount=verify_runtime_socket_mount(record_path=root/'shim-mount-readback.json')
    mount_flags=private_mount_flags(record['unit'],lambda args:child_command(record,args))
    exclusive(root/'unit-mount-flags.json',mount_flags)
    group=Path('/sys/fs/cgroup/system.slice')/record['unit']
    require(Path('/proc/self/cgroup').read_text().strip()=='0::/system.slice/'+record['unit']+'/supervisor','wrong_producer_cgroup')
    require((group/'cgroup.procs').read_text().strip()=='','occupied_delegation')
    controllers={'cpu','memory','pids','io','cpuset'};require(controllers.issubset((group/'cgroup.controllers').read_text().split()),'missing_controller')
    (group/'cgroup.subtree_control').write_text(' '.join('+'+s for s in sorted(controllers)))
    guard(startup,record['instancePath'])
    bins=Path(record['configuration']['binaries']);env=child_env(record)
    containerd=subprocess.Popen([str(bins/'containerd'),'--config',str(root/'config/containerd.toml')],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    # The first producer was within the original nonce. The unchanged unit bounds every child.
    end=time.monotonic()+record['runtimeMaxMs']/1000-2
    while not (root/'containerd.sock').exists():
        require(containerd.poll() is None and time.monotonic()<end,'containerd_not_ready');time.sleep(.025)
    guard(startup,record['instancePath'])
    docker=subprocess.Popen([str(bins/'dockerd'),'--config-file='+str(root/'config/daemon.json')],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    while True:
        require(containerd.poll() is None and docker.poll() is None and time.monotonic()<end,'daemon_not_ready')
        try:info=cli(record).info();break
        except sandbox.ExecutionError:time.sleep(.025)
    require(info['DockerRootDir']==str(root/'docker-data') and info['Containerd']['Address']==str(root/'containerd.sock') and info.get('LiveRestoreEnabled') is False and info.get('LoggingDriver')=='local','private_daemon_changed')
    exclusive(root/'daemon.json',{'ID':info['ID'],'DockerRootDir':info['DockerRootDir'],'Containerd':info['Containerd']})
    exclusive(root/'image-load-reserved.json',{'image':record['configuration']['image']})
    load=cli(record).commander.run(('load','--input',record['configuration']['archive']),timeout=max(.01,end-time.monotonic()))
    require(load.ok,'image_load_unknown');image=record['configuration']['image']
    tag=cli(record).commander.run(('image','tag',image.split('@')[1],record['configuration']['imageTag']),timeout=max(.01,end-time.monotonic()));require(tag.ok,'image_tag_unknown')
    box(record).preflight(image)
    disk=root/'output.ext4';fd=os.open(disk,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:os.ftruncate(fd,64*1024**2);os.fsync(fd)
    finally:os.close(fd)
    fsync_dir(root);child_command(record,['/usr/sbin/mkfs.ext4','-q','-F','-m','0',str(disk)])
    exclusive(root/'loop-reserved.json',{'backing':str(disk),'inode':disk.stat().st_ino})
    loop=child_command(record,['/usr/sbin/losetup','--find','--show',str(disk)]);require(re.fullmatch('/dev/loop[0-9]+',loop),'invalid_loop')
    exclusive(root/'loop.json',{'device':loop,'backing':str(disk),'inode':disk.stat().st_ino})
    child_command(record,['/usr/bin/mount','-t','ext4','-o','nodev,nosuid,noexec',loop,record['output']])
    child_command(record,['/usr/bin/mount','--make-private',record['output']]);output=Path(record['output']);(output/'lost+found').rmdir();os.chown(output,10001,10001);output.chmod(0o700)
    capacity=verify_output_capacity(output,64*1024**2)
    observed=prior.show(record['unit']);group_identity=group.stat().st_ino
    require(re.fullmatch('[a-f0-9]{32}',observed['InvocationID']) and time.monotonic()<end,'native_identity_missing')
    namespaces={n:os.readlink('/proc/self/ns/'+n) for n in ('mnt','net')}
    require(all(v!=os.readlink('/proc/1/ns/'+n) for n,v in namespaces.items()),'private_namespace_missing')
    identity=dict(ID=info['ID'],root=info['DockerRootDir'],containerd=info['Containerd'],binaryHashes=record['configuration']['binaryHashes'])
    shape=dict(socketMount=socket_mount,unit=record['unit'],invocationId=observed['InvocationID'],cgroupInode=group_identity,namespaces=namespaces,capacity=capacity,runtimeMaxMs=record['runtimeMaxMs'])
    exclusive(root/'runtime-ready.json',dict(bootId=actual_clock()[2],invocationId=observed['InvocationID'],cgroupInode=group_identity,
        supervisorPid=os.getpid(),containerdPid=containerd.pid,dockerPid=docker.pid,namespaces=namespaces,
        runtimeIdentityDigest=hash_value(identity),runtimeShapeDigest=hash_value(shape)))
    # PID1 owns the lifetime; no sleep/watchdog may extend it or restart either child.
    docker.wait()

def box(record):
    root=Path(record['root']);facts=read_record(root/'daemon.json')
    return sandbox.CommandSandbox(cli=cli(record),work_root=root/'work',ledger=sandbox.EventLedger(root/'work/events.jsonl'),
        admitted_images=[record['configuration']['image']],expected_daemon_id=facts['ID'],expected_daemon_root=str(root/'docker-data'))

def join_original(record,*,producer):
    root=Path(record['root']);ready=read_record(root/'runtime-ready.json');pid=ready['supervisorPid'];current=prior.show(record['unit'])
    require(current.get('InvocationID')==ready['invocationId'] and current.get('ActiveState')=='active' and int(current.get('MainPID','0'))==pid,'original_native_not_active')
    group=Path('/sys/fs/cgroup/system.slice')/record['unit'];require(group.stat().st_ino==ready['cgroupInode'],'cgroup_replaced')
    for name,flag in (('mnt',0x00020000),('net',0x40000000)):
        require(os.readlink(f'/proc/{pid}/ns/{name}')==ready['namespaces'][name],'namespace_replaced')
        fd=os.open(f'/proc/{pid}/ns/{name}',os.O_RDONLY)
        try:os.setns(fd,flag)
        finally:os.close(fd)
    if producer:(group/'supervisor/cgroup.procs').write_text(str(os.getpid()))

def prepared(record,command):
    root=Path(record['root']);c=parse(Command,command)
    l=c.limits
    limits=sandbox.Limits(cpus=l.nanoCPUs/1000000000,memory_mib=l.memoryMiB,pids=l.pids,nofile=l.nofile,tmp_mib=l.tmpMiB,wall_seconds=l.wallSeconds,output_mib=l.outputMiB,captured_output_kib=l.capturedOutputKiB)
    spec=sandbox.ActionSpec(record['binding']['actionId'],record['binding']['originalEpoch'],c.image,tuple(c.argv),root/'work/input',root/'work/output',limits)
    result=sandbox.prepare_action(spec,work_root=root/'work',control_paths=box(record)._control_paths())
    require(result.manifest.digest==c.inputDigest,'native_input_changed');return result

def execute(record):
    root=Path(record['root']);launch=read_record(root/'launch.json');guard(launch['guard'],record['instancePath'])
    join_original(record,producer=True);guard(launch['guard'],record['instancePath'])
    prepared_action=prepared(record,launch['operation']['command']);engine=box(record)
    # Precursor reserves create and start durably; expiry is checked immediately before each verb.
    original_create=engine.cli.create;original_start=engine.cli.start
    def create(args,**kwargs):
        guard(launch['guard'],record['instancePath']);return original_create(args,timeout=max(.001,(launch['guard']['expiresBoottimeUs']-actual_clock()[1])/1000000))
    def start(name,**kwargs):
        guard(launch['guard'],record['instancePath']);return original_start(name,timeout=max(.001,(launch['guard']['expiresBoottimeUs']-actual_clock()[1])/1000000))
    engine.cli.create=create;engine.cli.start=start
    created=engine.create(prepared_action)
    inspected=engine.cli.inspect(created['container_id'])
    require(inspected is not None and inspected.get('Id')==created['container_id'] and inspected.get('HostConfig',{}).get('LogConfig',{}).get('Config',{}).get('compress')=='false','logging_readback_changed')
    guard(launch['guard'],record['instancePath']);engine.start_once(created)
    exclusive(root/'created.json',created)

def bounded_output(record,output):
    path=Path(record['output']);fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        names=os.listdir(fd);require(names==[output['name']],'unexpected_output')
        file=os.open(output['name'],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            s=os.fstat(file);require(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<=s.st_size<=output['maxBytes']<=1048576,'output_bound')
            data=b''
            while len(data)<s.st_size:
                chunk=os.read(file,min(65536,s.st_size-len(data)));require(chunk,'output_shortened');data+=chunk
            a=os.fstat(file);require(not os.read(file,1) and (a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(s.st_size,s.st_mtime_ns,s.st_ctime_ns),'output_changed')
            data.decode('utf-8','strict');require(b'\x00' not in data,'output_not_text');return data
        finally:os.close(file)
    finally:os.close(fd)

def lookup(record,include_output=False):
    root=Path(record['root']);join_original(record,producer=False);engine=box(record);b=record['binding'];found=engine.recover(b['actionId'],b['originalEpoch'])
    counters=engine.ledger.counters(b['actionId'],b['originalEpoch']);cid=found.get('container_id');phase=found.get('outcome')
    phase=phase if phase in ('running','exited') else 'unknown';ready=read_record(root/'runtime-ready.json')
    value=dict(phase=phase,containerId=cid,startAttempts=min(1,counters.start_attempts),exitCode=found.get('exit_code') if phase=='exited' else None,
        sequence=1,runtimeShapeDigest=ready['runtimeShapeDigest'] if phase in ('running','exited') else None,outputs=[],truncated=False)
    data=None
    if phase=='exited' and include_output:
        op=read_record(root/'launch.json')['operation'];data=bounded_output(record,op['command']['output']);o=op['command']['output']
        value['outputs']=[dict(name=o['name'],mediaType=o['mediaType'],sizeBytes=len(data),sha256=hashlib.sha256(data).hexdigest())]
    print(json.dumps({'observation':value,'data':base64.b64encode(data).decode() if data is not None else None},separators=(',',':')))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=('daemon','execute','lookup','lookup-output'));parser.add_argument('--root',required=True);args=parser.parse_args()
    record=child_record(Path(args.root));prior.ENV=child_env(record);{'daemon':daemon,'execute':execute,'lookup':lookup,'lookup-output':lambda value:lookup(value,True)}[args.mode](record)

if __name__=='__main__':main()
