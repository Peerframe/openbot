"""Synthetic v2 records for the actual TS control adapter; no SQL admission or native execution."""
import json
import sys
from uuid import uuid4
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"src"))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption
from openbot_server.work_command_crypto import VerificationPin, _parts
from openbot_server.work_command_v2_crypto import CommandV2Signer, CommandV2Verifier
from openbot_server.work_command_v2_contract import ROLES, EXECUTION, preparation_binding, execution_binding, claims, token_digest
from test_work_command_v2 import harness, ready, dispatch


def generate():
    h=harness()
    records=[_parts(h['challenge'])[1],h['grant'],_parts(ready(h))[1]]
    h=harness();ticket,binding=dispatch(h)
    pending=h['pending'].begin_consume();consume=pending.consume_challenge(h['ep'],audience='control')
    stamp=h['stamp']+200
    permit=dict(**binding,purpose='work_command_permit',iss='control',aud='enforcement',jti=str(uuid4()),
        iat=stamp//1000,nbf=stamp//1000,exp=(stamp+5000)//1000,requestId=pending.request_id,nonce=pending.nonce,
        requestDigest=token_digest(consume),consumedAtMs=stamp,launchDeadlineMs=stamp+5000)
    records.extend([_parts(ticket)[1],_parts(consume)[1],permit])
    for operation in ('lookup','stop'):
        control=h['book'].begin_control(h['binding'],request_id=str(uuid4()),operation=operation)
        challenge=control.challenge(h['ep'],audience='control')
        request=dict(**h['binding'],version=2,iss='control',aud='enforcement',jti=str(uuid4()),purpose='work_command_control_request',
            challengeDigest=token_digest(challenge),requestId=control.request_id,nonce=control.nonce,
            issuedAtMs=stamp,expiresAtMs=stamp+10000,dispatch=binding,operation=operation)
        request.update(dict(includeOutput=True) if operation=='lookup' else dict(reason='cancel'))
        records.extend([_parts(challenge)[1],request])
        if operation=='lookup':
            token=h['cp'].sign(request,purpose='work_command_control_request')
            control.accept_control(token,h['verifier'],issuer='control',audience='enforcement')
            receipt=control.receipt(dict(phase='exited',containerId='f'*64,startAttempts=1,exitCode=0,sequence=2,
                runtimeShapeDigest='1'*64,outputs=[],truncated=False),'d'*64,h['ep'],audience='control')
            records.append(_parts(receipt)[1])
    keys={}
    for role in ('control','enforcement'):
        key=Ed25519PrivateKey.generate()
        keys[role]=dict(privatePem=key.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption()).decode(),
            publicPem=key.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo).decode(),
            issuer=role,kid='control-1' if role=='control' else 'enforcer-1',role=role)
    vectors=[]
    for value in records:
        purpose=value['purpose'];key=keys[ROLES[purpose]]
        signer=CommandV2Signer(issuer=key['issuer'],kid=key['kid'],role=key['role'],private_pem=key['privatePem'].encode())
        token=signer.sign(value,purpose=purpose,now_ms=stamp)
        parsed=claims(value,purpose)
        vectors.append(dict(value=value,token=token,options=dict(purpose=purpose,issuer=value['iss'],audience=value['aud'],
            binding=execution_binding(parsed) if purpose in EXECUTION else preparation_binding(parsed),nowMs=stamp,
            **({} if purpose=='work_command_dispatch' else dict(request=dict(requestId=value['requestId'],nonce=value['nonce']))))))
    return dict(keys=list(keys.values()),vectors=vectors)


def verify(data):
    verifier=CommandV2Verifier([VerificationPin(k['issuer'],k['kid'],k['role'],k['publicPem'].encode()) for k in data['keys']])
    for item in data['vectors']:
        opts=item['options']
        actual=verifier.verify(item['tsToken'],purpose=opts['purpose'],issuer=opts['issuer'],audience=opts['audience'],
            expected_binding=opts['binding'],now_ms=opts['nowMs'],expected_request=opts.get('request'))
        if actual.model_dump()!=item['value']:raise ValueError('command_control_interop_changed')
    return dict(verified=len(data['vectors']))


if __name__=='__main__':
    print(json.dumps(generate() if sys.argv[1]=='generate' else verify(json.load(sys.stdin))))
