"""Disposable CI adapter to the unchanged protected Host; no SSH or Host discovery."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import sys

BASE=Path('/opt/obp4')
PROGRAM=BASE/'command/product_host_fixture.py'
MAXIMUM=96*1024


def require(value,code):
    if not value:raise ValueError(code)


FAILURE_CODES=frozenset(('unsafe_path','unsafe_directory','unsafe_file','oversized_file','changed_file',
    'fixture_uid_occupied','fixture_socket_occupied','public_directory_occupied','node_binary_changed',
    'node_bundle_changed','linux_root_required','invalid_native_config','missing_native_pin',
    'unreviewed_image','binary_changed','source_changed','archive_changed','invalid_python',
    'image_tag_changed','systemd_version_changed','native_command_unknown','native_packet_changed'))
FAILURE_TYPES=frozenset(('FileNotFoundError','PermissionError','FileExistsError','NotADirectoryError',
    'IsADirectoryError','BlockingIOError','TimeoutError','OSError','ValueError','TypeError','RuntimeError',
    'KeyError','ModuleNotFoundError','ImportError','Refused','ValidationError'))


def failure_record(error):
    # Only fixed error codes/types and locations in the verified public packet. No values/locals,
    # formatted tracebacks, enrollment, keys or stderr enter the hosted diagnostic.
    kind=type(error).__name__;code=str(error)
    record={'errorType':kind if kind in FAILURE_TYPES else 'Exception',
        'code':code if code in FAILURE_CODES else 'fixture_failed','locations':[]}
    trace=error.__traceback__
    while trace:
        source=Path(trace.tb_frame.f_code.co_filename)
        if source.is_relative_to(BASE) and source.suffix=='.py':
            relative=str(source.relative_to(BASE));function=trace.tb_frame.f_code.co_name
            if re.fullmatch(r'[A-Za-z0-9_./-]{1,180}',relative) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',function):
                record['locations'].append(dict(file=relative,function=function,line=trace.tb_lineno))
        trace=trace.tb_next
    record['locations']=record['locations'][-4:]
    return record


class NativeHost:
    def __init__(self,configuration,directory):
        value=json.loads(Path(configuration).read_text())
        require(type(value) is dict and type(value.get('version')) is int and value=={'version':1,'program':str(PROGRAM)},'explicit_native_ci_configuration_required')
        require(sys.platform=='linux','linux_required')
        self.directory=directory;self.process=self.monitor=self.relay=None;self.port=None;self.route=None

    async def spawn(self,operation,payload):
        require(operation in ('stage','run','check','cleanup'),'invalid_native_ci_operation')
        child=await asyncio.create_subprocess_exec('/usr/bin/sudo','-n','/usr/bin/python3','-B',str(PROGRAM),operation,
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,limit=MAXIMUM)
        child.stdin.write(json.dumps(payload).encode());await child.stdin.drain();child.stdin.close()
        return child

    async def once(self,operation,payload):
        child=await self.spawn(operation,payload)
        try:
            stdout,stderr=await asyncio.wait_for(child.communicate(),30)
            require(len(stdout)<=MAXIMUM and len(stderr)<=MAXIMUM,'native_capture_bound')
            (self.directory/('native-'+operation+'.stderr-private')).write_bytes(stderr)
            if child.returncode!=0:
                try:diagnostic=json.loads(stdout)
                except (ValueError,UnicodeError):diagnostic=None
                if type(diagnostic) is dict and set(diagnostic)=={'nativeFixtureFailure'}:
                    # This subprocess is the fixed root-owned, hash-verified public CI packet.
                    (self.directory/('native-'+operation+'.failure.json')).write_text(json.dumps(diagnostic)+'\n')
                    print(json.dumps(diagnostic),flush=True)
            require(child.returncode==0,'native_'+operation+'_failed')
            return json.loads(stdout)
        finally:
            if child.returncode is None:child.kill();await child.wait()

    async def stage(self,route,timing,control_public,bundle):
        from product_command_remote import staged_pin
        self.route=route
        async def forward(reader,writer):
            remote_writer=None
            try:
                require(self.port is not None,'native_forward_not_ready')
                remote_reader,remote_writer=await asyncio.open_connection('127.0.0.1',self.port)
                async def copy(source,target):
                    while chunk:=await source.read(65536):target.write(chunk);await target.drain()
                    target.close()
                await asyncio.gather(copy(reader,remote_writer),copy(remote_reader,writer))
            finally:
                writer.close()
                if remote_writer:remote_writer.close()
        self.relay=await asyncio.start_server(forward,'127.0.0.1',0)
        port=self.relay.sockets[0].getsockname()[1]
        value=dict(version=1,route=route,timing=timing,controlIssuer='product-control',controlKid='product-control-key',
            controlPublicPem=control_public.decode('ascii'),enforcementIssuer='product-enforcer',
            nodeBundleSha256=hashlib.sha256(bundle.read_bytes()).hexdigest(),serverPort=port)
        return staged_pin(json.dumps(await self.once('stage',value)).encode(),route,port)

    async def start(self,enrollment,local_port):
        require(re.fullmatch(r'obenr_[A-Za-z0-9_-]{43}',enrollment) is not None,'one_time_enrollment_required')
        self.port=local_port
        self.process=await self.spawn('run',dict(version=1,enrollmentToken=enrollment))
        async def stderr():
            data=await self.process.stderr.read(MAXIMUM+1)
            require(len(data)<=MAXIMUM,'native_capture_bound')
            data=re.sub(rb'obenr_[A-Za-z0-9_-]{0,43}',b'[redacted-enrollment]',data)
            (self.directory/'native-run.stderr-private').write_bytes(data)
        error_task=asyncio.create_task(stderr())
        try:
            ready=json.loads(await asyncio.wait_for(self.process.stdout.readline(),20))
            if type(ready) is dict and set(ready)=={'nativeFixtureFailure'}:
                (self.directory/'native-run.failure.json').write_text(json.dumps(ready)+'\n')
                print(json.dumps(ready),flush=True)
            require(ready==dict(version=1,event='remote_ready',socketReady=True,nodeSpawned=True,nodeUid=62425,serverAuthenticated=False),'native_ready_changed')
        except BaseException:
            await asyncio.wait_for(self.process.wait(),150);await error_task
            raise
        async def collect():
            try:
                raw=await asyncio.wait_for(self.process.stdout.read(MAXIMUM+1),150)
                require(len(raw)<=MAXIMUM,'native_capture_bound')
                await asyncio.wait_for(self.process.wait(),5);await error_task
                value=json.loads(raw)
                (self.directory/'native-run.result-private.json').write_text(json.dumps(value))
                if self.process.returncode!=0:print(json.dumps({'nativeCommandFailure':{k:value.get(k) for k in ('failure','cleanupFailure','productionFailure','runnerSucceeded','actionCount','nativeReservationIncomplete')}}),flush=True)
                require(self.process.returncode==0,'native_run_failed')
                return value
            finally:
                if self.process.returncode is None:self.process.kill();await self.process.wait()
                await error_task
        self.monitor=asyncio.create_task(collect())

    async def assert_unprepared(self):
        require(self.monitor is not None and not self.monitor.done(),'original_native_run_required')
        value=await self.once('check',{})
        require(value==dict(version=1,singleActionAbsent=True,runnerReserved=True,route=self.route),'native_action_already_reserved')

    async def finish(self,binding):
        from product_command_remote import finished_evidence
        value=await asyncio.shield(self.monitor)
        # Reuse binding, lifetime and cleanup validation; this runner has a dynamic owned baseline.
        before=value['before'];after=value['after']
        require(before==after and type(before['containerCount']) is int and before['containerCount']>=0
            and before['identitiesAndStateUnchanged'] is True and before['ipv4Ipv6SemanticsUnchanged'] is True,'native_host_state_changed')
        finished_evidence(value,binding,container_count=before['containerCount'])
        return {**value,'fixtureEnvironment':'disposable-github-linux','actualNativeHost':True,'actualPeerUid':62425}

    async def close(self):
        try:
            if self.monitor:await asyncio.shield(self.monitor)
            elif self.process is None and self.route is not None:await self.once('cleanup',{})
            elif self.process is not None:
                if self.process.returncode is None:await asyncio.wait_for(self.process.wait(),150)
                raise ValueError('native_original_cleanup_unconfirmed')
        finally:
            if self.relay:self.relay.close();await self.relay.wait_closed()


def root_mode(operation):
    """Root-private launcher, copied by p4_native_ci.py only onto a disposable Linux runner."""
    import importlib.util
    require(sys.platform=='linux' and os.geteuid()==0 and Path(__file__).resolve()==PROGRAM,'root_ci_packet_required')
    plan=json.loads((BASE/'PLAN.json').read_text())
    for entry in plan['commandFiles']:
        p=Path(entry['path']);s=p.lstat()
        require(p.is_file() and not p.is_symlink() and s.st_uid==0 and not s.st_mode&0o022
            and hashlib.sha256(p.read_bytes()).hexdigest()==entry['sha256'],'native_packet_changed')
    sys.path[:0]=plan['pythonPath']
    spec=importlib.util.spec_from_file_location('fixture_original',BASE/'case/source/product_host_fixture.py')
    fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
    fixture.BASE=BASE;fixture.ROOT=PROGRAM.parent;fixture.CASE=BASE/'case'
    fixture.NODE=Path('/opt/oc25n/node');fixture.PUBLIC=Path('/opt/oc25p');fixture.SOCKET=Path('/run/oc25/command.sock')
    import run_probe as observer
    observer.ROOT=BASE/'command';observer.DOCKER=str(BASE/'bin/docker')
    from protected_io import read_record,exclusive
    def host_state():
        actual=observer.snapshot();baseline=BASE/'command/host-baseline.json'
        if not baseline.exists():exclusive(baseline,actual)
        require(read_record(baseline)==actual,'native_host_state_changed')
        return dict(containerCount=len(actual['containers']),identitiesAndStateUnchanged=True,ipv4Ipv6SemanticsUnchanged=True)
    fixture.production=host_state
    if operation=='stage':fixture.stage()
    elif operation=='host':fixture.host()
    elif operation=='run':raise SystemExit(fixture.run())
    elif operation=='cleanup':
        fixture.require_unreserved();fixture.cleanup_prerun_key(read_record(fixture.ROOT/'stage-reserved.json'))
        print(json.dumps({'unusedStageKeyRemoved':True}))
    elif operation=='check':
        require(not (fixture.ROOT/'single-action.json').exists(),'action_already_reserved')
        require(read_record(fixture.ROOT/'run-reserved.json')['maximumMs']==150000,'runner_reservation_changed')
        print(json.dumps(dict(version=1,singleActionAbsent=True,runnerReserved=True,route=read_record(fixture.ROOT/'public.json')['route'])))
    else:raise ValueError('invalid_native_ci_operation')


if __name__=='__main__':
    os.umask(0o077)
    require(len(sys.argv)==2,'invalid_native_ci_operation')
    try:root_mode(sys.argv[1])
    except Exception as error:
        print(json.dumps({'nativeFixtureFailure':failure_record(error)}),flush=True)
        raise SystemExit(1) from None
