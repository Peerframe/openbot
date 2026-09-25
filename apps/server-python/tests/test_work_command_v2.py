import base64
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from uuid import uuid4
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption
from openbot_server.work_command_crypto import VerificationPin
from openbot_server.work_command_v2_crypto import CommandV2Signer,CommandV2Verifier,HostExchangeBook
from openbot_server.work_command_v2_contract import *
from openbot_server.work_command_frames import parse_command_frame

class Clock:
    def __init__(self): self.m=100000000;self.b=self.m;self.boot=str(uuid4())
    def __call__(self): return self.m,self.b,self.boot
    def step(self,ms):self.m+=ms*1000;self.b+=ms*1000

def key(issuer,kid,role):
    k=Ed25519PrivateKey.generate()
    return CommandV2Signer(issuer=issuer,kid=kid,role=role,private_pem=k.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption())),VerificationPin(issuer,kid,role,k.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))

def harness():
    cp,ck=key('control','control-1','control');ep,ek=key('enforcement','enforcer-1','enforcement')
    verifier=CommandV2Verifier([ck,ek]);clock=Clock()
    policy=dict(prepareBudgetMs=30000,challengeBudgetMs=5000,runtimeMaxMs=50000,stopAllowanceMs=5000,
        clockRateErrorPpm=1000,clockQuantizationMs=1,policyDigest='e'*64)
    book=HostExchangeBook(policy=policy,clock=clock)
    binding=dict(taskId='task',runId='run',actionId='action',preparationId=str(uuid4()),connectionId=str(uuid4()),
        originalEpoch=1,authorityGeneration=1,profileDigest='a'*64,intentDigest='b'*64,operationFingerprint='c'*64,
        nodeId='node',providerId='linux-command',enforcementKeyId='enforcer-1',ledgerId=str(uuid4()))
    pending=book.begin_prepare(binding);challenge=pending.challenge(ep,audience='control')
    vector=Path(__import__('openbot_server').__path__[-1]).parent.parent/'tests/fixtures/work_command_vectors.json'
    command=json.loads(vector.read_text())['intent']['command']
    stamp=1800000000000
    grant=dict(**binding,version=2,iss='control',aud='enforcement',jti=str(uuid4()),purpose='work_command_prepare_authorize',
        requestId=pending.request_id,nonce=pending.nonce,challengeDigest=token_digest(challenge),issuedAtMs=stamp,
        rootDeadlineMs=stamp+300000,timing=policy,staging=staging(command).model_dump())
    return locals()

def ready(h):
    token=h['cp'].sign(h['grant'],purpose='work_command_prepare_authorize')
    h['pending'].accept_authorization(token,h['verifier'],issuer='control',audience='enforcement')
    h['clock'].step(100)
    proof=dict(bootId=h['clock'].boot,enforcerInstanceId=h['book'].instance_id,
        unitName='openbot-command-'+h['binding']['preparationId'].replace('-','')+'.service',invocationId='d'*32,
        cgroupPath='/system.slice/openbot-command-'+h['binding']['preparationId'].replace('-','')+'.service',cgroupInode=55,
        activeMonotonicUs=100001000,runtimeMaxUs=50000000,observedMonotonicUs=h['clock'].m,
        observedBoottimeUs=h['clock'].b,runtimeIdentityDigest='f'*64,runtimeShapeDigest='1'*64,
        timingPolicyDigest='e'*64,startAttempts=0)
    return h['pending'].ready(proof,h['ep'],audience='control')

def dispatch(h):
    proof=ready(h);stamp=h['stamp']+100
    binding=dict(**h['binding'],version=2,dispatchId=str(uuid4()),readinessDigest=token_digest(proof),hardDeadlineMs=h['stamp']+55000)
    claims=dict(**binding,purpose='work_command_dispatch',iss='control',aud='enforcement',jti=str(uuid4()),
        iat=stamp//1000,nbf=stamp//1000,exp=stamp//1000+25,anchors=dict(admittedAtMs=stamp,
            rootDeadlineMs=h['grant']['rootDeadlineMs'],nativeDeadlineMs=binding['hardDeadlineMs'],wallSeconds=60,
            hardDeadlineMs=binding['hardDeadlineMs'],deadlineProfileVersion=2))
    token=h['cp'].sign(claims,purpose='work_command_dispatch',now_ms=stamp)
    h['verifier'].verify_interval(token,purpose='work_command_dispatch',issuer='control',audience='enforcement',
        expected_binding=binding,pending=h['pending'])
    return token,binding

def test_causal_dispatch_permit_without_host_wall_clock():
    h=harness();ticket,binding=dispatch(h)
    pending=h['pending'].begin_consume();challenge=pending.consume_challenge(h['ep'],audience='control')
    stamp=h['stamp']+200
    claims=dict(**binding,purpose='work_command_permit',iss='control',aud='enforcement',jti=str(uuid4()),
        iat=stamp//1000,nbf=stamp//1000,exp=(stamp+5000)//1000,requestId=pending.request_id,nonce=pending.nonce,
        requestDigest=token_digest(challenge),consumedAtMs=stamp,launchDeadlineMs=stamp+5000)
    permit=h['cp'].sign(claims,purpose='work_command_permit',now_ms=stamp)
    args=dict(purpose='work_command_permit',issuer='control',audience='enforcement',expected_binding=binding,
        pending=pending,expected_request=dict(requestId=pending.request_id,nonce=pending.nonce))
    assert h['verifier'].verify_interval(permit,**args).value.consumedAtMs==stamp
    h['clock'].step(5000)
    with pytest.raises(ValueError):h['verifier'].verify_interval(permit,**args)

@pytest.mark.parametrize('mutation',['late','boot','suspend','wrong_nonce','wrong_challenge','wrong_policy','restart'])
def test_authorization_requires_original_live_challenge(mutation):
    h=harness();grant=deepcopy(h['grant'])
    if mutation=='late':h['clock'].step(5000)
    if mutation=='boot':h['clock'].boot=str(uuid4())
    if mutation=='suspend':h['clock'].b+=1000000
    if mutation=='wrong_nonce':grant['nonce']=base64.urlsafe_b64encode(bytes(32)).decode().rstrip('=')
    if mutation=='wrong_challenge':grant['challengeDigest']='2'*64
    if mutation=='wrong_policy':grant['timing']['clockRateErrorPpm']=999
    if mutation=='restart':h['book'].close()
    token=h['cp'].sign(grant,purpose='work_command_prepare_authorize')
    with pytest.raises(ValueError):h['pending'].accept_authorization(token,h['verifier'],issuer='control',audience='enforcement')

@pytest.mark.parametrize('mutation',['readiness','preparation','epoch','connection','profile','root','early','late'])
def test_dispatch_cannot_borrow_a_signed_timestamp(mutation):
    h=harness();ticket,binding=dispatch(h)
    from openbot_server.work_command_crypto import _parts
    claims=_parts(ticket)[1];stamp=h['stamp']+100
    if mutation in ('readiness','profile'):claims['readinessDigest' if mutation=='readiness' else 'profileDigest']='3'*64
    if mutation in ('preparation','connection'):claims[mutation+'Id']=str(uuid4())
    if mutation=='epoch':claims['originalEpoch']=2
    if mutation=='root':claims['anchors']['rootDeadlineMs']+=1000
    if mutation=='early':claims['anchors']['admittedAtMs']+=20000;claims['iat']=claims['nbf']=claims['anchors']['admittedAtMs']//1000;claims['exp']=claims['iat']+5;stamp=claims['anchors']['admittedAtMs']
    if mutation=='late':h['clock'].step(26000)
    token=h['cp'].sign(claims,purpose='work_command_dispatch',now_ms=stamp)
    expected={k:claims[k] for k in BindingV2.model_fields}
    if mutation=='early':
        # A causally valid Server may spend time before admission; its signed timestamp alone is
        # not rejected. It still must match the live original readiness and the fixed hard bound.
        h['verifier'].verify_interval(token,purpose='work_command_dispatch',issuer='control',audience='enforcement',expected_binding=expected,pending=h['pending'])
    else:
        with pytest.raises(ValueError):h['verifier'].verify_interval(token,purpose='work_command_dispatch',issuer='control',audience='enforcement',expected_binding=expected,pending=h['pending'])

def test_no_unit_replacement_and_no_unbound_time_interval():
    h=harness()
    with pytest.raises(ValueError):h['book'].begin_prepare(h['binding'])
    from openbot_server.work_command_v2_crypto import ServerTimeInterval
    with pytest.raises(ValueError):ServerTimeInterval(1,2,object()).check(None)
    with pytest.raises(ValueError):h['pending'].response_interval(None)

@pytest.mark.parametrize('size',[1,16384,16385])
def test_chunks_are_separately_bounded(size):
    h=harness();value=dict(type='work.command.input_chunk',protocolVersion='0.10.0',nodeId='node',requestId=str(uuid4()),
        preparationId=h['binding']['preparationId'],payload=dict(fileIndex=0,offset=0,data=base64.b64encode(b'x'*size).decode()))
    if size<=16384:assert parse_command_frame(value,server=True)==value
    else:
        with pytest.raises(ValueError):parse_command_frame(value,server=True)


def control(h,*,operation='lookup',include_output=False,with_dispatch=True):
    binding=None
    if with_dispatch:_,binding=dispatch(h)
    pending=h['book'].begin_control(h['binding'],request_id=str(uuid4()),operation=operation)
    challenge=pending.challenge(h['ep'],audience='control')
    value=dict(**h['binding'],version=2,iss='control',aud='enforcement',jti=str(uuid4()),purpose='work_command_control_request',
        challengeDigest=token_digest(challenge),requestId=pending.request_id,nonce=pending.nonce,
        issuedAtMs=h['stamp']+200,expiresAtMs=h['stamp']+10200,dispatch=binding,operation=operation)
    value.update(dict(includeOutput=include_output) if operation=='lookup' else dict(reason='cancel'))
    return pending,value


@pytest.mark.parametrize('operation',['lookup','stop'])
def test_control_requires_local_nonce_then_fixed_expiry(operation):
    h=harness();pending,value=control(h,operation=operation,include_output=True)
    token=h['cp'].sign(value,purpose='work_command_control_request')
    pending.accept_control(token,h['verifier'],issuer='control',audience='enforcement')
    assert pending.check_control().operation==operation
    if operation=='lookup':assert pending.check_control(require_output=True).includeOutput
    else:
        with pytest.raises(ValueError):pending.check_control(require_output=True)
    h['clock'].step(10000)
    with pytest.raises(ValueError):pending.check_control()

def test_finished_control_is_bounded_and_cannot_release_preparation_or_replay():
    h=harness();pending,value=control(h,include_output=False)
    with pytest.raises(ValueError):h['book'].finish_control(pending)
    token=h['cp'].sign(value,purpose='work_command_control_request')
    pending.accept_control(token,h['verifier'],issuer='control',audience='enforcement')
    h['book'].finish_control(pending)
    assert pending.closed and pending.request_id in h['book']._finished
    with pytest.raises(ValueError):pending.check_control()
    with pytest.raises(ValueError):h['book'].finish_control(pending)
    with pytest.raises(ValueError):
        h['book'].begin_control(h['binding'],request_id=pending.request_id,operation='lookup')
    prepare=next(iter(h['book']._pending.values()))
    with pytest.raises(ValueError):h['book'].finish_control(prepare)
    h['book']._finished={str(uuid4()) for _ in range(4096)}
    with pytest.raises(ValueError):
        h['book'].begin_control(h['binding'],request_id=str(uuid4()),operation='lookup')


@pytest.mark.parametrize('mutation',['late','nonce','request','digest','boot','suspend','restart','operation'])
def test_control_cannot_export_from_delayed_or_unbound_authorization(mutation):
    h=harness();pending,value=control(h,include_output=True)
    if mutation=='late':h['clock'].step(5000)
    if mutation=='nonce':value['nonce']=base64.urlsafe_b64encode(bytes(32)).decode().rstrip('=')
    if mutation=='request':value['requestId']=str(uuid4())
    if mutation=='digest':value['challengeDigest']='0'*64
    if mutation=='boot':h['clock'].boot=str(uuid4())
    if mutation=='suspend':h['clock'].b+=1000000
    if mutation=='restart':h['book'].close()
    if mutation=='operation':value.pop('includeOutput');value.update(operation='stop',reason='cancel')
    token=h['cp'].sign(value,purpose='work_command_control_request')
    with pytest.raises(ValueError):pending.accept_control(token,h['verifier'],issuer='control',audience='enforcement')


def test_lookup_output_scope_and_receipt_original_identity():
    h=harness();pending,value=control(h,include_output=False)
    token=h['cp'].sign(value,purpose='work_command_control_request')
    pending.accept_control(token,h['verifier'],issuer='control',audience='enforcement')
    with pytest.raises(ValueError):pending.check_control(require_output=True)
    observation=dict(phase='unknown',containerId=None,startAttempts=0,exitCode=None,sequence=1,
        runtimeShapeDigest=None,outputs=[],truncated=False)
    receipt=pending.receipt(observation,None,h['ep'],audience='control')
    record=h['verifier'].verify(receipt,purpose='work_command_receipt',issuer='enforcement',audience='control',
        expected_binding=value['dispatch'],expected_request=dict(requestId=value['requestId'],nonce=value['nonce']),now_ms=h['stamp']+200)
    assert record.dispatchId==value['dispatch']['dispatchId'] and record.originalEpoch==1
    altered=deepcopy(value);altered['dispatch']=None;altered['includeOutput']=True
    with pytest.raises(ValueError):h['cp'].sign(altered,purpose='work_command_control_request')
    altered=deepcopy(value);altered['reason']='cancel'
    with pytest.raises(ValueError):h['cp'].sign(altered,purpose='work_command_control_request')


@pytest.mark.parametrize('kind',['prepare_open','prepare_challenge','prepare_authorize','ready'])
def test_preparation_outer_request_is_original_uuid(kind):
    h=harness();payload=h['binding'] if kind=='prepare_open' else {'token':h['challenge']}
    value=dict(type='work.command.'+kind,protocolVersion='0.10.0',nodeId='node',requestId=h['binding']['preparationId'],
        preparationId=h['binding']['preparationId'],payload=payload)
    server=kind in ('prepare_open','prepare_authorize')
    assert parse_command_frame(value,server=server)==value
    value['requestId']=str(uuid4())
    with pytest.raises(ValueError):parse_command_frame(value,server=server)


def test_signed_preparation_cannot_change_inner_request_id():
    h=harness();grant=deepcopy(h['grant']);grant['requestId']=str(uuid4())
    with pytest.raises(ValueError):h['cp'].sign(grant,purpose='work_command_prepare_authorize')
    from openbot_server.work_command_crypto import _parts
    value=_parts(h['challenge'])[1];value['requestId']=str(uuid4())
    with pytest.raises(ValueError):h['ep'].sign(value,purpose='work_command_prepare_challenge')
