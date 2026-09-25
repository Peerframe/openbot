"""Real local Unix framing plus explicit synthetic protected-native/clock boundary."""
import base64
from copy import deepcopy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import threading
import tempfile
from types import SimpleNamespace
from uuid import uuid4
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding,PrivateFormat,PublicFormat,NoEncryption
from openbot_server.work_command_crypto import VerificationPin,_parts
from openbot_server.work_command_v2_crypto import CommandV2Signer,CommandV2Verifier
from openbot_server.work_command_v2_contract import BindingV2,token_digest,staging
from openbot_server.work_command_contract import derive_operation,operation_fingerprint,bounded_value
from protected_host import Host,Configuration,Inputs,UnixService
from protected_io import Refused,exclusive,receive,send,read_record

class Clock:
    def __init__(self):self.now=100000000;self.boot=str(uuid4())
    def __call__(self):return self.now,self.now,self.boot
    def step(self,ms):self.now+=ms*1000

def key(issuer,kid,role):
    k=Ed25519PrivateKey.generate();return CommandV2Signer(issuer=issuer,kid=kid,role=role,private_pem=k.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption())),VerificationPin(issuer,kid,role,k.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))

class FakeNative:
    def __init__(self,base,clock):self.base=base;self.clock=clock;self.instance_path=None;self.calls=[];self.fail_execute=False;self.data=b'x,y\n';self.shape='f'*64
    def reserve(self,binding,authorization,instance):
        self.calls.append('reserve');root=self.base/binding['preparationId'];root.mkdir();(root/'input').mkdir();(root/'output').mkdir()
        return {'root':str(root),'input':str(root/'input'),'output':str(root/'output'),'binding':binding,'instance':instance}
    def prepare(self,record,authorization,start):self.calls.append('prepare');self.clock.step(10)
    def check_alive(self,record):return True
    def readiness(self,record,authorization):
        self.calls.append('readiness');b=record['binding'];unit='openbot-command-'+b['preparationId'].replace('-','')+'.service'
        return dict(bootId=self.clock.boot,enforcerInstanceId=record['instance'],unitName=unit,invocationId='1'*32,
            cgroupPath='/system.slice/'+unit,cgroupInode=25,activeMonotonicUs=100000001,runtimeMaxUs=50000000,
            observedMonotonicUs=self.clock.now,observedBoottimeUs=self.clock.now,runtimeIdentityDigest='e'*64,
            runtimeShapeDigest=self.shape,timingPolicyDigest='e'*64,startAttempts=0)
    def execute(self,record,operation,launch):
        self.calls.append('execute');self.operation=operation
        if self.fail_execute:raise Refused('native_command_unknown')
    def lookup(self,record,operation,*,include_output):
        self.calls.append('lookup');o=operation['command']['output'];data=self.data if include_output else None
        return dict(phase='exited',containerId='d'*64,startAttempts=1,exitCode=0,sequence=1,runtimeShapeDigest=self.shape,
            outputs=[dict(name=o['name'],mediaType=o['mediaType'],sizeBytes=len(data),sha256=hashlib.sha256(data).hexdigest())] if data is not None else [],truncated=False),data
    def stop(self,record):self.calls.append('stop')

@pytest.fixture
def h(tmp_path):
    cp,ck=key('control','control-1','control');ep,ek=key('enforcer','enforcer-1','enforcement');clock=Clock()
    policy=dict(prepareBudgetMs=30000,challengeBudgetMs=5000,runtimeMaxMs=50000,stopAllowanceMs=5000,clockRateErrorPpm=1000,clockQuantizationMs=100,policyDigest='e'*64)
    vector=Path(os.environ.get('OPENBOT_COMMAND_VECTOR_FILE',Path(__import__('openbot_server').__path__[-1]).parent.parent/'tests/fixtures/work_command_vectors.json'));command=json.loads(vector.read_text())['intent']['command']
    command['inputManifest']=[];command['inputDigest']='sha256:'+hashlib.sha256(b'[]').hexdigest()
    route=dict(nodeId='node',providerId='linux-command',enforcementKeyId='enforcer-1',ledgerId=str(uuid4()))
    intent=dict(kind='work_command',version=1,profileDigest='a'*64,command=command)
    operation=derive_operation(intent,task_id='task',run_id='run',action_id='action',generation=1,original_epoch=1,route=route).model_dump()
    binding=dict(taskId='task',runId='run',actionId='action',preparationId=str(uuid4()),connectionId=str(uuid4()),originalEpoch=1,
        authorityGeneration=1,profileDigest='a'*64,intentDigest=operation['intentDigest'],operationFingerprint=operation_fingerprint(operation),**route)
    state=tmp_path/'state';state.mkdir();work=tmp_path/'native';work.mkdir();native=FakeNative(work,clock)
    verifier=CommandV2Verifier([ck,ek]);cfg=Configuration(state,tmp_path/'command.sock',os.getuid(),os.getgid(),route,policy,'control','enforcer',{},ep,verifier)
    host=Host(cfg,native,clock=clock);yield SimpleNamespace(**locals());host.close()

def frame(h,kind,payload,request=None):return dict(type='work.command.'+kind,protocolVersion='0.10.0',nodeId='node',preparationId=h.binding['preparationId'],requestId=request or h.binding['preparationId'],payload=payload)

def open_authorize(h,mutate=None):
    challenge=h.host.handle(frame(h,'prepare_open',h.binding))[0]['payload']['token'];payload=_parts(challenge)[1]
    grant=dict(**h.binding,version=2,purpose='work_command_prepare_authorize',iss='control',aud='enforcer',jti=str(uuid4()),
        requestId=h.binding['preparationId'],nonce=payload['nonce'],challengeDigest=token_digest(challenge),issuedAtMs=1800000000000,
        rootDeadlineMs=1800000300000,timing=h.policy,staging=staging(h.command).model_dump())
    if mutate:mutate(grant)
    h.authorization=h.cp.sign(grant,purpose='work_command_prepare_authorize')
    result=h.host.handle(frame(h,'prepare_authorize',{'token':h.authorization}))
    if result:h.ready=result[-1]['payload']['token']
    return result

def dispatch(h):
    stamp=1800000000100;b=dict(**h.binding,version=2,dispatchId=str(uuid4()),readinessDigest=token_digest(h.ready),hardDeadlineMs=1800000055000)
    claims=dict(**b,purpose='work_command_dispatch',iss='control',aud='enforcer',jti=str(uuid4()),iat=stamp//1000,nbf=stamp//1000,exp=stamp//1000+25,
        anchors=dict(admittedAtMs=stamp,rootDeadlineMs=1800000300000,nativeDeadlineMs=b['hardDeadlineMs'],hardDeadlineMs=b['hardDeadlineMs'],wallSeconds=60,deadlineProfileVersion=2))
    token=h.cp.sign(claims,purpose='work_command_dispatch',now_ms=stamp);h.ticket=token;h.dispatch_binding=b
    result=h.host.handle(frame(h,'dispatch',{'ticket':token,'operation':h.operation},b['dispatchId']));h.challenge=result[0]['payload']['token'];h.consume=_parts(h.challenge)[1]
    return result

def permit(h):
    stamp=1800000000200;c=h.consume
    value=dict(**h.dispatch_binding,purpose='work_command_permit',iss='control',aud='enforcer',jti=str(uuid4()),iat=stamp//1000,nbf=stamp//1000,
        exp=(stamp+5000)//1000,requestId=c['requestId'],nonce=c['nonce'],requestDigest=token_digest(h.challenge),consumedAtMs=stamp,launchDeadlineMs=stamp+5000)
    token=h.cp.sign(value,purpose='work_command_permit',now_ms=stamp);h.permit=token
    return h.host.handle(frame(h,'consume_result',{'status':'consumed','permit':token},c['requestId']))

def control(h,operation='lookup',output=True,delay=0):
    request=str(uuid4());challenge=h.host.handle(frame(h,'control_open',{'binding':h.binding,'operation':operation},request))[0]['payload']['token'];c=_parts(challenge)[1]
    value=dict(**h.binding,version=2,purpose='work_command_control_request',iss='control',aud='enforcer',jti=str(uuid4()),operation=operation,requestId=request,nonce=c['nonce'],
        challengeDigest=token_digest(challenge),issuedAtMs=1800000000300,expiresAtMs=1800000010300,dispatch=h.dispatch_binding)
    value.update({'includeOutput':output} if operation=='lookup' else {'reason':'cancel'})
    token=h.cp.sign(value,purpose='work_command_control_request');h.clock.step(delay)
    return request,h.host.handle(frame(h,operation,{'token':token},request))

def test_complete_signed_flow_and_single_execution(h):
    assert open_authorize(h)[0]['type']=='work.command.ready';dispatch(h);permit(h)
    request,results=control(h);assert [r['type'] for r in results]==['work.command.lookup_result','work.command.output_chunk']
    assert base64.b64decode(results[1]['payload']['data'])==h.native.data
    receipt=h.verifier.verify(results[0]['payload']['token'],purpose='work_command_receipt',issuer='enforcer',audience='control',expected_binding=h.dispatch_binding,
        expected_request={'requestId':request,'nonce':h.host.controls[request]['pending'].nonce},now_ms=1800000000300)
    assert receipt.originalEpoch==1 and receipt.observation.exitCode==0
    assert h.native.calls.count('execute')==1
    with pytest.raises((ValueError,Refused,FileExistsError)):permit(h)
    assert h.native.calls.count('execute')==1

@pytest.mark.parametrize('output',[False,True])
def test_completed_readbacks_release_live_slots_but_keep_replay_tombstones(h,output):
    open_authorize(h);dispatch(h);permit(h)
    first=None
    for _ in range(70):
        request,results=control(h,output=output)
        first=first or request
        if output:
            assert request in h.host.controls
            assert h.host.handle(frame(h,'output_ack',dict(fileIndex=0,nextOffset=len(h.native.data)),request))==[]
        assert request not in h.host.controls and request in h.host.book._finished
        assert len(h.host.book._pending)==1 and len(h.host.active)==1
    assert h.native.calls.count('execute')==1 and len(h.host.book._finished)==70
    with pytest.raises((Refused,ValueError)):
        h.host.handle(frame(h,'control_open',dict(binding=h.binding,operation='lookup'),first))

def test_empty_output_releases_without_requiring_an_impossible_chunk_ack(h):
    h.native.data=b'';open_authorize(h);dispatch(h);permit(h)
    request,results=control(h)
    assert len(results)==1 and request not in h.host.controls
    assert request in h.host.book._finished and not h.host.output

def test_unknown_execution_never_retries_and_restart_only_lookup(h):
    open_authorize(h);dispatch(h);h.native.fail_execute=True
    with pytest.raises(Refused):permit(h)
    with pytest.raises(FileExistsError):permit(h)
    assert h.native.calls.count('execute')==1
    h.host.close();h.host=Host(h.cfg,h.native,clock=h.clock)
    with pytest.raises(Refused):h.host.handle(frame(h,'prepare_open',h.binding))
    _,result=control(h,output=False);assert len(result)==1
    assert h.native.calls.count('prepare')==h.native.calls.count('execute')==1

@pytest.mark.parametrize('change',['nodeId','providerId','ledgerId','connectionId','operation','epoch'])
def test_changed_binding_or_operation_refuses(h,change):
    if change in ('nodeId','providerId','ledgerId'):
        h.binding[change]=str(uuid4())
        with pytest.raises((Refused,ValueError)):open_authorize(h)
    elif change=='connectionId':
        h.host.handle(frame(h,'prepare_open',h.binding));changed=deepcopy(h.binding);changed['preparationId']=str(uuid4());changed['connectionId']=str(uuid4());changed['actionId']='other'
        value=frame(h,'prepare_open',changed,changed['preparationId']);value['preparationId']=changed['preparationId']
        with pytest.raises(Refused):h.host.handle(value)
    else:
        open_authorize(h);original=deepcopy(h.operation)
        if change=='operation':h.operation['command']['argv']=['echo','different']
        else:h.operation['originalEpoch']=2
        with pytest.raises((Refused,ValueError)):dispatch(h)
        assert h.native.calls.count('execute')==0

@pytest.mark.parametrize('delay',[5000,30000])
def test_late_first_lookup_never_reads_output(h,delay):
    open_authorize(h);dispatch(h);permit(h)
    with pytest.raises(ValueError):control(h,delay=delay)
    assert 'lookup' not in h.native.calls

def test_each_output_chunk_needs_same_unexpired_lookup(h):
    open_authorize(h);dispatch(h);permit(h);h.native.data=b'x'*40000
    request,result=control(h);assert len(base64.b64decode(result[1]['payload']['data']))==16384
    h.clock.step(10000)
    with pytest.raises(ValueError):h.host.handle(frame(h,'output_ack',{'fileIndex':0,'nextOffset':16384},request))

def test_stop_has_no_output_scope_and_control_replay_refuses(h):
    open_authorize(h);dispatch(h);permit(h);control(h,'stop');assert h.native.calls[-1]=='stop'
    request,result=control(h,output=False);assert len(result)==1
    with pytest.raises((Refused,ValueError)):h.host.handle(frame(h,'output_ack',{'fileIndex':0,'nextOffset':1},request))

@pytest.mark.parametrize('change',['offset','size','index','hash'])
def test_manifest_receiver_refuses_corruption(tmp_path,change):
    data=b'abcd';manifest=[dict(path='input.csv',size=4,sha256=hashlib.sha256(data).hexdigest())]
    receiver=Inputs(tmp_path,manifest);payload=dict(fileIndex=0,offset=0,data=base64.b64encode(data).decode())
    if change=='offset':payload['offset']=1
    if change=='size':payload['data']=base64.b64encode(b'abcde').decode()
    if change=='index':payload['fileIndex']=1
    if change=='hash':payload['data']=base64.b64encode(b'zzzz').decode()
    try:
        with pytest.raises(Refused):receiver.append(payload)
    finally:receiver.close()

def test_manifest_split_bytes_and_immutable_completion(tmp_path):
    data=b'a'*20000;receiver=Inputs(tmp_path,[dict(path='input.txt',size=len(data),sha256=hashlib.sha256(data).hexdigest())])
    receiver.append(dict(fileIndex=0,offset=0,data=base64.b64encode(data[:16384]).decode()))
    assert not receiver.complete()
    receiver.append(dict(fileIndex=0,offset=16384,data=base64.b64encode(data[16384:]).decode()));assert receiver.complete()
    assert (tmp_path/'input.txt').read_bytes()==data and (tmp_path/'input.txt').stat().st_mode&0o777==0o444
    with pytest.raises(Refused):receiver.append(dict(fileIndex=0,offset=0,data='YQ=='))

def test_input_symlink_never_followed(tmp_path):
    outside=tmp_path/'secret';outside.write_bytes(b'unchanged');(tmp_path/'input.txt').symlink_to(outside)
    with pytest.raises(FileExistsError):Inputs(tmp_path,[dict(path='input.txt',size=1,sha256='0'*64)])
    assert outside.read_bytes()==b'unchanged'

@pytest.mark.parametrize('payload',[b'{"a":1,"a":2}',b'\xff',b'NaN',b'{"x":"\\ud800"}'])
def test_raw_framing_fatal_decode_and_strict_json(payload):
    a,b=socket.socketpair()
    try:
        a.sendall(struct.pack('!I',len(payload))+payload)
        with pytest.raises((ValueError,UnicodeError)):receive(b)
    finally:a.close();b.close()

@pytest.mark.parametrize('size',[0,32769,2**32-1])
def test_raw_length_refused_before_body(size):
    a,b=socket.socketpair()
    try:
        a.sendall(struct.pack('!I',size))
        with pytest.raises(Refused):receive(b)
    finally:a.close();b.close()

def actual_local_peer(sock):
    if hasattr(socket,'SO_PEERCRED'):
        from protected_io import peer_uid
        return peer_uid(sock)
    # Test-only Darwin native peer check, not an accepted Linux production fallback.
    libc=ctypes.CDLL(None,use_errno=True);uid=ctypes.c_uint();gid=ctypes.c_uint()
    assert libc.getpeereid(sock.fileno(),ctypes.byref(uid),ctypes.byref(gid))==0
    return uid.value

def test_real_local_unix_exchange_and_disconnect(h,tmp_path):
    # Keep the canonical path below the Unix socket limit on both Linux and macOS.
    short=tempfile.TemporaryDirectory(prefix='obh-',dir=str(Path('/tmp').resolve()));listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);path=Path(short.name)/'s';listener.bind(str(path));listener.listen(1);errors=[]
    def worker():
        try:
            conn,_=listener.accept()
            with conn:UnixService(h.host,peer=actual_local_peer).connection(conn)
        except EOFError:pass
        except Exception as error:errors.append(error)
    thread=threading.Thread(target=worker);thread.start();client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);client.connect(str(path))
    send(client,frame(h,'prepare_open',h.binding));reply=receive(client)
    assert reply['type']=='work.command.prepare_challenge' and actual_local_peer(client)==os.getuid()
    client.close();thread.join(3);listener.close();path.unlink();short.cleanup()
    assert not thread.is_alive() and not errors and h.host.closed

def test_bad_peer_never_receives_frame(h):
    a,b=socket.socketpair()
    try:
        with pytest.raises(Refused):UnixService(h.host,peer=lambda s:os.getuid()+1).connection(b)
    finally:a.close();b.close()

def test_durable_fsync_failure_blocks_prepare(h,monkeypatch):
    h.host.handle(frame(h,'prepare_open',h.binding));s=h.host.active[h.binding['preparationId']];challenge=s['pending'].challenge_digest
    grant=dict(**h.binding,version=2,purpose='work_command_prepare_authorize',iss='control',aud='enforcer',jti=str(uuid4()),requestId=h.binding['preparationId'],
        nonce=s['pending'].nonce,challengeDigest=challenge,issuedAtMs=1800000000000,rootDeadlineMs=1800000300000,timing=h.policy,staging=staging(h.command).model_dump())
    token=h.cp.sign(grant,purpose='work_command_prepare_authorize')
    monkeypatch.setattr(os,'fsync',lambda fd:(_ for _ in ()).throw(OSError('synthetic fsync')))
    with pytest.raises(OSError):h.host.handle(frame(h,'prepare_authorize',{'token':token}))
    assert 'prepare' not in h.native.calls


def test_input_frames_must_finish_manifest_before_ready(h):
    data=b'x'*20000;h.command['inputManifest']=[dict(path='input.csv',size=len(data),sha256=hashlib.sha256(data).hexdigest())]
    h.command['inputDigest']='sha256:'+hashlib.sha256(bounded_value(h.command['inputManifest'])).hexdigest()
    h.operation=derive_operation(dict(kind='work_command',version=1,profileDigest='a'*64,command=h.command),task_id='task',run_id='run',action_id='action',generation=1,original_epoch=1,route=h.route).model_dump()
    h.binding['intentDigest']=h.operation['intentDigest'];h.binding['operationFingerprint']=operation_fingerprint(h.operation)
    assert open_authorize(h)==[]
    for offset in (0,16384):
        result=h.host.handle(frame(h,'input_chunk',dict(fileIndex=0,offset=offset,data=base64.b64encode(data[offset:offset+16384]).decode())))
        assert result[0]['type']=='work.command.input_ack'
        if offset==0:assert len(result)==1
        else:assert result[1]['type']=='work.command.ready';h.ready=result[1]['payload']['token']
    dispatch(h);permit(h);assert h.native.calls.count('execute')==1


def test_observation_sequence_survives_host_restart(h):
    open_authorize(h);dispatch(h);permit(h);_,first=control(h,output=False)
    assert _parts(first[0]['payload']['token'])[1]['observation']['sequence']==1
    h.host.close();h.host=Host(h.cfg,h.native,clock=h.clock);_,second=control(h,output=False)
    assert _parts(second[0]['payload']['token'])[1]['observation']['sequence']==2


def test_sixty_four_live_slots_no_eviction(h):
    for i in range(64):
        b=deepcopy(h.binding);b.update(actionId='action'+str(i),preparationId=str(uuid4()))
        value=frame(h,'prepare_open',b,b['preparationId']);value['preparationId']=b['preparationId'];h.host.handle(value)
    with pytest.raises((Refused,ValueError)):h.host.handle(frame(h,'prepare_open',h.binding))
    assert len(h.host.active)==64 and not h.native.calls


def test_real_unix_entire_signed_flow(h):
    short=tempfile.TemporaryDirectory(prefix='obh-',dir=str(Path('/tmp').resolve()));path=Path(short.name)/'s';listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    listener.bind(str(path));listener.listen(1);errors=[];real=h.host
    def worker():
        try:
            conn,_=listener.accept()
            with conn:UnixService(real,peer=actual_local_peer).connection(conn)
        except EOFError:pass
        except Exception as error:errors.append(error)
    thread=threading.Thread(target=worker);thread.start();client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);client.settimeout(3);client.connect(str(path))
    class Remote:
        def handle(self,value):
            send(client,value);kind=value['type']
            count=0 if kind=='work.command.consume_result' else 2 if kind=='work.command.lookup' else 1
            return [receive(client) for _ in range(count)]
        def close(self):pass
    h.host=Remote()
    try:
        open_authorize(h);dispatch(h);permit(h);_,results=control(h)
        assert results[0]['type']=='work.command.lookup_result' and base64.b64decode(results[1]['payload']['data'])==h.native.data
    finally:
        client.close();thread.join(3);listener.close();path.unlink();short.cleanup();h.host=real
    assert not thread.is_alive() and not errors and h.native.calls.count('execute')==1


@pytest.mark.parametrize('mutation',['symlink','hardlink','mode'])
def test_private_key_reader_refuses_wrong_file_shape(tmp_path,mutation):
    from protected_io import read_bytes
    key=tmp_path/'key';key.write_bytes(b'synthetic key');key.chmod(0o600)
    if mutation=='symlink':target=tmp_path/'target';key.rename(target);key.symlink_to(target)
    if mutation=='hardlink':os.link(key,tmp_path/'other')
    if mutation=='mode':key.chmod(0o644)
    with pytest.raises((Refused,OSError)):read_bytes(key,1024,uid=os.getuid())
