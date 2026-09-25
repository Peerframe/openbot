"""Thin v2 schema/time adapter over the existing JOSE key, strict parsing and registry core."""
from dataclasses import dataclass, field
import secrets
import time
from uuid import uuid4
from joserfc import jws
from .work_command_crypto import TokenSigner, TokenVerifier, _parts, _registry, _identity
from .work_command_contract import bounded_value, strict_json, parse, Uuid, Nonce, CommandContractError
from .work_command_v2_contract import (claims, validate_time, ROLES, TYPES, EXECUTION, PreparationBinding,
    BindingV2, TimingPolicy, PreparationAuthorization, Readiness, DispatchV2, PermitV2, PreparationChallenge,
    token_digest, invalid, preparation_binding, execution_binding,LookupRequest,ControlRequest)

_SEAL=object()

@dataclass(frozen=True)
class VerifiedRecord:
    value: object
    digest: str
    _seal: object=field(repr=False)

@dataclass(frozen=True)
class ServerTimeInterval:
    lower_ms: int
    upper_ms: int
    _seal: object=field(repr=False)
    def check(self,value):
        if self._seal is not _SEAL or self.lower_ms>self.upper_ms: invalid()
        validate_time(value,self.lower_ms);validate_time(value,self.upper_ms)
        return value

class CommandV2Signer(TokenSigner):
    def sign(self,value,*,purpose,now_ms=None):
        try:
            if ROLES.get(purpose)!=self.role: invalid()
            record=claims(value,purpose)
            if purpose in EXECUTION: validate_time(record,now_ms)
            if record.iss!=self.issuer or self.role=='enforcement' and record.enforcementKeyId!=self.kid: invalid()
            token=jws.serialize_compact({'alg':'Ed25519','typ':TYPES[purpose],'kid':self.kid},
                bounded_value(record.model_dump(),maximum=8192),self._key,registry=_registry())
            _parts(token)
            return token
        except Exception: raise CommandContractError('invalid_command_token') from None

    def sign_interval(self,value,*,purpose,pending):
        if type(pending) is not PendingExchange or purpose not in ('work_command_consume','work_command_receipt'): invalid()
        record=claims(value,purpose)
        pending.interval().check(record)
        if (execution_binding(record)!=pending.binding or record.requestId!=pending.request_id or record.nonce!=pending.nonce): invalid()
        return self.sign(value,purpose=purpose,now_ms=pending.interval().lower_ms)

class CommandV2Verifier(TokenVerifier):
    def _verified(self,token,*,purpose,issuer,audience,expected_binding,expected_request=None):
        """Only schema/signature internals; public execution verification must add time authority."""
        try:
            if purpose not in ROLES: invalid()
            _identity(issuer);_identity(audience)
            binding=parse(BindingV2 if purpose in EXECUTION else PreparationBinding,expected_binding)
            header,payload=_parts(token)
            if header['typ']!=TYPES[purpose]: invalid()
            pin=self._pins.get((issuer,header['kid']))
            if pin is None or pin.role!=ROLES[purpose]: invalid()
            decoded=jws.deserialize_compact(token,pin._key,registry=_registry())
            if strict_json(decoded.payload,maximum=8192)!=payload: invalid()
            record=claims(payload,purpose)
            if record.iss!=issuer or record.aud!=audience or pin.role=='enforcement' and record.enforcementKeyId!=pin.kid: invalid()
            if any(getattr(record,k)!=v for k,v in binding.model_dump().items()): invalid()
            if purpose=='work_command_dispatch':
                if expected_request is not None: invalid()
            elif (type(expected_request) is not dict or set(expected_request)!={'requestId','nonce'}
                    or record.requestId!=expected_request['requestId'] or record.nonce!=expected_request['nonce']): invalid()
            return VerifiedRecord(record,token_digest(token),_SEAL)
        except Exception: raise CommandContractError('invalid_command_token') from None

    def verify_record(self,token,*,purpose,issuer,audience,expected_binding,now_ms=None,expected_request=None):
        record=self._verified(token,purpose=purpose,issuer=issuer,audience=audience,
            expected_binding=expected_binding,expected_request=expected_request)
        if purpose in EXECUTION: validate_time(record.value,now_ms)
        return record

    def verify(self,token,**kwargs): return self.verify_record(token,**kwargs).value

    def verify_interval(self,token,*,purpose,issuer,audience,expected_binding,pending,expected_request=None):
        if type(pending) is not PendingExchange or purpose not in ('work_command_dispatch','work_command_permit'): invalid()
        record=self._verified(token,purpose=purpose,issuer=issuer,audience=audience,
            expected_binding=expected_binding,expected_request=expected_request)
        pending.response_interval(record).check(record.value)
        return record

class HostExchangeBook:
    """Protected local live-request state. Caller-supplied DTOs cannot mint time intervals.

    clock returns (monotonic_us, boottime_us, boot_id). The injected clock is trusted composition,
    not a field on the wire. Production host uses actual native clocks and the actual boot ID.
    """
    def __init__(self,*,policy,clock,instance_id=None):
        self.policy=parse(TimingPolicy,policy)
        if not callable(clock): invalid()
        self.clock=clock;self.instance_id=instance_id or str(uuid4());self._pending={};self._finished=set();self._closed=False
    def _sample(self):
        value=self.clock()
        if (type(value) is not tuple or len(value)!=3 or any(type(x) is not int or x<=0 for x in value[:2])
                or value[1]<value[0]): invalid()
        from pydantic import TypeAdapter
        TypeAdapter(Uuid).validate_python(value[2],strict=True)
        return value
    def begin_prepare(self,binding):
        if self._closed or len(self._pending)>=64: invalid()
        binding=parse(PreparationBinding,binding).model_dump();key=binding['actionId']
        if key in self._pending: invalid()
        record=PendingExchange(self,'prepare',binding,self._sample(),_SEAL)
        self._pending[key]=record
        return record
    def begin_control(self,binding,*,request_id,operation):
        from pydantic import TypeAdapter
        TypeAdapter(Uuid).validate_python(request_id,strict=True)
        if (self._closed or len(self._pending)>=64 or len(self._finished)+len(self._pending)>=4096
                or operation not in ('lookup','stop') or request_id in self._pending or request_id in self._finished): invalid()
        binding=parse(PreparationBinding,binding).model_dump()
        record=PendingExchange(self,operation,binding,self._sample(),_SEAL);record.request_id=request_id
        self._pending[request_id]=record
        return record
    def finish_control(self,record):
        # Only a consumed control can release its live slot. Retain request IDs to reject
        # replay in this Host instance; never release an original preparation reservation.
        if (self._closed or type(record) is not PendingExchange or record.book is not self
                or record.kind not in ('lookup','stop') or record.control is None
                or self._pending.get(record.request_id) is not record or len(self._finished)>=4096):invalid()
        record.check_control()
        self._finished.add(record.request_id)
        del self._pending[record.request_id]
        record.closed=True
    def close(self):
        self._closed=True
        for item in self._pending.values(): item.closed=True

class PendingExchange:
    def __init__(self,book,kind,binding,sample,seal):
        if seal is not _SEAL: invalid()
        self.book,self.kind,self.binding,self.start=book,kind,binding,sample
        self.request_id,self.nonce=(binding['preparationId'] if kind=='prepare' else str(uuid4())),secrets.token_urlsafe(32)
        self.closed=False;self.challenge_digest=None;self.authorization=None;self.authorization_digest=None
        self.readiness_digest=None;self.anchor=None;self.request_digest=None;self.dispatch=None;self.control=None
    def _live(self):
        if self.closed or self.book._closed: invalid()
        current=self.book._sample()
        if current[2]!=self.start[2] or current[0]<self.start[0] or current[1]<self.start[1]: invalid()
        # Suspend invalidates pending preparation/launch. Runtime suspend qualification is separate.
        if abs((current[1]-current[0])-(self.start[1]-self.start[0]))>self.book.policy.clockQuantizationMs*1000: invalid()
        return current
    def _base(self,signer,audience,purpose):
        return {**self.binding,'version':2,'purpose':purpose,'iss':signer.issuer,'aud':audience,'jti':str(uuid4()),
            'requestId':self.request_id,'nonce':self.nonce}
    def challenge(self,signer,*,audience):
        if self.kind not in ('prepare','lookup','stop') or self.challenge_digest is not None: invalid()
        self._live()
        purpose='work_command_prepare_challenge' if self.kind=='prepare' else 'work_command_control_challenge'
        value=dict(**self._base(signer,audience,purpose),bootId=self.start[2],
            enforcerInstanceId=self.book.instance_id,createdBoottimeUs=self.start[1],
            expiresBoottimeUs=self.start[1]+self.book.policy.challengeBudgetMs*1000)
        if self.kind!='prepare':value['operation']=self.kind
        token=signer.sign(value,purpose=purpose)
        self.challenge_digest=token_digest(token)
        return token
    def accept_authorization(self,token,verifier,*,issuer,audience):
        if self.kind!='prepare' or self.authorization is not None or self.challenge_digest is None: invalid()
        record=verifier.verify_record(token,purpose='work_command_prepare_authorize',issuer=issuer,audience=audience,
            expected_binding=self.binding,expected_request=dict(requestId=self.request_id,nonce=self.nonce))
        value=record.value;current=self._live()
        if (current[1]-self.start[1]>=self.book.policy.challengeBudgetMs*1000
                or value.challengeDigest!=self.challenge_digest or value.timing!=self.book.policy): invalid()
        self.authorization=value;self.authorization_digest=record.digest
        self.anchor=(value.issuedAtMs,self.start,current)
        return record
    def ready(self,proof,signer,*,audience):
        if self.authorization is None or self.readiness_digest is not None: invalid()
        current=self._live()
        value=dict(**self._base(signer,audience,'work_command_ready'),authorizationDigest=self.authorization_digest,
            inputDigest=self.authorization.staging.inputDigest,proof=proof)
        parsed=claims(value,'work_command_ready')
        if (parsed.proof.bootId!=self.start[2] or parsed.proof.enforcerInstanceId!=self.book.instance_id
                or parsed.proof.runtimeMaxUs!=self.book.policy.runtimeMaxMs*1000
                or parsed.proof.timingPolicyDigest!=self.book.policy.policyDigest
                or parsed.proof.observedMonotonicUs>current[0] or parsed.proof.observedBoottimeUs>current[1]): invalid()
        active_boot=parsed.proof.activeMonotonicUs+parsed.proof.observedBoottimeUs-parsed.proof.observedMonotonicUs
        if not self.start[1]<=active_boot<self.start[1]+self.book.policy.challengeBudgetMs*1000: invalid()
        token=signer.sign(value,purpose='work_command_ready');self.readiness_digest=token_digest(token)
        return token
    def interval(self):
        if self.anchor is None: invalid()
        current=self._live();tc,origin,received=self.anchor
        upper=tc+self.book.policy.upper((current[1]-origin[1]+999)//1000)
        lower=tc+self.book.policy.lower((current[1]-received[1])//1000)
        return ServerTimeInterval(lower,upper,_SEAL)
    def response_interval(self,record):
        if type(record) is not VerifiedRecord or record._seal is not _SEAL: invalid()
        current=self._live();value=record.value
        if isinstance(value,DispatchV2):
            if (self.kind!='prepare' or self.authorization is None or self.readiness_digest is None
                    or preparation_binding(value)!=self.binding or value.readinessDigest!=self.readiness_digest
                    or value.anchors.rootDeadlineMs!=self.authorization.rootDeadlineMs): invalid()
            tc=value.anchors.admittedAtMs
        elif isinstance(value,PermitV2):
            if (self.kind!='consume' or self.request_digest is None or execution_binding(value)!=self.binding
                    or (value.requestId,value.nonce)!=(self.request_id,self.nonce)
                    or value.requestDigest!=self.request_digest): invalid()
            tc=value.consumedAtMs
        else: invalid()
        # The nonce was emitted before this causally bound Control response was produced.
        self.anchor=(tc,self.start,current)
        interval=self.interval();interval.check(value)
        if isinstance(value,DispatchV2): self.dispatch=record
        return interval
    def begin_consume(self):
        if self.kind!='prepare' or self.dispatch is None: invalid()
        self.interval().check(self.dispatch.value)
        result=PendingExchange(self.book,'consume',execution_binding(self.dispatch.value),self._live(),_SEAL)
        result.anchor=self.anchor;result.dispatch=self.dispatch
        self.closed=True
        return result
    def consume_challenge(self,signer,*,audience):
        if self.kind!='consume' or self.request_digest is not None or self.dispatch is None: invalid()
        interval=self.interval();iat=interval.lower_ms//1000
        value=dict(**self._base(signer,audience,'work_command_consume'),iat=iat,nbf=iat,
            exp=min(iat+30,self.binding['hardDeadlineMs']//1000),ticketDigest=self.dispatch.digest)
        token=signer.sign_interval(value,purpose='work_command_consume',pending=self)
        self.request_digest=token_digest(token)
        return token

    def accept_control(self,token,verifier,*,issuer,audience):
        if self.kind not in ('lookup','stop') or self.control is not None or self.challenge_digest is None: invalid()
        record=verifier.verify_record(token,purpose='work_command_control_request',issuer=issuer,audience=audience,
            expected_binding=self.binding,expected_request=dict(requestId=self.request_id,nonce=self.nonce))
        value=record.value;current=self._live()
        if (current[1]-self.start[1]>=self.book.policy.challengeBudgetMs*1000 or value.operation!=self.kind
                or value.challengeDigest!=self.challenge_digest): invalid()
        self.anchor=(value.issuedAtMs,self.start,current);self.control=record
        self.check_control()
        return record
    def check_control(self,*,require_output=False):
        if self.control is None or self.kind not in ('lookup','stop'): invalid()
        value=self.control.value;interval=self.interval()
        if (interval.lower_ms<value.issuedAtMs or interval.upper_ms>=value.expiresAtMs
                or require_output and (not isinstance(value,LookupRequest) or not value.includeOutput)): invalid()
        return value
    def receipt(self,observation,permit_digest,signer,*,audience):
        value=self.check_control()
        if not isinstance(value,LookupRequest) or value.dispatch is None: invalid()
        interval=self.interval();iat=interval.lower_ms//1000
        result={**value.dispatch.model_dump(),'iss':signer.issuer,'aud':audience,'jti':str(uuid4()),
            'purpose':'work_command_receipt','requestId':self.request_id,'nonce':self.nonce,'iat':iat,'nbf':iat,
            'exp':min(iat+30,value.expiresAtMs//1000),'permitDigest':permit_digest,'observation':observation}
        interval.check(claims(result,'work_command_receipt'))
        return signer.sign(result,purpose='work_command_receipt',now_ms=interval.lower_ms)
