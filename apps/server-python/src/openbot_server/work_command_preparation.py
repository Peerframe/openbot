"""Original approved preparation facts over existing Work/source/file/fence authority."""
from dataclasses import asdict
import time
from uuid import uuid4
from psycopg.types.json import Jsonb
from . import work_temporal_activity as temporal
from .work_claims import WorkFence
from .work_collaboration import root_deadline
from .work_command_actions import action_command, derive_action_operation as derive_operation
from .work_command_contract import operation_fingerprint, parse
from .work_command_v2_contract import (PreparationBinding,PreparationChallenge,PreparationAuthorization,Readiness,
    TimingPolicy,staging,preparation_binding,token_digest)
from .work_engine_binding import EngineActivityFacts
from .work_temporal_start import WorkRuntimeContext
from .work_values import WorkConflict,WorkNotFound,canonical


async def db_now(db):
    return (await (await db.execute('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).fetchone())['n']


class ServerPrepareClock:
    """One process's pending elapsed intervals; a restart never reconstructs them from SQL."""
    def __init__(self,*,sample=None,max_step_ms=100):
        if type(max_step_ms) is not int or not 1<=max_step_ms<=1000:raise ValueError('invalid_command_clock')
        self.max_step_ms=max_step_ms
        self.instance_id=str(uuid4());self.sample=sample or (lambda:(time.time_ns()//1000000,time.monotonic_ns()//1000000))
        self.pending={};self._origin=self.sample();self.broken=False
    def healthy(self):
        wall,mono=self.sample();ow,om=self._origin
        if type(wall) is not int or type(mono) is not int or mono<om or abs((wall-ow)-(mono-om))>self.max_step_ms+max(0,mono-om)//1000:
            self.broken=True
        if not self.broken:self._origin=(wall,mono)
        return not self.broken
    def begin(self,identity,db_wall):
        if not self.healthy() or identity in self.pending: raise WorkConflict('command_clock_changed')
        wall,mono=self.sample();self.pending[identity]=(db_wall,wall,mono)
    def check(self,identity,db_wall,policy,*,preparation=True):
        if not self.healthy() or identity not in self.pending: return False
        original,wall,mono=self.pending[identity];cw,cm=self.sample()
        elapsed=cm-mono
        # The bounded local SQL round-trip allowance cannot become a launch-token leeway.
        return (elapsed>=0 and (not preparation or elapsed<=policy.prepareBudgetMs and db_wall-original<=policy.prepareBudgetMs)
            and policy.lower(elapsed)<=db_wall-original<=policy.upper(elapsed)
            and policy.lower(elapsed)<=cw-wall<=policy.upper(elapsed))


class CommandPreparationMixin:
    async def start(self):
        if self._started:return
        async with self.store._transaction(trusted=True) as db:
            await db.execute("UPDATE work_command_preparations SET state='closed',closed_at_ms=%s,close_reason='restart' "
                "WHERE state IN ('reserved','authorized') AND server_instance_id<>%s",(await db_now(db),self.prepare_clock.instance_id))
        self._started=True
    def _ready_service(self):
        if not self._started:raise WorkConflict('command_preparation_unavailable')
    async def _clock_close(self,db):
        if self.prepare_clock.healthy():return False
        await db.execute("UPDATE work_command_preparations SET state='closed',closed_at_ms=%s,close_reason='clock_changed' "
            "WHERE state IN ('reserved','authorized') AND server_instance_id=%s",(await db_now(db),self.prepare_clock.instance_id))
        return True
    async def _prepare_row(self,db,action):
        row=await (await db.execute('SELECT * FROM work_command_preparations WHERE action_id=%s FOR UPDATE',(action['id'],))).fetchone()
        if not row:raise WorkNotFound()
        binding=parse(PreparationBinding,row['binding'])
        operation=derive_operation(action['intent'],task_id=action['task_id'],run_id=action['run_id'],action_id=action['id'],
            generation=action['authority_generation'],original_epoch=binding.originalEpoch,route=row['operation']['route']).model_dump()
        if (binding.taskId!=action['task_id'] or binding.runId!=action['run_id'] or binding.actionId!=action['id']
                or binding.preparationId!=str(row['preparation_id']) or row['task_id']!=action['task_id']
                or binding.intentDigest!=action['intent_digest'] or binding.authorityGeneration!=action['authority_generation']
                or operation!=row['operation'] or operation_fingerprint(operation)!=binding.operationFingerprint
                or any(getattr(binding,k)!=v for k,v in operation['route'].items())
                or binding.profileDigest!=operation['profileDigest']):raise WorkConflict('command_preparation_changed')
        return row,binding
    async def _prepare_authority(self,db,task,action,row,binding,live):
        self.store._active(task)
        proof=row['engine_proof']
        if type(proof) is not dict or set(proof)!={'facts','activityId','correctionContextId'}:raise WorkConflict('command_proof_changed')
        try:facts=EngineActivityFacts(**proof['facts'])
        except (TypeError,ValueError):raise WorkConflict('command_proof_changed') from None
        context=WorkRuntimeContext(task['id'],action['run_id'],task['bot_id'],task['objective'],task['token_limit'],proof['correctionContextId'])
        fence=WorkFence(action['run_id'],row['original_claim_id'],binding.originalEpoch)
        await self._sdk(db,context,facts,proof['activityId'],task,fence)
        if (action['status']!='proposed' or not action['requires_approval'] or action['decision']!='approved'
                or not action['unexpired'] or action['authority_generation']!=task['authority_generation']
                or action['correction_context_id']!=proof['correctionContextId']):raise WorkConflict('command_approval_required')
        profile,digest=await self.profiles.resolve_in_transaction(db,task)
        self._connection(live,profile,binding.connectionId)
        if digest!=binding.profileDigest:raise WorkConflict('command_profile_changed')
        command=self.profiles.check_command(profile,row['operation']['command'])
        await self.input_scope.revalidate_in_transaction(db,context,task,command.model_dump(),row['input_scope'])
        return context,fence,command
    async def reserve(self,context,action_id,*,fence,connection,command,attachments):
        self._ready_service()
        if type(context) is not WorkRuntimeContext:raise WorkConflict('command_context_required')
        info=temporal.activity_info();activity_id=temporal.current_activity_id(info)
        facts=await temporal.inspect_activity_start(self.client,info,**self.scope)
        async with self.input_scope.lock(),self.transport.guard(connection) as live:
            async with self.store._transaction(trusted=True) as db:
                task,action=await self.store._action(db,action_id);self.store._active(task)
                await self._sdk(db,context,facts,activity_id,task,fence)
                if (action['task_id']!=context.task_id or action['run_id']!=context.run_id or action['status']!='proposed'
                        or not action['requires_approval'] or action['decision']!='approved' or not action['unexpired']
                        or action['authority_generation']!=task['authority_generation'] or action['correction_context_id']!=context.correction_token):
                    raise WorkConflict('command_approval_required')
                existing=await (await db.execute('SELECT action_id FROM work_command_preparations WHERE action_id=%s',(action_id,))).fetchone()
                if existing:return dict(status='lookup_required')
                if await self._clock_close(db):return dict(status='denied',code='unavailable')
                profile,digest=await self.profiles.resolve_in_transaction(db,task);self._connection(live,profile)
                self.profiles.check_command(profile,command);intent=action_command(action['intent'])
                if (intent.command.model_dump()!=command or intent.profileDigest!=digest or action['reserved_tokens']!=0
                        or canonical(action['intent'])[1]!=action['intent_digest']):raise WorkConflict('command_intent_changed')
                operation=derive_operation(action['intent'],task_id=task['id'],run_id=action['run_id'],action_id=action_id,
                    generation=task['authority_generation'],original_epoch=fence.epoch,route=profile.route.model_dump())
                inputs=await self.input_scope.freeze_in_transaction(db,context,task,command,attachments)
                ancestry=task['_collaboration'];deadline=await root_deadline(db,ancestry['rootTaskId'],ancestry['rootWorkRunId'] or action['run_id'])
                claim=await (await db.execute('SELECT expires_at FROM work_claims WHERE run_id=%s AND claim_id=%s',(action['run_id'],fence.claim_id))).fetchone()
                expiry=min(int(action['expires_at'].timestamp()*1000),int(claim['expires_at'].timestamp()*1000))
                root=int(deadline.timestamp()*1000);current=await db_now(db)
                self.timing_policy.check_budget(current,min(root,expiry),intent.command.limits.wallSeconds)
                binding=parse(PreparationBinding,dict(taskId=task['id'],runId=action['run_id'],actionId=action_id,preparationId=str(uuid4()),
                    connectionId=live.connection_id,originalEpoch=fence.epoch,authorityGeneration=task['authority_generation'],profileDigest=digest,
                    intentDigest=action['intent_digest'],operationFingerprint=operation_fingerprint(operation.model_dump()),**profile.route.model_dump()))
                proof=dict(facts=asdict(facts),activityId=activity_id,correctionContextId=context.correction_token)
                await db.execute('INSERT INTO work_command_preparations(action_id,preparation_id,task_id,original_claim_id,binding,operation,'
                    'engine_proof,input_scope,timing,server_instance_id,root_deadline_ms,original_expiry_ms) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (action_id,binding.preparationId,task['id'],fence.claim_id,Jsonb(binding.model_dump()),Jsonb(operation.model_dump()),
                        Jsonb(proof),Jsonb(inputs),Jsonb(self.timing_policy.model_dump()),self.prepare_clock.instance_id,root,expiry))
                return dict(status='reserved',binding=binding.model_dump())
    async def authorize_preparation(self,connection,action_id,challenge_token):
        self._ready_service()
        async with self.input_scope.lock(),self.transport.guard(connection) as live:
            async with self.store._transaction(trusted=True) as db:
                task,action=await self.store._action(db,action_id);row,binding=await self._prepare_row(db,action)
                await self._prepare_authority(db,task,action,row,binding,live)
                if await self._clock_close(db):return dict(status='denied',code='unavailable')
                if row['state']!='reserved' or str(row['server_instance_id'])!=self.prepare_clock.instance_id:return dict(status='lookup_required')
                # Correlation values are authenticated by the pinned enforcement signature, never authority.
                from .work_command_crypto import _parts
                payload=_parts(challenge_token)[1]
                challenge=self.verifier.verify(challenge_token,purpose='work_command_prepare_challenge',issuer=self.enforcement_issuer,
                    audience=self.control_issuer,expected_binding=binding.model_dump(),expected_request={k:payload.get(k) for k in ('requestId','nonce')})
                policy=parse(TimingPolicy,row['timing'])
                if (policy!=self.timing_policy or challenge.expiresBoottimeUs-challenge.createdBoottimeUs!=policy.challengeBudgetMs*1000):
                    raise WorkConflict('command_timing_changed')
                current=await db_now(db)
                policy.check_budget(current,min(row['root_deadline_ms'],row['original_expiry_ms']),row['operation']['command']['limits']['wallSeconds'])
                self.prepare_clock.begin(binding.preparationId,current)
                value=dict(**binding.model_dump(),version=2,purpose='work_command_prepare_authorize',iss=self.control_issuer,aud=self.enforcement_issuer,
                    jti=str(uuid4()),requestId=challenge.requestId,nonce=challenge.nonce,challengeDigest=token_digest(challenge_token),
                    issuedAtMs=current,rootDeadlineMs=row['root_deadline_ms'],timing=policy.model_dump(),staging=staging(row['operation']['command']).model_dump())
                token=self.signer.sign(value,purpose='work_command_prepare_authorize')
                await db.execute("UPDATE work_command_preparations SET state='authorized',challenge_token=%s,authorization_token=%s,issued_at_ms=%s WHERE action_id=%s",
                    (challenge_token,token,current,action_id))
                if not self.prepare_clock.check(binding.preparationId,await db_now(db),policy):
                    await db.execute("UPDATE work_command_preparations SET state='closed',closed_at_ms=%s,close_reason='clock_changed' WHERE action_id=%s",(await db_now(db),action_id))
                    return dict(status='denied',code='expired')
            return dict(status='authorized',authorization=token)
    def _signed_preparation(self,row,binding):
        from .work_command_crypto import _parts
        challenge_payload=_parts(row['challenge_token'])[1]
        expected={k:challenge_payload.get(k) for k in ('requestId','nonce')}
        challenge=self.verifier.verify(row['challenge_token'],purpose='work_command_prepare_challenge',issuer=self.enforcement_issuer,
            audience=self.control_issuer,expected_binding=binding.model_dump(),expected_request=expected)
        grant=self.verifier.verify(row['authorization_token'],purpose='work_command_prepare_authorize',issuer=self.control_issuer,
            audience=self.enforcement_issuer,expected_binding=binding.model_dump(),expected_request=expected)
        if (grant.challengeDigest!=token_digest(row['challenge_token']) or grant.issuedAtMs!=row['issued_at_ms']
                or grant.rootDeadlineMs!=row['root_deadline_ms'] or grant.timing.model_dump()!=row['timing']
                or grant.staging!=staging(row['operation']['command']) or grant.timing!=self.timing_policy):raise WorkConflict('command_preparation_changed')
        return challenge,grant,expected
    def _checked_ready(self,row,binding,ready_token):
        challenge,grant,expected=self._signed_preparation(row,binding)
        ready=self.verifier.verify(ready_token,purpose='work_command_ready',issuer=self.enforcement_issuer,audience=self.control_issuer,
            expected_binding=binding.model_dump(),expected_request=expected)
        proof=ready.proof
        active_boot=proof.activeMonotonicUs+proof.observedBoottimeUs-proof.observedMonotonicUs
        if (ready.authorizationDigest!=token_digest(row['authorization_token']) or ready.inputDigest!=grant.staging.inputDigest
                or proof.bootId!=challenge.bootId or proof.enforcerInstanceId!=challenge.enforcerInstanceId
                or proof.runtimeMaxUs!=grant.timing.runtimeMaxMs*1000 or proof.timingPolicyDigest!=grant.timing.policyDigest
                or not challenge.createdBoottimeUs<=active_boot<challenge.expiresBoottimeUs):raise WorkConflict('command_readiness_changed')
        if row['ready_token'] is not None:
            expected_deadline=row['received_at_ms']+grant.timing.upper(grant.timing.runtimeMaxMs)+grant.timing.stopAllowanceMs
            if (row['native_deadline_ms']!=expected_deadline or row['readiness_digest']!=token_digest(row['ready_token'])
                    or not grant.issuedAtMs<=row['received_at_ms']<=grant.issuedAtMs+grant.timing.prepareBudgetMs
                    or expected_deadline>min(row['root_deadline_ms'],row['original_expiry_ms'])):
                raise WorkConflict('command_readiness_changed')
        return ready,grant
    async def accept_ready(self,connection,action_id,ready_token):
        self._ready_service()
        async with self.input_scope.lock(),self.transport.guard(connection) as live:
            async with self.store._transaction(trusted=True) as db:
                task,action=await self.store._action(db,action_id);row,binding=await self._prepare_row(db,action)
                await self._prepare_authority(db,task,action,row,binding,live)
                if row['state']=='ready':
                    if token_digest(ready_token)!=row['readiness_digest']:raise WorkConflict('command_readiness_changed')
                    self._checked_ready(row,binding,row['ready_token'])
                    return dict(status='ready',preparationId=binding.preparationId,hardDeadlineMs=row['native_deadline_ms'],readinessDigest=row['readiness_digest'])
                if row['state']!='authorized' or str(row['server_instance_id'])!=self.prepare_clock.instance_id:return dict(status='lookup_required')
                ready,grant=self._checked_ready(row,binding,ready_token);current=await db_now(db)
                if await self._clock_close(db) or not self.prepare_clock.check(binding.preparationId,current,grant.timing):
                    await db.execute("UPDATE work_command_preparations SET state='closed',closed_at_ms=%s,close_reason='expired' WHERE action_id=%s",(current,action_id))
                    return dict(status='denied',code='expired')
                deadline=current+grant.timing.upper(grant.timing.runtimeMaxMs)+grant.timing.stopAllowanceMs
                if deadline>min(row['root_deadline_ms'],row['original_expiry_ms']):raise WorkConflict('command_deadline_expired')
                digest=token_digest(ready_token)
                await db.execute("UPDATE work_command_preparations SET state='ready',ready_token=%s,readiness_digest=%s,received_at_ms=%s,native_deadline_ms=%s WHERE action_id=%s",
                    (ready_token,digest,current,deadline,action_id))
            return dict(status='ready',preparationId=binding.preparationId,hardDeadlineMs=deadline,readinessDigest=digest)
