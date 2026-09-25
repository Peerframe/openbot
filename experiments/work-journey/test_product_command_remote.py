"""SSH is always replaced; these tests do not qualify a remote Host or invoke providers."""
import asyncio
from copy import deepcopy
from dataclasses import replace
import hashlib
import io
import json
import shlex
import sys
import stat
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.rsa import generate_private_key
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, PrivateFormat, NoEncryption

import product_command_remote as remote

ROUTE=dict(nodeId='fixture-node',providerId='linux-command',enforcementKeyId='fixture-enforcer',
    ledgerId='11111111-1111-1111-1111-111111111111')
TIMING=dict(prepareBudgetMs=30000,challengeBudgetMs=5000,runtimeMaxMs=50000,stopAllowanceMs=5000,
    clockRateErrorPpm=1000,clockQuantizationMs=100,policyDigest='e'*64)
BINDING=dict(taskId='task-original',runId='run-original',actionId='action-original',
    preparationId='22222222-2222-2222-2222-222222222222',connectionId='33333333-3333-3333-3333-333333333333',
    originalEpoch=1,authorityGeneration=1,profileDigest='a'*64,intentDigest='b'*64,operationFingerprint='c'*64,**ROUTE)
READY=dict(version=1,event='remote_ready',socketReady=True,nodeSpawned=True,nodeUid=62425,serverAuthenticated=False)
TOKEN='obenr_'+'A'*43


def pem(key=None):
    return (key or Ed25519PrivateKey.generate()).public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo)


def staged(key):
    return dict(version=1,stageReady=True,route=ROUTE,enforcementIssuer='product-enforcer',
        enforcementKeyId=ROUTE['enforcementKeyId'],enforcementPublicPem=key.decode(),
        serverUrl='ws://127.0.0.1:18765/ws/nodes')


def finished():
    prod=dict(containerCount=10,identitiesAndStateUnchanged=True,ipv4Ipv6SemanticsUnchanged=True)
    return dict(version=1,event='remote_finished',productAuthorityLocal=True,workSuccessNotInferred=True,
        runnerSucceeded=True,runnerWithin150s=True,enforcerKeyRemoved=True,socketAbsent=True,actionCount=1,
        binding=deepcopy(BINDING),before=prod.copy(),after=prod.copy(),native=dict(
            unit='openbot-command-'+BINDING['preparationId'].replace('-','')+'.service',invocationId='a'*32,
            result='timeout',originalCgroupEmpty=True,stopObservedWithin5SecondMargin=True,unitReleased=True,
            reservationRetained=True,privateRuntimeAbsent=True,backingAbsent=True))


@pytest.fixture
def options(tmp_path):
    key=tmp_path/'explicit-identity';key.write_text('not-a-real-key')
    hosts=tmp_path/'explicit-known-hosts';hosts.write_text('not-a-real-pin')
    return remote.RemoteOptions('root@synthetic.invalid',key,hosts,18765,True)


def test_exact_commands_no_discovery_or_ambient_forwarding(options,monkeypatch):
    monkeypatch.setenv('SSH_AUTH_SOCK','secret-agent')
    monkeypatch.setenv('OPENBOT_CONTROL_DATABASE_URL','secret-dsn')
    for operation in ('stage','run','check','cleanup'):
        argv=options.argv(operation,local_port=12345)
        assert argv[:8]==['/usr/bin/ssh','-F','none','-S','none','-T','-a','-x']
        assert argv[-2]=='root@synthetic.invalid'
        required=('BatchMode=yes','StrictHostKeyChecking=yes','UpdateHostKeys=no','IdentityAgent=none',
            'IdentitiesOnly=yes','ForwardAgent=no','ForwardX11=no','ControlMaster=no','ControlPersist=no',
            'ProxyCommand=none','ProxyJump=none','ConnectionAttempts=1','ExitOnForwardFailure=yes')
        assert all(value in argv for value in required)
        assert '-f' not in argv and '-N' not in argv and '-A' not in argv and '-X' not in argv
        if operation=='run':
            assert argv.count('-R')==1 and argv[argv.index('-R')+1]=='127.0.0.1:18765:127.0.0.1:12345'
            assert '--signal=TERM --kill-after=5 150s' in argv[-1]
        else:assert '-R' not in argv
    assert set(remote.SSH_ENV)=={'PATH','LANG','LC_ALL'}


@pytest.mark.parametrize('target',['host','-oProxyCommand=evil','root@host;id','root@host\nid','ssh://root@host',
    'root@host extra','root@$(id)','root@host:22','root@/tmp/x','root@@host'])
def test_target_rejects_discovery_shell_and_options(options,target):
    with pytest.raises(ValueError):remote.RemoteOptions(target,options.identity,options.known_hosts,18765,True)


@pytest.mark.parametrize('value',[True,0,22,65536,'18765'])
def test_port_is_explicit_nonprivileged_integer(options,value):
    with pytest.raises(ValueError):remote.RemoteOptions(options.target,options.identity,options.known_hosts,value,True)


def test_approval_and_existing_explicit_files_required(options,tmp_path):
    for approved in (False,1,None):
        with pytest.raises(ValueError):remote.RemoteOptions(options.target,options.identity,options.known_hosts,18765,approved)
    for path in (Path('relative'),tmp_path/'missing',tmp_path):
        with pytest.raises(ValueError):remote.RemoteOptions(options.target,path,options.known_hosts,18765,True)


def test_public_pin_validation():
    key=pem();raw=json.dumps(staged(key)).encode()
    assert remote.staged_pin(raw,ROUTE,18765)==key
    with pytest.raises(ValueError):remote.staged_pin(raw[:-1]+b',"version":1}',ROUTE,18765)
    key_obj=Ed25519PrivateKey.generate()
    invalid=[key_obj.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption()),
        pem(generate_private_key(public_exponent=65537,key_size=2048)),key+b'\n',b'invalid']
    for value in invalid:
        with pytest.raises(ValueError):remote.staged_pin(json.dumps(staged(value)).encode(),ROUTE,18765)


@pytest.mark.parametrize('field,value',[
    ('version',True),('stageReady',1),('enforcementIssuer','other'),('enforcementKeyId','other'),
    ('serverUrl','ws://0.0.0.0:18765/ws/nodes'),('route',{**ROUTE,'nodeId':'other'})])
def test_stage_identity_cannot_change(field,value):
    response=staged(pem());response[field]=value
    with pytest.raises(ValueError):remote.staged_pin(json.dumps(response).encode(),ROUTE,18765)


@pytest.mark.parametrize('field',list(BINDING))
def test_all_remote_binding_fields_match_original_sql(field):
    value=finished()
    original=value['binding'][field]
    value['binding'][field]=(original+1 if isinstance(original,int) else
        '99999999-9999-9999-9999-999999999999' if field in ('preparationId','connectionId','ledgerId') else
        'd'*64 if field in ('profileDigest','intentDigest','operationFingerprint') else 'different')
    with pytest.raises(ValueError):remote.finished_evidence(value,BINDING)


def test_exit_or_cleanup_never_substitutes_for_product_success():
    assert remote.finished_evidence(finished(),BINDING)['workSuccessNotInferred'] is True
    for field in ('productAuthorityLocal','workSuccessNotInferred','runnerSucceeded','runnerWithin150s',
                  'enforcerKeyRemoved','socketAbsent','actionCount'):
        value=finished();value[field]=False
        with pytest.raises(ValueError):remote.finished_evidence(value,BINDING)
    for field in ('originalCgroupEmpty','stopObservedWithin5SecondMargin','unitReleased','reservationRetained',
                  'privateRuntimeAbsent','backingAbsent'):
        value=finished();value['native'][field]=False
        with pytest.raises(ValueError):remote.finished_evidence(value,BINDING)
    for field in ('failure','cleanupFailure','productionFailure','nativeReservationIncomplete'):
        value=finished();value[field]='failed'
        with pytest.raises(ValueError):remote.finished_evidence(value,BINDING)
    for name in ('before','after'):
        value=finished();value[name]['identitiesAndStateUnchanged']=False
        with pytest.raises(ValueError):remote.finished_evidence(value,BINDING)
    for field in ('unit','invocationId'):
        value=finished();value['native'][field]='other'
        with pytest.raises(ValueError):remote.finished_evidence(value,BINDING)


class Input:
    def __init__(self):self.data=b'';self.closed=False
    def write(self,value):self.data+=value
    async def drain(self):pass
    def close(self):self.closed=True


class FakeProcess:
    def __init__(self,stdout=b'',stderr=b'',code=0,*,live=False):
        self.stdin=Input();self.stdout=asyncio.StreamReader();self.stderr=asyncio.StreamReader()
        self.returncode=None;self.pid=123456;self.done=asyncio.Event()
        self.stdout.feed_data(stdout);self.stderr.feed_data(stderr)
        if not live:self.finish(code=code)
    def finish(self,stdout=b'',code=0):
        if stdout:self.stdout.feed_data(stdout)
        self.stdout.feed_eof();self.stderr.feed_eof()
        self.returncode=code;self.done.set()
    async def wait(self):await self.done.wait();return self.returncode


def line(value):return json.dumps(value).encode()+b'\n'


class RemoteProcessTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.path=Path(self.tmp.name)
        key=self.path/'identity';key.write_text('synthetic');known=self.path/'known';known.write_text('synthetic')
        self.options=remote.RemoteOptions('root@synthetic.invalid',key,known,18765,True)
        self.host=remote.RemoteHost(self.options,self.path)
        self.bundle=self.path/'node.cjs';self.bundle.write_bytes(b'// synthetic bundle')

    async def test_complete_boundary_only_public_stage_stdin_enrollment_once(self):
        pin=pem();stage=FakeProcess(line(staged(pin)))
        run=FakeProcess(line(READY),stderr=TOKEN.encode(),live=True)
        check=FakeProcess(line(dict(version=1,singleActionAbsent=True,runnerReserved=True,route=ROUTE)))
        spawn=AsyncMock(side_effect=[stage,run,check])
        with patch.object(remote.asyncio,'create_subprocess_exec',spawn):
            assert await self.host.stage(ROUTE,TIMING,pem(),self.bundle)==pin
            stage_body=json.loads(stage.stdin.data)
            assert set(stage_body)=={'version','route','timing','controlIssuer','controlKid','controlPublicPem',
                'enforcementIssuer','nodeBundleSha256','serverPort'}
            assert stage_body['nodeBundleSha256']==hashlib.sha256(self.bundle.read_bytes()).hexdigest()
            assert 'PRIVATE' not in stage_body['controlPublicPem']
            await self.host.start(TOKEN,12345)
            assert run.stdin.closed and json.loads(run.stdin.data)==dict(version=1,enrollmentToken=TOKEN)
            await self.host.assert_unprepared()
            run.finish(line(finished()))
            assert (await self.host.finish(BINDING))['actionCount']==1
            await self.host.close()
            for operation in ('stage','run','check'):
                with self.assertRaises(FileExistsError):self.host.reserve(operation)
        assert spawn.await_count==3
        for call in spawn.await_args_list:
            assert TOKEN not in repr(call) and call.kwargs['env']==remote.SSH_ENV
        assert TOKEN.encode() not in (self.path/'remote-run.stderr-private').read_bytes()
        assert self.host.enrollment is None

    async def test_stage_failure_never_replayed(self):
        proc=FakeProcess(b'',b'synthetic failure',code=1)
        spawn=AsyncMock(return_value=proc)
        with patch.object(remote.asyncio,'create_subprocess_exec',spawn):
            with self.assertRaisesRegex(ValueError,'stage_failed'):
                await self.host.stage(ROUTE,TIMING,pem(),self.bundle)
            with self.assertRaises(FileExistsError):await self.host.stage(ROUTE,TIMING,pem(),self.bundle)
        assert spawn.await_count==1

    async def test_capture_bound(self):
        proc=FakeProcess(b'x'*(remote.CAPTURE_BYTES+1))
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)):
            with self.assertRaisesRegex(ValueError,'capture_bound'):await self.host.once('stage',b'{}')

    async def test_disconnect_and_malformed_ready_no_resend(self):
        for value in (b'',b'not-json\n',line({**READY,'serverAuthenticated':True}),line(finished())):
            folder=self.path/str(len(list(self.path.iterdir())));folder.mkdir()
            host=remote.RemoteHost(self.options,folder);host.route=ROUTE
            spawn=AsyncMock(return_value=FakeProcess(value))
            with patch.object(remote.asyncio,'create_subprocess_exec',spawn):
                with self.assertRaises(ValueError):await host.start(TOKEN,12345)
                with self.assertRaises(ValueError):await host.close()
                with self.assertRaises(FileExistsError):await host.start(TOKEN,12345)
            assert spawn.await_count==1

    async def test_failed_run_even_with_good_final_evidence_rejected(self):
        self.host.route=ROUTE
        proc=FakeProcess(line(READY)+line(finished()),code=1)
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)):
            await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'remote_run_failed'):await self.host.finish(BINDING)
            with self.assertRaises(ValueError):await self.host.close()

    async def test_no_late_or_additional_output(self):
        self.host.route=ROUTE
        proc=FakeProcess(line(READY)+line(finished())+b'late\n')
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)):
            await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'unexpected_remote_event'):await self.host.finish(BINDING)
            with self.assertRaises(ValueError):await self.host.close()

    async def test_timeout_stops_only_original_local_handle(self):
        self.host.route=ROUTE;proc=FakeProcess(line(READY),live=True)
        async def stop(p):assert p is proc;p.finish(code=-15)
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)) as spawn, \
                patch.object(remote,'RUN_CAPTURE_SECONDS',.02),patch.object(self.host,'stop_process',AsyncMock(side_effect=stop)) as kill:
            await self.host.start(TOKEN,12345)
            with self.assertRaises(asyncio.TimeoutError):await self.host.finish(BINDING)
            with self.assertRaises(asyncio.TimeoutError):await self.host.close()
            assert kill.await_count==1 and spawn.await_count==1

    async def test_preapproval_check_fails_closed_once(self):
        self.host.route=ROUTE
        run=FakeProcess(line(READY),live=True)
        check=FakeProcess(line(dict(version=1,singleActionAbsent=False,runnerReserved=True,route=ROUTE)))
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(side_effect=[run,check])) as spawn:
            await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'action_already_exists'):await self.host.assert_unprepared()
            with self.assertRaises(FileExistsError):await self.host.assert_unprepared()
            run.finish(line(finished()));await self.host.close()
            assert spawn.await_count==2

    async def test_unused_stage_cleanup_after_success_or_lost_ack(self):
        for lost_ack in (False,True):
            folder=self.path/str(lost_ack);folder.mkdir()
            host=remote.RemoteHost(self.options,folder)
            stage=FakeProcess(line(staged(pem())) if not lost_ack else b'',code=0 if not lost_ack else 255)
            cleaned=dict(stageBelongsToThisProbe=True,neverRunObserved=True,enforcerKeyAbsent=True)
            cleanup=FakeProcess(line(cleaned))
            with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(side_effect=[stage,cleanup])) as spawn:
                if lost_ack:
                    with self.assertRaises(ValueError):await host.stage(ROUTE,TIMING,pem(),self.bundle)
                else:await host.stage(ROUTE,TIMING,pem(),self.bundle)
                await host.close()
                assert spawn.await_count==2
                assert shlex.split(spawn.await_args_list[1].args[-1])[-2:]==[
                    remote.CLEAN_UNUSED_STAGE,remote.REMOTE_BASE+'/'+self.options.fixture_name]
                assert json.loads(cleanup.stdin.data)==json.loads(stage.stdin.data)
                assert (folder/'remote-stage.reserved').exists()
                assert json.loads((folder/'remote-unused-stage-cleanup.json').read_text())==cleaned

    async def test_unproven_unused_stage_cleanup_is_uncertain(self):
        for output,code in ((b'',255),(line(dict(stageBelongsToThisProbe=True,neverRunObserved=False,enforcerKeyAbsent=True)),0)):
            folder=self.path/str(len(list(self.path.iterdir())));folder.mkdir()
            host=remote.RemoteHost(self.options,folder)
            with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(side_effect=[
                    FakeProcess(line(staged(pem()))),FakeProcess(output,code=code)])) as spawn:
                await host.stage(ROUTE,TIMING,pem(),self.bundle)
                with self.assertRaises(ValueError):await host.close()
                assert spawn.await_count==2
                assert not (folder/'remote-unused-stage-cleanup.json').exists()
                with self.assertRaises(FileExistsError):await host.close()
                assert spawn.await_count==2

    async def test_consumed_run_attempt_never_uses_unused_key_cleanup(self):
        self.host.route=ROUTE;self.host.public_stage={}
        self.host.reserve('stage');self.host.reserve('run')
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock()) as spawn:
            with self.assertRaisesRegex(ValueError,'cleanup_unobserved'):await self.host.close()
            spawn.assert_not_awaited()

    async def test_actual_local_pipe_eof_keeps_delayed_stderr_and_exit(self):
        # Only the SSH boundary is replaced: a real owned local Python child exercises pipe order.
        self.host.route=ROUTE
        original_spawn=asyncio.create_subprocess_exec
        script=r"""import json,os,sys,time
value=json.load(sys.stdin)
os.close(1)
time.sleep(0.03)
sys.stderr.write('Traceback (synthetic local fixture):\nRuntimeError: before run reservation '+value['enrollmentToken']+'\n')
sys.stderr.flush()
raise SystemExit(7)
"""
        children=[]
        async def local_child(*argv,**kwargs):
            assert argv[0]=='/usr/bin/ssh' and argv[-1].endswith(' run')
            child=await original_spawn(sys.executable,'-c',script,**kwargs)
            children.append(child);return child
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(side_effect=local_child)) as spawn:
            with self.assertRaisesRegex(ValueError,'remote_event_missing_or_oversized'):
                await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'remote_event_missing_or_oversized'):
                await self.host.close()
        assert len(children)==spawn.await_count==1 and children[0].returncode==7
        stderr=(self.path/'remote-run.stderr-private').read_bytes()
        assert b'Traceback (synthetic local fixture)' in stderr and b'before run reservation' in stderr
        assert TOKEN.encode() not in stderr and b'[redacted-enrollment]' in stderr
        assert (self.path/'remote-run.stdout-private').read_bytes()==b''
        facts=json.loads((self.path/'remote-run.capture-private.json').read_text())
        assert facts['exitCode']==facts['exitCodeBeforeLocalStop']==7
        assert facts['complete']['stderr'] is True and facts['localStopRequested'] is False
        assert facts['captureTimedOut'] is False and facts['captureSecondsLimit']==170
        for name in ('stdout-private','stderr-private','capture-private.json'):
            assert stat.S_IMODE((self.path/('remote-run.'+name)).stat().st_mode)==0o600

    async def test_early_finished_keeps_raw_private_result_and_traceback(self):
        self.host.route=ROUTE
        early={**finished(),'failure':'synthetic pre-ready failure '+TOKEN}
        proc=FakeProcess(line(early),b'Traceback: synthetic pre-ready failure\n',code=1)
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)) as spawn:
            with self.assertRaisesRegex(ValueError,'remote_event_order_changed'):
                await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'remote_event_order_changed'):await self.host.close()
        assert spawn.await_count==1 and self.host.result is None
        out=(self.path/'remote-run.stdout-private').read_bytes()
        assert b'remote_finished' in out and b'synthetic pre-ready failure' in out and TOKEN.encode() not in out
        assert (self.path/'remote-run.stderr-private').read_bytes()==b'Traceback: synthetic pre-ready failure\n'
        assert json.loads((self.path/'remote-run.capture-private.json').read_text())['exitCode']==1

    async def test_oversized_stderr_retains_bounded_redacted_prefix(self):
        self.host.route=ROUTE
        prefix=b'Traceback\n'+b'x'*(remote.CAPTURE_BYTES-25)
        proc=FakeProcess(line(READY)+line(finished()),prefix+TOKEN.encode()+b'overflow',code=1)
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)) as spawn:
            await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'remote_capture_bound'):await self.host.finish(BINDING)
            with self.assertRaisesRegex(ValueError,'remote_capture_bound'):await self.host.close()
        stderr=(self.path/'remote-run.stderr-private').read_bytes()
        assert len(stderr)<=remote.CAPTURE_BYTES and stderr.startswith(b'Traceback')
        assert b'obenr_' not in stderr and TOKEN.encode() not in stderr
        facts=json.loads((self.path/'remote-run.capture-private.json').read_text())
        assert facts['truncated']['stderr'] is True and facts['complete']['stderr'] is False
        assert facts['capturedBytes']['stderr']==remote.CAPTURE_BYTES and facts['exitCode']==1
        assert spawn.await_count==1

    async def test_stderr_timeout_preserves_original_stdout_error_and_partial_diagnostic(self):
        self.host.route=ROUTE
        proc=FakeProcess(stderr=b'Traceback: partial '+TOKEN.encode(),live=True)
        proc.stdout.feed_eof()
        async def stop(p):assert p is proc;p.finish(code=-15)
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)) as spawn, \
                patch.object(remote,'RUN_CAPTURE_SECONDS',.02),patch.object(self.host,'stop_process',AsyncMock(side_effect=stop)) as kill:
            with self.assertRaisesRegex(ValueError,'remote_event_missing_or_oversized'):
                await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'remote_event_missing_or_oversized'):
                await self.host.close()
        stderr=(self.path/'remote-run.stderr-private').read_bytes()
        assert b'Traceback: partial' in stderr and TOKEN.encode() not in stderr
        facts=json.loads((self.path/'remote-run.capture-private.json').read_text())
        assert facts['captureTimedOut'] is True and facts['complete']['stderr'] is False
        assert facts['exitCode']==-15 and facts['exitCodeBeforeLocalStop'] is None and facts['localStopRequested'] is True
        assert spawn.await_count==1 and kill.await_count==1

    async def test_exit_already_observed_stderr_timeout_does_not_claim_natural_complete(self):
        self.host.route=ROUTE
        proc=FakeProcess(stderr=b'late stderr writer',live=True)
        proc.stdout.feed_eof();proc.returncode=255;proc.done.set()
        with patch.object(remote.asyncio,'create_subprocess_exec',AsyncMock(return_value=proc)), \
                patch.object(remote,'RUN_CAPTURE_SECONDS',.02):
            with self.assertRaisesRegex(ValueError,'remote_event_missing_or_oversized'):
                await self.host.start(TOKEN,12345)
            with self.assertRaisesRegex(ValueError,'remote_event_missing_or_oversized'):await self.host.close()
        facts=json.loads((self.path/'remote-run.capture-private.json').read_text())
        assert facts['exitCode']==255 and facts['localStopRequested'] is False and facts['captureTimedOut'] is True
        assert (self.path/'remote-run.stderr-private').read_bytes()==b'late stderr writer'


def test_unused_stage_script_is_narrow_and_retains_reservations():
    import ast
    tree=ast.parse(remote.CLEAN_UNUSED_STAGE)
    unlink=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='unlink']
    assert len(unlink)==1 and ast.literal_eval(unlink[0].args[0])=='enforcer.pem'
    assert remote.CLEAN_UNUSED_STAGE.count("absent('run-reserved.json') and absent('single-action.json')")==2
    assert "read_at(root,'stage-reserved.json')" in remote.CLEAN_UNUSED_STAGE
    assert "read_at(secrets,'control.pub')" in remote.CLEAN_UNUSED_STAGE
    assert 'subprocess' not in remote.CLEAN_UNUSED_STAGE and 'systemctl' not in remote.CLEAN_UNUSED_STAGE


class ProbeCompositionTests(IsolatedAsyncioTestCase):
    """Run the unchanged journey through fake API/SQL/Temporal seams: ordering only, not integration."""
    def setUp(self):
        import product_command_probe as probe
        self.probe=probe
        self.tmp=TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name)
        self.bundle=self.base/'node.cjs';self.bundle.write_text('// synthetic')
        self.trace=[];self.directory=self.base/'fresh'
        self.fail=None;self.key=pem();self.api=None;self.remote=None;self.local=False;self.local_host=None
        owner=self
        class Database:
            dsn='synthetic-local-only'
            def __init__(self,*args):pass
            def start(self):owner.trace.append('pg-start')
            def migrate(self,*args):owner.trace.append('migrate')
            def close(self):owner.trace.append('pg-close')
        class Engine:
            address='synthetic-loopback';client_settings={'synthetic-local-tls':True}
            def __init__(self,*a,**k):pass
            def start(self):owner.trace.append('engine-start')
            async def connect(self):return self
            def close(self):owner.trace.append('engine-close')
            def get_workflow_handle(self,identity):assert identity=='openbot-work-v1-run-original';return self
            async def result(self):return {'status':'completed'}
            async def fetch_history(self):return self
            def to_json(self):return '{"synthetic":true}'
        class Process:
            def __init__(self,command,directory,env):
                owner.trace.append('serve-start')
                if not owner.local:assert owner.directory.joinpath('enforcer.pub').read_bytes()==owner.key
                config=json.loads(owner.directory.joinpath('command.json').read_text())
                assert config['enforcement']['publicKeyPath']==str(owner.directory/'enforcer.pub')
                if owner.fail=='serve':raise RuntimeError('synthetic Serve failure')
            def alive(self):pass
        class Response(io.BytesIO):
            status=201
        class Opener:
            def open(self,request,timeout):
                assert request.data==probe.CSV
                return Response(b'{"attachment":{"id":"attachment-original"}}')
        class API:
            url='http://127.0.0.1:12345';password='local-owner';opener=Opener()
            def __init__(self,directory,dsn,artifacts):
                owner.api=self;self.directory=directory/'api';self.env={};self.approved=False;self.child=None
                self.route=json.loads((directory/'command.json').read_text())['route']
            def call(self,path,body=None,expected=200,raw=False):
                if path=='/health':return dict(ok=True)
                if path=='/api/v1/auth/login':return dict(ok=True)
                if path=='/api/v1/model-connections':return dict(connection={'id':'connection'})
                if path=='/api/v1/bots':
                    assert body['computerProfile']=='docker-linux'
                    return dict(bot={'id':'bot-original'})
                if path=='/api/v1/channels':return dict(channel={'id':'channel'})
                if path=='/api/v1/channels/channel/messages':return dict(run={'id':'source-original'})
                if path=='/api/v1/nodes/enrollment-tokens':return {'token':TOKEN}
                if path=='/api/v1/nodes':return {'nodes':[{'id':self.route['nodeId']}]}
                if path=='/api/v1/node-identities':return {'identities':[
                    {'nodeId':'unrelated-node','status':'active'},{'nodeId':self.route['nodeId'],'status':'active'}]}
                if path==f'/api/v1/nodes/{self.route["nodeId"]}/revoke':
                    owner.trace.append('revoke-own');assert expected==204
                    if owner.fail=='revoke':raise RuntimeError('synthetic revoke error')
                    return None
                if path=='/api/v1/actions/action-original/decision':
                    assert owner.trace[-1]==('local-start' if owner.local else 'remote-check');assert body['approved'] is True
                    owner.trace.append('approve');self.approved=True;return dict(ok=True)
                if path=='/download/result':return probe.CSV
                if path=='/download/report':return probe.REPORT.encode()
                raise AssertionError(path)
            def snapshot(self,task):
                assert task=='task-original'
                action=dict(id='action-original',status='proposed',decision='pending',intentDigest='b'*64,
                    intent=dict(tool='run_command',arguments=probe.ARGUMENTS))
                if not self.approved:return dict(status='running',actions=[action])
                if owner.fail=='product':raise RuntimeError('synthetic product failure')
                if owner.local:owner.local_host.calls[:]=['reserve','execute']
                counts=dict(command=1,report=1,final=1,review=1)
                (owner.directory/'provider/provider-count.json').write_text(json.dumps(counts))
                return dict(status='completed',actions=[action],resultSummary=probe.SUMMARY,artifacts=[
                    dict(name='result.csv',downloadUrl='/download/result'),dict(name='command-report.md',downloadUrl='/download/report')])
            def close(self):owner.trace.append('api-close')
        class Remote:
            def __init__(self,options,directory):owner.remote=self
            async def stage(self,route,timing,control,bundle):
                owner.trace.append('stage');self.route=route
                assert 'PRIVATE' not in control.decode() and timing==TIMING and bundle==owner.bundle
                return owner.key
            async def start(self,token,port):
                owner.trace.append('remote-start');assert token==TOKEN and port==12345
            async def assert_unprepared(self):
                owner.trace.append('remote-check')
                if owner.fail=='check':raise RuntimeError('synthetic preapproval rejection')
            async def finish(self,binding):
                owner.trace.append('remote-finish');assert binding==dict(BINDING,**self.route)
                return {'synthetic':True}
            async def close(self):owner.trace.append('remote-close')
        class SQL:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def execute(self,sql,params):self.sql=sql;self.params=params;return self
            def fetchone(self):
                if 'work_sources' in self.sql:return ('task-original','run-original')
                if self.sql.startswith('SELECT count'):return (1,)
                if 'SELECT status' in self.sql:return ('applied',)
                raise AssertionError(self.sql)
            def fetchall(self):return [(dict(BINDING,**owner.remote.route),)]
        class Replayer:
            def __init__(self,**kwargs):assert kwargs['workflows']==[probe.OpenBotWork]
            async def replay_workflow(self,history):owner.trace.append('replay')
        replacements={'ControlDatabase':Database,'PostgresServer':Engine,'Process':Process,'API':API,
            'RemoteHost':Remote,'Replayer':Replayer,'emit':lambda **kwargs:None}
        for name,value in replacements.items():
            patcher=patch.object(probe,name,value);patcher.start();self.addCleanup(patcher.stop)
        patcher=patch.object(probe.psycopg,'connect',lambda *a,**k:SQL());patcher.start();self.addCleanup(patcher.stop)
        # A surprise subprocess invocation is a test failure, not a fallback to real SSH/Docker.
        for name in ('Popen','run'):
            patcher=patch.object(probe.subprocess,name,side_effect=AssertionError('No real subprocess allowed'))
            patcher.start();self.addCleanup(patcher.stop)

    async def test_original_journey_order_and_final_revoke(self):
        await self.probe.qualify(self.directory,self.bundle,object())
        assert self.trace.index('stage')<self.trace.index('serve-start')<self.trace.index('remote-start')
        assert self.trace.index('remote-check')<self.trace.index('approve')<self.trace.index('replay')<self.trace.index('remote-finish')
        assert self.trace.index('remote-close')<self.trace.index('revoke-own')<self.trace.index('api-close')
        assert self.trace[-2:]==['engine-close','pg-close']
        assert not (self.directory/'control.pem').exists()
        assert json.loads((self.directory/'result.json').read_text())['case']=='product-command-remote-composition'

    async def test_default_local_branch_still_uses_one_original_synthetic_host(self):
        self.local=True;owner=self
        class Host:
            def __init__(self,*args):
                self.socket=owner.base/'synthetic.sock';self.calls=[];owner.local_host=self
                owner.trace.append('local-start')
            def close(self):owner.trace.append('local-close')
        class Node:
            def __init__(self):self.stdin=Input()
            def poll(self):return 0
        node=Node()
        with patch.object(self.probe,'LocalHost',Host),patch.object(self.probe.subprocess,'Popen',return_value=node) as spawn:
            await self.probe.qualify(self.directory,self.bundle)
            spawn.assert_called_once()
        assert not any(value.startswith('remote-') or value=='stage' for value in self.trace)
        assert json.loads(node.stdin.data)['enrollmentToken']==TOKEN and node.stdin.closed
        assert self.local_host.calls==['reserve','execute']
        assert 'revoke-own' in self.trace and 'local-close' in self.trace
        record=json.loads((self.directory/'result.json').read_text())
        assert record['case']=='product-command-local-composition' and record['syntheticNative'] is True
        assert record['linuxIsolationQualified'] is False and not (self.directory/'control.pem').exists()

    async def test_rejected_preapproval_never_approves_and_cleans_all(self):
        self.fail='check'
        with self.assertRaisesRegex(RuntimeError,'preapproval'):await self.probe.qualify(self.directory,self.bundle,object())
        assert 'approve' not in self.trace and 'revoke-own' in self.trace
        assert not (self.directory/'control.pem').exists() and not (self.directory/'result.json').exists()
        assert self.trace[-3:]==['api-close','engine-close','pg-close']

    async def test_serve_failure_closes_unused_stage_before_local_secrets(self):
        self.fail='serve'
        with self.assertRaisesRegex(RuntimeError,'Serve'):await self.probe.qualify(self.directory,self.bundle,object())
        assert 'remote-close' in self.trace and 'remote-start' not in self.trace and 'approve' not in self.trace
        assert not (self.directory/'control.pem').exists()
        assert self.trace[-3:]==['api-close','engine-close','pg-close']

    async def test_revoke_failure_does_not_skip_api_engine_pg_or_key_cleanup(self):
        self.fail='revoke'
        with self.assertRaisesRegex(AssertionError,'node-revocation'):await self.probe.qualify(self.directory,self.bundle,object())
        assert self.trace[-3:]==['api-close','engine-close','pg-close']
        assert not (self.directory/'control.pem').exists()


def test_cli_default_local_unchanged_and_remote_requires_complete_explicit_choice(tmp_path):
    import product_command_probe as probe
    common=['--output',str(tmp_path/'fresh'),'--node-bundle',str(tmp_path/'node.cjs')]
    values,option=probe.arguments(common)
    assert option is None and values.output==tmp_path/'fresh'
    with pytest.raises(SystemExit):probe.arguments(common+['--remote-ssh-target','root@synthetic.invalid'])
    with pytest.raises(SystemExit):probe.arguments(common+['--remote-upload-authorized'])
    with pytest.raises(SystemExit):probe.arguments(common+['--remote-fixture-name','product2'])
    key=tmp_path/'identity';key.write_text('synthetic');hosts=tmp_path/'known';hosts.write_text('synthetic')
    args=common+['--remote-ssh-target','root@synthetic.invalid','--remote-ssh-identity',str(key),
        '--remote-known-hosts',str(hosts),'--remote-server-port','18765']
    with pytest.raises(SystemExit):probe.arguments(args)
    with pytest.raises(SystemExit):probe.arguments(args+['--remote-upload-authorized'])
    with pytest.raises(SystemExit):probe.arguments(args+['--remote-fixture-name','product2'])
    with pytest.raises(SystemExit):probe.arguments(args+['--remote-upload-authorized','--remote-fixture-name','../product2'])
    _,option=probe.arguments(args+['--remote-upload-authorized','--remote-fixture-name','product2'])
    assert option.server_port==18765 and option.fixture_name=='product2'


@pytest.mark.parametrize('name',['product1','product9','product10','product99','product100','product999'])
def test_all_operations_use_only_the_same_explicit_fixture(options,name):
    selected=replace(options,fixture_name=name)
    root=remote.REMOTE_BASE+'/'+name
    for operation in ('stage','run','check','cleanup'):
        argv=selected.argv(operation,local_port=12345)
        command=shlex.split(argv[-1])
        if operation in ('stage','run'):
            assert command[-2:]==[root+'/product_host_fixture.py',operation]
        else:
            script=remote.READ_ONLY_CHECK if operation=='check' else remote.CLEAN_UNUSED_STAGE
            assert command==['exec','/usr/bin/python3','-c',script,root]
            assert 'p=Path(sys.argv[1])' in script and '/product1' not in script
        assert argv[-1].count(root)==1
    # The old programmatic constructor remains compatible; CLI explicitness is checked separately.
    assert options.fixture_name=='product1'


@pytest.mark.parametrize('name',['','product0','product01','product1000','product-1','product١','product１',
    'Product2','product2\n','../product2','product2/../product1','/opt/openbot-command-0925/product2',
    'product2;id','product2$(id)','product2\x00',True,None,2])
def test_fixture_name_rejects_paths_aliases_unicode_and_shell(options,name):
    with pytest.raises(ValueError,match='invalid_explicit_fixture_name'):replace(options,fixture_name=name)
