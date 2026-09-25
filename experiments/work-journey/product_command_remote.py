"""Explicit, one-shot SSH boundary for the existing qualification; never uploads or retries."""
import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key, Encoding, PublicFormat
from openbot_server.work_command_contract import CommandRoute, parse, strict_json
from openbot_server.work_command_v2_contract import PreparationBinding, TimingPolicy

REMOTE_BASE = '/opt/openbot-command-0925'
CAPTURE_BYTES = 32768
# These are capture allowances, not an extension to the remote native/runner deadlines.
RUN_CAPTURE_SECONDS = 170
SSH_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
READ_ONLY_CHECK = '''import json,os,stat,sys
from pathlib import Path
p=Path(sys.argv[1])
s=p.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o077
for name in ('public.json','run-reserved.json'):
 s=(p/name).lstat();assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o077 and s.st_size<=16384
v=json.loads((p/'public.json').read_bytes());r=json.loads((p/'run-reserved.json').read_bytes())
assert r['maximumMs']==150000
try:(p/'single-action.json').lstat()
except FileNotFoundError:pass
else:raise RuntimeError('action_already_reserved')
print(json.dumps({'version':1,'singleActionAbsent':True,'runnerReserved':True,'route':v['route']}))
'''

# This operator cleanup has no unit/container calls and never clears any reservation.
CLEAN_UNUSED_STAGE = r'''import json,os,stat,sys
from pathlib import Path
raw=sys.stdin.buffer.read(16385);assert 0<len(raw)<=16384
expected=json.loads(raw);assert type(expected) is dict
p=Path(sys.argv[1])
for a in [*reversed(p.parents),p]:
 s=a.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022
root=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
assert not os.fstat(root).st_mode&0o077
def absent(name):
 try:os.stat(name,dir_fd=root,follow_symlinks=False)
 except FileNotFoundError:return True
 return False
def read_at(fd,name):
 f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
 try:
  s=os.fstat(f);assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o077 and s.st_size<=16384 and s.st_nlink==1
  data=os.read(f,16385);assert len(data)<=16384;return data
 finally:os.close(f)
assert json.loads(read_at(root,'stage-reserved.json'))=={'version':1,'route':expected['route']}
assert absent('run-reserved.json') and absent('single-action.json')
secrets=os.open('secrets',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
s=os.fstat(secrets);assert s.st_uid==0 and not s.st_mode&0o077
assert read_at(secrets,'control.pub')==expected['controlPublicPem'].encode()
# Public stage record is written after both key files; a partial stage cannot recreate a deleted key.
assert json.loads(read_at(root,'public.json'))==expected
try:
 key=os.stat('enforcer.pem',dir_fd=secrets,follow_symlinks=False)
except FileNotFoundError:pass
else:
 assert stat.S_ISREG(key.st_mode) and key.st_uid==0 and not key.st_mode&0o077 and key.st_nlink==1 and key.st_size<=4096
 assert absent('run-reserved.json') and absent('single-action.json')
 os.unlink('enforcer.pem',dir_fd=secrets);os.fsync(secrets)
try:os.stat('enforcer.pem',dir_fd=secrets,follow_symlinks=False)
except FileNotFoundError:pass
else:raise RuntimeError('unused_key_still_present')
os.close(secrets);os.close(root)
print(json.dumps({'stageBelongsToThisProbe':True,'neverRunObserved':True,'enforcerKeyAbsent':True}))
'''


def require(value, code):
    if not value:
        raise ValueError(code)


def port(value):
    require(type(value) is int and 1024 <= value <= 65535, 'invalid_explicit_loopback_port')
    return value


@dataclass(frozen=True)
class RemoteOptions:
    target: str
    identity: Path
    known_hosts: Path
    server_port: int
    upload_authorized: bool
    fixture_name: str = 'product1'

    def __post_init__(self):
        # No SSH aliases/config discovery, option injection, URI, shell or implicit user.
        require(type(self.target) is str and re.fullmatch(
            r'[A-Za-z_][A-Za-z0-9_-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}', self.target),
            'explicit_ssh_user_and_host_required')
        port(self.server_port)
        require(type(self.fixture_name) is str and re.fullmatch(r'product[1-9][0-9]{0,2}', self.fixture_name),
                'invalid_explicit_fixture_name')
        require(self.upload_authorized is True, 'fresh_upload_authorization_required')
        for value in (self.identity, self.known_hosts):
            require(isinstance(value, Path) and value.is_absolute() and value.is_file()
                    and not any(c in str(value) for c in ('\n', '\r', '\0', '%', '$', '~', '"')),
                    'explicit_ssh_file_required')

    def argv(self, operation, *, local_port=None):
        require(operation in ('stage', 'run', 'check', 'cleanup'), 'invalid_remote_operation')
        root = REMOTE_BASE + '/' + self.fixture_name
        program = root + '/product_host_fixture.py'
        options = ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
            'GlobalKnownHostsFile=/dev/null', 'UserKnownHostsFile="' + str(self.known_hosts) + '"',
            'IdentityAgent=none', 'IdentitiesOnly=yes', 'CertificateFile=none',
            'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'GSSAPIAuthentication=no',
            'PreferredAuthentications=publickey', 'NoHostAuthenticationForLocalhost=no',
            'ForwardAgent=no', 'ForwardX11=no', 'ControlMaster=no', 'ControlPersist=no',
            'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no',
            'ConnectionAttempts=1', 'ConnectTimeout=15', 'ServerAliveInterval=10',
            'ServerAliveCountMax=3', 'ExitOnForwardFailure=yes', 'RequestTTY=no']
        command = ['/usr/bin/ssh', '-F', 'none', '-S', 'none', '-T', '-a', '-x',
                   '-i', str(self.identity)]
        for value in options:
            command += ['-o', value]
        if operation == 'run':
            command += ['-R', f'127.0.0.1:{self.server_port}:127.0.0.1:{port(local_port)}']
            remote = ('exec /usr/bin/env PYTHONDONTWRITEBYTECODE=1 /usr/bin/timeout '
                      '--signal=TERM --kill-after=5 150s /usr/bin/python3 ' + program + ' run')
        elif operation == 'stage':
            remote = 'exec /usr/bin/env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 ' + program + ' stage'
        else:
            remote = ('exec /usr/bin/python3 -c '
                + shlex.quote(READ_ONLY_CHECK if operation == 'check' else CLEAN_UNUSED_STAGE) + ' ' + root)
        return command + [self.target, remote]


def staged_pin(raw, route, server_port):
    value = strict_json(raw, maximum=16384)
    require(type(value) is dict and set(value) == {'version', 'stageReady', 'route',
        'enforcementIssuer', 'enforcementKeyId', 'enforcementPublicPem', 'serverUrl'}, 'invalid_stage_response')
    require(type(value['version']) is int and value['version'] == 1 and value['stageReady'] is True
        and parse(CommandRoute, value['route']).model_dump() == route
        and value['enforcementIssuer'] == 'product-enforcer'
        and value['enforcementKeyId'] == route['enforcementKeyId']
        and value['serverUrl'] == f'ws://127.0.0.1:{server_port}/ws/nodes', 'stage_identity_changed')
    pem = value['enforcementPublicPem']
    require(type(pem) is str and len(pem) <= 4096, 'invalid_enforcer_public_key')
    try:
        key = load_pem_public_key(pem.encode('ascii'))
        require(isinstance(key, Ed25519PublicKey), 'invalid_enforcer_public_key')
        require(key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo) == pem.encode('ascii'),
                'noncanonical_enforcer_public_key')
    except (TypeError, ValueError, UnicodeError):
        raise ValueError('invalid_enforcer_public_key') from None
    return pem.encode('ascii')


def finished_evidence(value, expected_binding):
    # A successful runner exit is only lifetime evidence. Product assertions remain local.
    require(type(value) is dict and value.get('event') == 'remote_finished'
        and type(value.get('version')) is int and value['version'] == 1, 'remote_result_missing')
    expected = parse(PreparationBinding, expected_binding).model_dump()
    require(parse(PreparationBinding, value.get('binding')).model_dump() == expected, 'remote_binding_changed')
    for name in ('productAuthorityLocal', 'workSuccessNotInferred', 'runnerSucceeded',
                 'runnerWithin150s', 'enforcerKeyRemoved', 'socketAbsent'):
        require(value.get(name) is True, 'remote_cleanup_incomplete')
    require(type(value.get('actionCount')) is int and value['actionCount'] == 1, 'remote_action_count_changed')
    production = dict(containerCount=10, identitiesAndStateUnchanged=True, ipv4Ipv6SemanticsUnchanged=True)
    for name in ('before', 'after'):
        require(type(value.get(name)) is dict and value[name] == production
            and type(value[name]['containerCount']) is int
            and all(value[name][k] is True for k in ('identitiesAndStateUnchanged','ipv4Ipv6SemanticsUnchanged')),
            'remote_production_changed')
    native = value.get('native')
    require(type(native) is dict and native.get('unit') ==
        'openbot-command-' + expected['preparationId'].replace('-', '') + '.service'
        and type(native.get('invocationId')) is str and re.fullmatch('[0-9a-f]{32}', native['invocationId'])
        and type(native.get('result')) is str and bool(native['result']), 'remote_native_identity_changed')
    for name in ('originalCgroupEmpty', 'stopObservedWithin5SecondMargin', 'unitReleased',
                 'reservationRetained', 'privateRuntimeAbsent', 'backingAbsent'):
        require(native.get(name) is True, 'remote_cleanup_incomplete')
    require(not any(k in value for k in ('failure', 'cleanupFailure', 'productionFailure', 'nativeReservationIncomplete')),
            'remote_fixture_failed')
    return value


class RemoteHost:
    def __init__(self, options, directory):
        self.options, self.directory = options, directory
        self.route = self.public_stage = None
        self.process = self.monitor = self.ready = None
        self.result = None
        self.enrollment = None

    def reserve(self, operation):
        # Record uncertainty before spawning. Nothing removes/reuses a consumed phase.
        with (self.directory / ('remote-' + operation + '.reserved')).open('xb') as out:
            out.write(b'{"version":1}\n'); out.flush(); os.fsync(out.fileno())

    async def spawn(self, operation, payload, *, local_port=None):
        self.reserve(operation)
        process = await asyncio.create_subprocess_exec(*self.options.argv(operation, local_port=local_port),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=SSH_ENV, start_new_session=True, limit=CAPTURE_BYTES)
        try:
            process.stdin.write(payload)
            await asyncio.wait_for(process.stdin.drain(), 5)
            process.stdin.close()
        except BaseException:
            await self.stop_process(process)
            raise
        return process

    @staticmethod
    async def stop_process(process):
        if process.returncode is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()

    async def bounded_read(self, stream):
        data = bytearray()
        while part := await stream.read(4096):
            data.extend(part)
            require(len(data) <= CAPTURE_BYTES, 'remote_capture_bound')
        return bytes(data)

    def private_capture(self, name, data):
        if self.enrollment:
            data = data.replace(self.enrollment.encode(), b'[redacted-enrollment]')
        # A bounded prefix may end inside a token. Redact that partial spelling too.
        data = re.sub(rb'obenr_[A-Za-z0-9_-]{0,43}', b'[redacted-enrollment]', data)[:CAPTURE_BYTES]
        fd = os.open(self.directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)

    def stderr(self, operation, data):
        self.private_capture('remote-' + operation + '.stderr-private', data)

    async def once(self, operation, payload):
        process = await self.spawn(operation, payload)
        tasks = [asyncio.create_task(self.bounded_read(process.stdout)),
                 asyncio.create_task(self.bounded_read(process.stderr)), asyncio.create_task(process.wait())]
        try:
            stdout, stderr, code = await asyncio.wait_for(asyncio.gather(*tasks), 30)
            self.stderr(operation, stderr)
            require(code == 0, 'remote_' + operation + '_failed')
            return stdout
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.stop_process(process)

    async def stage(self, route, timing, control_public, bundle):
        route = parse(CommandRoute, route).model_dump()
        timing = parse(TimingPolicy, timing).model_dump()
        require(timing['runtimeMaxMs'] == 50000 and timing['stopAllowanceMs'] == 5000
            and timing['challengeBudgetMs'] == 5000, 'unqualified_timing')
        require(isinstance(load_pem_public_key(control_public), Ed25519PublicKey), 'public_control_key_required')
        require(bundle.is_file() and 0 < bundle.stat().st_size <= 8 * 1024 * 1024, 'bounded_node_bundle_required')
        value = dict(version=1, route=route, timing=timing, controlIssuer='product-control',
            controlKid='product-control-key', controlPublicPem=control_public.decode('ascii'),
            enforcementIssuer='product-enforcer', nodeBundleSha256=hashlib.sha256(bundle.read_bytes()).hexdigest(),
            serverPort=self.options.server_port)
        self.route = route
        self.public_stage = value
        raw = await self.once('stage', json.dumps(value).encode())
        return staged_pin(raw, route, self.options.server_port)

    async def start(self, enrollment, local_port):
        require(self.route is not None and type(enrollment) is str and
            re.fullmatch(r'obenr_[A-Za-z0-9_-]{43}', enrollment), 'one_time_enrollment_required')
        self.enrollment = enrollment
        self.process = await self.spawn('run', json.dumps(dict(version=1,enrollmentToken=enrollment)).encode(),
                                        local_port=local_port)
        self.ready = asyncio.get_running_loop().create_future()
        self.monitor = asyncio.create_task(self.collect())
        try:
            await asyncio.wait_for(asyncio.shield(self.ready), 20)
        except BaseException:
            # Consume a late ready failure after caller timeout/cancellation; never restart the run.
            self.ready.add_done_callback(lambda value: value.exception() if not value.cancelled() else None)
            raise

    async def collect(self):
        captured = {'stdout': bytearray(), 'stderr': bytearray()}
        complete = dict(stdout=False, stderr=False)
        truncated = dict(stdout=False, stderr=False)
        failure = None
        timed_out = False
        exit_before_stop = None
        stopped = False

        def failed(error):
            nonlocal failure
            if failure is None:
                failure = error
                if not self.ready.done():
                    self.ready.set_exception(error)

        def retain(name, data):
            remaining = CAPTURE_BYTES - len(captured[name])
            captured[name].extend(data[:remaining])
            truncated[name] = truncated[name] or len(data) > remaining
            require(not truncated[name], 'remote_capture_bound')

        async def watch(awaitable):
            try:
                return await awaitable
            except asyncio.CancelledError:
                raise
            except Exception as error:
                failed(error)
                raise

        async def stdout():
            total = 0
            for event in ('remote_ready', 'remote_finished'):
                raw = await self.process.stdout.readline(); total += len(raw)
                retain('stdout', raw)
                if not raw:
                    complete['stdout'] = True
                require(raw and total <= CAPTURE_BYTES, 'remote_event_missing_or_oversized')
                value = strict_json(raw, maximum=16384)
                require(type(value) is dict and value.get('event') == event, 'remote_event_order_changed')
                if event == 'remote_ready':
                    require(value == dict(version=1,event=event,socketReady=True,nodeSpawned=True,nodeUid=62425,
                        serverAuthenticated=False) and type(value['version']) is int and type(value['nodeUid']) is int
                        and value['socketReady'] is True and value['nodeSpawned'] is True
                        and value['serverAuthenticated'] is False, 'invalid_remote_ready')
                    if not self.ready.done():
                        self.ready.set_result(None)
                else:
                    self.result = value
            extra = await self.process.stdout.read(1)
            retain('stdout', extra)
            complete['stdout'] = not extra
            require(not extra, 'unexpected_remote_event')

        async def stderr():
            while part := await self.process.stderr.read(4096):
                retain('stderr', part)
            complete['stderr'] = True

        tasks = [asyncio.create_task(watch(stdout())), asyncio.create_task(watch(stderr())),
                 asyncio.create_task(watch(self.process.wait()))]
        try:
            # A malformed/absent stdout record must not discard its sibling's traceback.
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), RUN_CAPTURE_SECONDS)
            if self.process.returncode != 0:
                failed(ValueError('remote_run_failed'))
        except asyncio.TimeoutError as error:
            timed_out = True
            failed(error)
        except BaseException as error:
            failed(error)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            exit_before_stop = self.process.returncode
            stopped = exit_before_stop is None
            try:
                await self.stop_process(self.process)
            except Exception as error:
                failed(error)
            try:
                self.private_capture('remote-run.stdout-private', bytes(captured['stdout']))
                self.stderr('run', bytes(captured['stderr']))
                facts = dict(version=1, exitCode=self.process.returncode, exitCodeBeforeLocalStop=exit_before_stop,
                    localStopRequested=stopped, captureTimedOut=timed_out, captureSecondsLimit=RUN_CAPTURE_SECONDS,
                    capturedBytes={name: len(data) for name, data in captured.items()},
                    complete=complete, truncated=truncated,
                    errorType=type(failure).__name__ if failure else None)
                self.private_capture('remote-run.capture-private.json', json.dumps(facts).encode())
            finally:
                self.enrollment = None
        if failure is not None:
            raise failure
        return self.result

    async def assert_unprepared(self):
        require(self.monitor is not None and not self.monitor.done(), 'original_remote_run_required')
        raw = await self.once('check', b'')
        value = strict_json(raw, maximum=16384)
        require(value == dict(version=1,singleActionAbsent=True,runnerReserved=True,route=self.route)
            and type(value['version']) is int and value['singleActionAbsent'] is True
            and value['runnerReserved'] is True, 'remote_action_already_exists')
        require(not self.monitor.done(), 'original_remote_run_ended')

    async def finish(self, expected_binding):
        require(self.monitor is not None, 'original_remote_run_required')
        return finished_evidence(await asyncio.shield(self.monitor), expected_binding)

    async def close(self):
        # Wait for the original run's cleanup, including on local failure; never send cleanup/retry.
        if (self.directory / 'remote-stage.reserved').exists() and not (self.directory / 'remote-run.reserved').exists():
            # Even an uncertain stage ACK can be inspected. Mismatched/partial ownership fails closed.
            require(self.public_stage is not None, 'stage_cleanup_ownership_unknown')
            raw = await self.once('cleanup', json.dumps(self.public_stage).encode())
            value = strict_json(raw, maximum=16384)
            require(type(value) is dict and set(value) == {'stageBelongsToThisProbe','neverRunObserved','enforcerKeyAbsent'}
                and all(v is True for v in value.values()), 'stage_cleanup_uncertain')
            (self.directory / 'remote-unused-stage-cleanup.json').write_text(json.dumps(value))
        if self.monitor is not None:
            await asyncio.shield(self.monitor)
        elif (self.directory / 'remote-run.reserved').exists():
            raise ValueError('original_run_cleanup_unobserved')
