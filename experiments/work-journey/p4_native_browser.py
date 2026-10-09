"""Join the TS product journey to one root-private native browser composition on disposable CI."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import select
import selectors
import socket
import socketserver
import subprocess
import sys
import threading
import time

BASE=Path('/opt/obp4')
PROGRAM=BASE/'composition-20260926-a1/run.py'
LAUNCHER=BASE/'browser_launcher.py'
MAXIMUM=96*1024


def require(value,code):
    if not value:raise ValueError(code)


FAILURE_TYPES=frozenset(('FileNotFoundError','PermissionError','TimeoutError','TimeoutExpired',
    'OSError','ValueError','RuntimeError','CalledProcessError','JSONDecodeError'))
FAILURE_PHASES=frozenset(('readiness','product','finish','expiry'))
FAILURE_CODES={
    'bounded wait expired: verified open TLS tunnel':'verified_tls_tunnel_missing',
    'bounded wait expired: existing tunnel revocation':'tunnel_revocation_missing',
    'existing tunnel survived or target received another request':'tunnel_revocation_failed',
    'not original native timeout':'native_timeout_changed',
    'owned native tree is not empty':'native_cgroup_not_empty',
    'production state changed':'native_host_state_changed',
    "private Docker command failed: ('image', 'inspect')":'image_name_missing',
    "private Docker command failed: ('image', 'tag')":'image_digest_missing',
    'native_browser_acceptance_failed':'native_acceptance_failed',
}
NATIVE_FLAGS=('accepted','actualRunsc','actualSquid','actualProductJourney','originalNativeExpiryVerified',
    'failedOriginalUnitClosed','productionUnchanged','ownedRuntimeRemoved')


def native_failure(error,phase,result):
    # Public fixed phase/type and typed original-fixture flags only. No exception values,
    # stderr, command inputs, cookies, keys or enrollment enter hosted diagnostics.
    require(phase in FAILURE_PHASES,'native_failure_phase_changed')
    record=dict(phase=phase,errorType=type(error).__name__ if type(error).__name__ in FAILURE_TYPES else 'Exception',
        code=FAILURE_CODES.get(str(error),'fixture_failed'))
    if type(result) is dict:
        record['nativeFlags']={k:result[k] for k in NATIVE_FLAGS if type(result.get(k)) is bool}
        for k in ('failure','cleanupFailure'):
            if type(result.get(k)) is str and result[k] in FAILURE_CODES:record[k+'Code']=FAILURE_CODES[result[k]]
        for k in ('nativeDeadlineSeconds','existingContainerCount'):
            if type(result.get(k)) is int and 0<=result[k]<=65535:record[k]=result[k]
    return {'nativeBrowserFailure':record}


async def bounded_stderr(stream):
    data=bytearray()
    while part:=await stream.read(4096):
        data.extend(part);require(len(data)<=MAXIMUM,'native_capture_bound')
    return bytes(data)


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        remote=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        try:
            remote.settimeout(3);remote.connect(str(self.server.target))
            self.request.setblocking(False);remote.setblocking(False)
            with selectors.DefaultSelector() as selector:
                selector.register(self.request,selectors.EVENT_READ,remote)
                selector.register(remote,selectors.EVENT_READ,self.request)
                end=time.monotonic()+90;total=0
                while time.monotonic()<end:
                    for key,_ in selector.select(1):
                        data=key.fileobj.recv(65536)
                        if not data:return
                        total+=len(data);require(total<=2*1024*1024,'relay_capture_bound')
                        key.data.settimeout(3);key.data.sendall(data);key.data.setblocking(False)
        finally:remote.close()


class LoopbackRelay(socketserver.ThreadingTCPServer):
    daemon_threads=True
    block_on_close=False


def root_run():
    require(sys.platform=='linux' and os.geteuid()==0 and Path(__file__).resolve()==LAUNCHER,'root_ci_packet_required')
    os.umask(0o077)
    plan=json.loads((BASE/'PLAN.json').read_text());root=Path(plan['nativeRoot'])
    require(root.parent==BASE/'units' and not root.exists(),'fresh_native_root_required')
    servers=[];child=None;accepted=False;error=None;result=None;phase='readiness'
    log=(BASE/'browser-private.log').open('xb')
    try:
        child=subprocess.Popen(['/usr/bin/python3','-B',str(PROGRAM),'run'],stdin=subprocess.DEVNULL,
            stdout=log,stderr=subprocess.STDOUT,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
        end=time.monotonic()+150
        while not (root/'ready.json').exists():
            if child.poll() is not None:
                raise ValueError('native_browser_before_ready_failed')
            require(time.monotonic()<end,'native_browser_readiness_unknown');time.sleep(.1)
        relays={}
        for name in ('control','target'):
            server=LoopbackRelay(('127.0.0.1',0),Relay);server.target=root/(name+'.sock');servers.append(server)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            relays[name]='http://127.0.0.1:'+str(server.server_address[1])
        print(json.dumps(dict(fixtureEnvironment='disposable-github-linux',computerUrl=relays['control'],stateUrl=relays['target'],
            targetUrl='https://example.com:18443',token='synthetic-linux-composition-fixture-only')),flush=True)
        phase='product'
        require(select.select([sys.stdin.buffer],[],[],360)[0],'product_acceptance_missing')
        raw=sys.stdin.buffer.readline(1025);require(len(raw)<=1024,'product_acceptance_bound')
        value=json.loads(raw);require(type(value) is dict and set(value)=={'productAccepted'} and type(value['productAccepted']) is bool,'product_acceptance_changed')
        accepted=value['productAccepted']
        operation='finish' if accepted else 'abort'
        phase='finish'
        subprocess.run(['/usr/bin/python3','-B',str(PROGRAM),operation],check=True,capture_output=True,timeout=10)
        phase='expiry'
        code=child.wait(timeout=620)
        result=json.loads((root/'result.json').read_text())
        require(code==0 and accepted and result['accepted'] is True and result['actualRunsc'] is True
            and result['originalNativeExpiryVerified'] is True and result['productionUnchanged'] is True
            and result['ownedRuntimeRemoved'] is True,'native_browser_acceptance_failed')
        print(json.dumps(result),flush=True)
    except Exception as failure:error=failure
    finally:
        if child is not None and child.poll() is None:
            # Request only the original failed unit's bounded cleanup. Never renew/restart it.
            try:subprocess.run(['/usr/bin/python3','-B',str(PROGRAM),'abort'],check=True,capture_output=True,timeout=10)
            except Exception:pass
            try:child.wait(timeout=30)
            except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
        for server in servers:server.shutdown();server.server_close()
        log.close()
    if error is not None:
        candidate=root/'result.json'
        if result is None and candidate.is_file() and candidate.stat().st_size<=MAXIMUM:
            try:result=json.loads(candidate.read_text())
            except (ValueError,UnicodeError):pass
        print(json.dumps(native_failure(error,phase,result)),flush=True)
        raise SystemExit(1) from None


async def qualify(output,upstream,browsers):
    from product_browser_probe import run
    require(not output.exists(),'fresh_product_output_required')
    root=await asyncio.create_subprocess_exec('/usr/bin/sudo','-n','/usr/bin/python3','-B',str(LAUNCHER),'--root',
        stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,limit=MAXIMUM)
    error=None;result=None;diagnostic=None
    error_task=asyncio.create_task(bounded_stderr(root.stderr))
    try:
        remote=json.loads(await asyncio.wait_for(root.stdout.readline(),160))
        if type(remote) is dict and set(remote)=={'nativeBrowserFailure'}:
            diagnostic=remote;raise ValueError('native_browser_readiness_failed')
        async with asyncio.timeout(360):await run(output,upstream,browsers,'linux-replacement',remote,'ts')
        root.stdin.write(b'{"productAccepted":true}\n');await root.stdin.drain();root.stdin.close()
        raw=await asyncio.wait_for(root.stdout.readline(),620);result=json.loads(raw)
        if type(result) is dict and set(result)=={'nativeBrowserFailure'}:
            diagnostic=result;raise ValueError('native_browser_original_acceptance_failed')
        await asyncio.wait_for(root.wait(),10)
        require(root.returncode==0 and result['accepted'] is True,'native_browser_acceptance_failed')
        record=json.loads((output/'RESULT.json').read_text())
        require(record['accepted'] is True and record['ownedFixturesClosed'] is True and record['isolatedLinuxBrowserProduct'] is True,'product_browser_acceptance_failed')
        record.update(remoteNativeCleanupPending=False,nativeAcceptance=result,nativeCleanupComplete=True)
        (output/'RESULT.json').write_text(json.dumps(record,indent=2)+'\n')
        print(json.dumps(record),flush=True)
    except BaseException as failure:
        error=failure
        if root.returncode is None:
            try:root.stdin.write(b'{"productAccepted":false}\n');await root.stdin.drain();root.stdin.close()
            except (BrokenPipeError,ConnectionResetError):pass
            try:await asyncio.wait_for(root.wait(),45)
            except TimeoutError:root.terminate();await asyncio.wait_for(root.wait(),10)
        raise
    finally:
        data=await error_task
        if not output.exists():output.mkdir(mode=0o700)
        (output/'native.stderr-private').write_bytes(data)
        if error is not None:print(json.dumps(diagnostic or native_failure(error,'product',None)),flush=True)
        if error is not None and (output/'RESULT.json').exists():
            record=json.loads((output/'RESULT.json').read_text());record['accepted']=False;record['nativeCleanupComplete']=False
            if diagnostic is not None:record['nativeFailure']=diagnostic['nativeBrowserFailure']
            (output/'RESULT.json').write_text(json.dumps(record,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',action='store_true')
    for name in ('output','upstream','browsers'):parser.add_argument('--'+name,type=Path)
    args=parser.parse_args()
    if args.root:root_run()
    else:
        if any(getattr(args,k) is None for k in ('output','upstream','browsers')):parser.error('Explicit owned output and existing pinned upstream/browsers are required')
        asyncio.run(qualify(args.output.resolve(),args.upstream.resolve(),args.browsers.resolve()))
