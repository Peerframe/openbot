"""Versioned command preparation and execution records; none grants Work authority."""
from typing import Annotated, Literal
import hashlib
from pydantic import Field, model_validator
from .work_command_contract import (
    Strict, Command, CommandBinding, DeadlineAnchors, DispatchClaims, ConsumeClaims, PermitClaims,
    ReceiptClaims, Identity, ActionIdentity, Uuid, Digest, Epoch, Positive, Nonce, Millis,
    CommandLimits, InputFile, OutputFile, CommandContractError, bounded_value, parse, SAFE_INTEGER)


def invalid(): raise CommandContractError('invalid_command_v2')


def token_digest(token):
    if type(token) is not str or not token.isascii() or len(token)>8192: invalid()
    return hashlib.sha256(token.encode('ascii')).hexdigest()


class TimingPolicy(Strict):
    prepareBudgetMs: Annotated[int, Field(ge=1, le=30000)]
    challengeBudgetMs: Annotated[int, Field(ge=1, le=5000)]
    runtimeMaxMs: Annotated[int, Field(ge=1, le=60000)]
    stopAllowanceMs: Annotated[int, Field(ge=1, le=5000)]
    clockRateErrorPpm: Annotated[int, Field(ge=0, le=10000)]
    clockQuantizationMs: Annotated[int, Field(ge=1, le=1000)]
    policyDigest: Digest

    def upper(self, ms):
        if type(ms) is not int or not 0<=ms<=SAFE_INTEGER//1000000: invalid()
        divisor=1000000-self.clockRateErrorPpm
        return (ms*1000000+divisor-1)//divisor+self.clockQuantizationMs

    def lower(self, ms):
        if type(ms) is not int or not 0<=ms<=SAFE_INTEGER//1000000: invalid()
        return max(0,ms*1000000//(1000000+self.clockRateErrorPpm)-self.clockQuantizationMs)

    def check_budget(self, start, root, wall):
        if (self.upper(self.runtimeMaxMs)+self.stopAllowanceMs>wall*1000
                or start+max(self.prepareBudgetMs,self.upper(self.challengeBudgetMs))
                +self.upper(self.runtimeMaxMs)+self.stopAllowanceMs>root): invalid()


class PreparationBinding(Strict):
    taskId: Identity
    runId: Identity
    actionId: ActionIdentity
    preparationId: Uuid
    connectionId: Uuid
    originalEpoch: Epoch
    authorityGeneration: Positive
    profileDigest: Digest
    intentDigest: Digest
    operationFingerprint: Digest
    nodeId: Identity
    providerId: Identity
    enforcementKeyId: Identity
    ledgerId: Uuid


class SignedPreparation(PreparationBinding):
    version: Literal[2]
    iss: Identity
    aud: Identity
    jti: Uuid


class PreparationExchange(SignedPreparation):
    requestId: Uuid
    @model_validator(mode='after')
    def original_request(self):
        if self.requestId!=self.preparationId: invalid()
        return self


class PreparationChallenge(PreparationExchange):
    purpose: Literal['work_command_prepare_challenge']
    requestId: Uuid
    nonce: Nonce
    bootId: Uuid
    enforcerInstanceId: Uuid
    createdBoottimeUs: Positive
    expiresBoottimeUs: Positive

    @model_validator(mode='after')
    def window(self):
        if not 0<self.expiresBoottimeUs-self.createdBoottimeUs<=5000000: invalid()
        return self


class Staging(Strict):
    image: Annotated[str, Field(min_length=1, max_length=256)]
    inputManifest: Annotated[list[InputFile], Field(max_length=8)]
    inputDigest: Annotated[str, Field(pattern=r'^sha256:[0-9a-f]{64}$')]
    output: OutputFile
    limits: CommandLimits
    network: Literal['none']
    rootfs: Literal['readonly']
    user: Literal['10001:10001']
    environment: Annotated[list, Field(max_length=0)]

    @model_validator(mode='after')
    def command_subset(self):
        parse(Command,dict(**self.model_dump(),argv=['/fixed-validation-placeholder']))
        return self


def staging(command):
    value=parse(Command,command).model_dump();value.pop('argv')
    return parse(Staging,value)


class PreparationAuthorization(PreparationExchange):
    purpose: Literal['work_command_prepare_authorize']
    requestId: Uuid
    nonce: Nonce
    challengeDigest: Digest
    issuedAtMs: Millis
    rootDeadlineMs: Millis
    timing: TimingPolicy
    staging: Staging

    @model_validator(mode='after')
    def budget(self):
        self.timing.check_budget(self.issuedAtMs,self.rootDeadlineMs,self.staging.limits.wallSeconds)
        return self


class NativeProof(Strict):
    bootId: Uuid
    enforcerInstanceId: Uuid
    unitName: Annotated[str, Field(pattern=r'^openbot-command-[0-9a-f]{32}\.service$')]
    invocationId: Annotated[str, Field(pattern=r'^[0-9a-f]{32}$')]
    cgroupPath: Annotated[str, Field(min_length=1, max_length=256, pattern=r'^/[A-Za-z0-9_.:-]+(?:/[A-Za-z0-9_.:-]+)*$')]
    cgroupInode: Positive
    activeMonotonicUs: Positive
    runtimeMaxUs: Annotated[int, Field(ge=1, le=60000000)]
    observedMonotonicUs: Positive
    observedBoottimeUs: Positive
    runtimeIdentityDigest: Digest
    runtimeShapeDigest: Digest
    timingPolicyDigest: Digest
    startAttempts: Annotated[int, Field(ge=0, le=0)]

    @model_validator(mode='after')
    def original(self):
        parts=self.cgroupPath.split('/')
        if (not self.cgroupPath.startswith('/') or any(p in ('','.','..') for p in parts[1:])
                or parts[-1]!=self.unitName or self.activeMonotonicUs>self.observedMonotonicUs
                or self.observedMonotonicUs>=self.activeMonotonicUs+self.runtimeMaxUs
                or self.observedBoottimeUs<self.observedMonotonicUs): invalid()
        return self


class Readiness(PreparationExchange):
    purpose: Literal['work_command_ready']
    requestId: Uuid
    nonce: Nonce
    authorizationDigest: Digest
    inputDigest: Annotated[str, Field(pattern=r'^sha256:[0-9a-f]{64}$')]
    proof: NativeProof

    @model_validator(mode='after')
    def unit(self):
        if self.proof.unitName!='openbot-command-'+self.preparationId.replace('-','')+'.service': invalid()
        return self


class BindingV2(CommandBinding):
    version: Literal[2]
    preparationId: Uuid
    readinessDigest: Digest


class AnchorsV2(DeadlineAnchors):
    deadlineProfileVersion: Literal[2]

    @model_validator(mode='after')
    def exact_upper_bound(self):
        if self.nativeDeadlineMs!=self.hardDeadlineMs: invalid()
        return self


class DispatchV2(DispatchClaims, BindingV2): anchors: AnchorsV2
class ConsumeV2(ConsumeClaims, BindingV2): pass
class PermitV2(PermitClaims, BindingV2): pass
class ReceiptV2(ReceiptClaims, BindingV2): pass


class ControlChallenge(SignedPreparation):
    purpose: Literal['work_command_control_challenge']
    operation: Literal['lookup','stop']
    requestId: Uuid
    nonce: Nonce
    bootId: Uuid
    enforcerInstanceId: Uuid
    createdBoottimeUs: Positive
    expiresBoottimeUs: Positive
    @model_validator(mode='after')
    def window(self):
        if not 0<self.expiresBoottimeUs-self.createdBoottimeUs<=5000000: invalid()
        return self


class ControlRequest(SignedPreparation):
    purpose: Literal['work_command_control_request']
    challengeDigest: Digest
    requestId: Uuid
    nonce: Nonce
    issuedAtMs: Millis
    expiresAtMs: Millis
    dispatch: BindingV2 | None

    @model_validator(mode='after')
    def bound(self):
        if not 0<self.expiresAtMs-self.issuedAtMs<=30000: invalid()
        if self.dispatch is not None:
            if any(getattr(self.dispatch,k)!=getattr(self,k) for k in PreparationBinding.model_fields): invalid()
        return self


class LookupRequest(ControlRequest):
    operation: Literal['lookup']
    includeOutput: bool
    @model_validator(mode='after')
    def output_scope(self):
        if self.includeOutput and self.dispatch is None: invalid()
        return self


class StopRequest(ControlRequest):
    operation: Literal['stop']
    reason: Literal['cancel','revoked','expired','source_changed','identity_changed','owned_cleanup']


MODELS={'work_command_control_challenge':ControlChallenge,'work_command_prepare_challenge':PreparationChallenge,
    'work_command_prepare_authorize':PreparationAuthorization,'work_command_ready':Readiness,
    'work_command_dispatch':DispatchV2,'work_command_consume':ConsumeV2,
    'work_command_permit':PermitV2,'work_command_receipt':ReceiptV2}
ROLES={'work_command_control_challenge':'enforcement','work_command_prepare_challenge':'enforcement','work_command_prepare_authorize':'control',
    'work_command_ready':'enforcement','work_command_dispatch':'control','work_command_consume':'enforcement',
    'work_command_permit':'control','work_command_receipt':'enforcement','work_command_control_request':'control'}
EXECUTION={'work_command_dispatch','work_command_consume','work_command_permit','work_command_receipt'}
TYPES={k:k.replace('_','-')+'-v2+'+('jwt' if k in EXECUTION else 'jws') for k in ROLES}


def claims(value,purpose):
    if purpose=='work_command_control_request':
        if type(value) is not dict or value.get('operation') not in ('lookup','stop'): invalid()
        model=LookupRequest if value['operation']=='lookup' else StopRequest
    else:
        model=MODELS.get(purpose)
        if model is None: invalid()
    bounded_value(value,maximum=8192)
    result=parse(model,value)
    if result.purpose!=purpose: invalid()
    return result


def validate_time(value,now_ms):
    if type(now_ms) is not int or not 1<=now_ms<=4102444800000: invalid()
    if value.purpose not in EXECUTION: return value
    if not value.nbf*1000<=now_ms<value.exp*1000 or value.iat*1000>now_ms: invalid()
    if value.purpose!='work_command_receipt' and now_ms>=value.hardDeadlineMs: invalid()
    if isinstance(value,DispatchV2) and now_ms<value.anchors.admittedAtMs: invalid()
    if isinstance(value,PermitV2) and not value.consumedAtMs<=now_ms<value.launchDeadlineMs: invalid()
    return value


def preparation_binding(value): return {k:getattr(value,k) for k in PreparationBinding.model_fields}
def execution_binding(value): return {k:getattr(value,k) for k in BindingV2.model_fields}
