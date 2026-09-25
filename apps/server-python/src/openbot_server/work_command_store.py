"""One Work admission, one original dispatch, one online consumption. Feature is unregistered.

Transport.guard owns the existing registry identity lock and yields the current socket facts.
Admission requires the original persistent ready row and its signed native proof. Product
composition must authenticate the protected enforcement inbox before enabling commands.
"""
from dataclasses import asdict, dataclass
import hashlib
from uuid import uuid4

from psycopg.types.json import Jsonb

from . import work_temporal_activity as temporal
from .work_claims import WorkFence, check_fence
from .work_collaboration import root_deadline
from .work_command_contract import (bounded_value, operation_fingerprint, parse)
from .work_command_actions import action_command, derive_action_operation as derive_operation
from .work_command_v2_contract import (BindingV2 as CommandBinding, DispatchV2 as DispatchClaims, PermitV2 as PermitClaims,
    AnchorsV2, TimingPolicy)
from .work_command_preparation import CommandPreparationMixin, ServerPrepareClock
from .work_command_inputs import CommandInputScope
from .work_command_control import CommandControlMixin
from .work_corrections import check_context
from .work_engine_binding import EngineActivityFacts, assert_accepted_workflow_in_transaction
from .work_temporal_start import WorkRuntimeContext
from .work_values import WorkConflict, WorkNotFound, canonical


@dataclass(frozen=True)
class LiveCommandConnection:
    node_id: str
    connection_id: str
    credential_digest: str


async def now_ms(db):
    return (await (await db.execute('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).fetchone())['n']


def sha(value):
    return hashlib.sha256(value.encode('ascii')).hexdigest()


def binding_of(claims):
    return {k:claims[k] for k in CommandBinding.model_fields}


class CommandDispatches(CommandPreparationMixin, CommandControlMixin):
    def __init__(self, store, profiles, client, scope, transport, signer, verifier, *, control_issuer, enforcement_issuer, input_scope, timing_policy, prepare_clock):
        if (set(scope) != {'expected_namespace','expected_queue','expected_workflow_type'}
                or type(input_scope) is not CommandInputScope or not callable(getattr(transport,'guard',None)) or signer.issuer != control_issuer or signer.role != 'control'):
            raise ValueError('command_composition_required')
        self.store,self.profiles,self.client,self.scope=store,profiles,client,dict(scope)
        self.transport,self.signer,self.verifier=transport,signer,verifier
        self.input_scope=input_scope
        self.control_issuer,self.enforcement_issuer=control_issuer,enforcement_issuer
        from .work_command_v2_crypto import CommandV2Signer, CommandV2Verifier
        if type(signer) is not CommandV2Signer or type(verifier) is not CommandV2Verifier or type(prepare_clock) is not ServerPrepareClock:
            raise ValueError('command_v2_composition_required')
        self.timing_policy=parse(TimingPolicy,timing_policy);self.prepare_clock=prepare_clock;self._started=False
        if prepare_clock.max_step_ms>self.timing_policy.clockQuantizationMs:raise ValueError('command_clock_budget_required')

    async def _sdk(self, db, context, facts, activity_id, task, fence):
        if type(context) is not WorkRuntimeContext:
            raise WorkConflict('command_context_required')
        accepted = await assert_accepted_workflow_in_transaction(self.store,db,
            dict(taskId=context.task_id,runId=context.run_id),facts,**self.scope)
        expected = temporal.derive_claim_id(accepted.namespace,accepted.workflow_id,accepted.engine_run_id,activity_id)
        if (context.task_id != task['id'] or context.bot_id != task['bot_id'] or context.objective != task['objective']
                or context.token_limit != task['token_limit'] or fence.claim_id != expected):
            raise WorkConflict('command_context_changed')
        await check_context(db,task,context.run_id,context.correction_token)
        await check_fence(db,context.run_id,fence)

    @staticmethod
    def _connection(live, profile, expected_id=None):
        if (type(live) is not LiveCommandConnection or live.node_id != profile.route.nodeId
                or live.credential_digest != profile.credentialDigest
                or expected_id is not None and live.connection_id != expected_id):
            raise WorkConflict('command_connection_changed')

    async def admit(self, context, action_id, *, fence, connection, preparation_id):
        """The caller already staged bounded inputs/runtime. No I/O effect occurs here.

        Returns a fixed ticket only for the new WorkStore.admit winner after commit. Repeated
        admission returns lookup_required, and cannot remint an epoch/dispatch/expiration.
        """
        if type(context) is not WorkRuntimeContext:
            raise WorkConflict('command_context_required')
        self._ready_service()
        if not self.prepare_clock.healthy():raise WorkConflict('command_clock_changed')
        from .work_command_contract import Uuid
        from pydantic import TypeAdapter
        try: TypeAdapter(Uuid).validate_python(preparation_id,strict=True)
        except Exception: raise WorkConflict('command_preparation_required') from None
        info = temporal.activity_info()
        activity_id = temporal.current_activity_id(info)
        facts = await temporal.inspect_activity_start(self.client,info,**self.scope)
        result = None
        async with self.input_scope.lock(), self.transport.guard(connection) as live:
            async def admission(db, task, action):
                nonlocal result
                if ((action['task_id'],action['run_id']) != (context.task_id,context.run_id)
                        or action['correction_context_id'] != context.correction_token):
                    raise WorkConflict('command_context_changed')
                await self._sdk(db,context,facts,activity_id,task,fence)
                if not action['requires_approval'] or action['decision']!='approved':
                    raise WorkConflict('command_approval_required')
                preparation,pbinding=await self._prepare_row(db,action)
                if (preparation['state']!='ready' or pbinding.preparationId!=preparation_id or pbinding.originalEpoch!=fence.epoch
                        or preparation['original_claim_id']!=fence.claim_id):raise WorkConflict('command_preparation_required')
                self._checked_ready(preparation,pbinding,preparation['ready_token'])
                if sha(preparation['ready_token'])!=preparation['readiness_digest']:raise WorkConflict('command_readiness_changed')
                input_receipt=preparation['input_scope']
                if not action['requires_approval'] or action['decision']!='approved':
                    raise WorkConflict('command_approval_required')
                profile,digest = await self.profiles.resolve_in_transaction(db,task)
                self._connection(live,profile,pbinding.connectionId)
                intent = action_command(action['intent'])
                command = self.profiles.check_command(profile,intent.command.model_dump())
                if (intent.profileDigest != digest or input_receipt.get('inputDigest') != command.inputDigest
                        or action['reserved_tokens'] != 0 or canonical(action['intent'])[1] != action['intent_digest']):
                    raise WorkConflict('command_intent_changed')
                await self.input_scope.revalidate_in_transaction(db,context,task,command.model_dump(),input_receipt)
                operation = derive_operation(action['intent'],task_id=task['id'],run_id=action['run_id'],action_id=action['id'],
                    generation=task['authority_generation'],original_epoch=fence.epoch,route=profile.route.model_dump())
                if (pbinding.actionId!=action['id'] or pbinding.originalEpoch!=fence.epoch
                        or pbinding.operationFingerprint!=operation_fingerprint(operation.model_dump())):
                    raise WorkConflict('command_preparation_changed')
                ancestry = task['_collaboration']
                deadline = await root_deadline(db,ancestry['rootTaskId'],ancestry['rootWorkRunId'] or action['run_id'])
                admitted = await now_ms(db)
                if not self.prepare_clock.check(preparation_id,admitted,self.timing_policy,preparation=False):raise WorkConflict('command_clock_changed')
                anchors = parse(AnchorsV2,dict(admittedAtMs=admitted,rootDeadlineMs=int(deadline.timestamp()*1000),
                    nativeDeadlineMs=preparation['native_deadline_ms'],wallSeconds=command.limits.wallSeconds,
                    hardDeadlineMs=preparation['native_deadline_ms'],deadlineProfileVersion=2))
                if anchors.rootDeadlineMs!=preparation['root_deadline_ms'] or anchors.hardDeadlineMs>preparation['original_expiry_ms']:
                    raise WorkConflict('command_native_deadline_unbounded')
                binding = dict(version=2,preparationId=preparation_id,readinessDigest=preparation['readiness_digest'],taskId=task['id'],runId=action['run_id'],actionId=action['id'],dispatchId=str(uuid4()),
                    connectionId=live.connection_id,originalEpoch=fence.epoch,authorityGeneration=task['authority_generation'],
                    profileDigest=digest,intentDigest=action['intent_digest'],operationFingerprint=operation_fingerprint(operation.model_dump()),
                    **profile.route.model_dump(),hardDeadlineMs=anchors.hardDeadlineMs)
                claim_row=await (await db.execute('SELECT expires_at FROM work_claims WHERE run_id=%s AND claim_id=%s',
                    (action['run_id'],fence.claim_id))).fetchone()
                ticket_expiry=min(admitted//1000+30,anchors.hardDeadlineMs//1000,
                    int(action['expires_at'].timestamp()),int(claim_row['expires_at'].timestamp()))
                claims = parse(DispatchClaims,dict(**binding,iss=self.control_issuer,aud=self.enforcement_issuer,jti=str(uuid4()),
                    iat=admitted//1000,nbf=admitted//1000,exp=ticket_expiry,
                    purpose='work_command_dispatch',anchors=anchors.model_dump())).model_dump()
                ticket = self.signer.sign(claims,purpose='work_command_dispatch',now_ms=admitted)
                proof = dict(facts=asdict(facts),activityId=activity_id,correctionContextId=context.correction_token)
                bounded_value(proof)
                await db.execute('INSERT INTO work_command_dispatches(action_id,dispatch_id,task_id,original_claim_id,original_epoch,'
                    'authority_generation,connection_id,intent_digest,operation_fingerprint,operation,dispatch_claims,ticket_digest,'
                    'engine_proof,input_scope,issued_at_ms,expires_at_ms,root_deadline_ms,native_deadline_ms,hard_deadline_ms,preparation_id,readiness_digest) '
                    'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (action['id'],binding['dispatchId'],task['id'],fence.claim_id,fence.epoch,task['authority_generation'],live.connection_id,
                    action['intent_digest'],binding['operationFingerprint'],Jsonb(operation.model_dump()),Jsonb(claims),sha(ticket),Jsonb(proof),Jsonb(input_receipt),
                    admitted,claims['exp']*1000,anchors.rootDeadlineMs,anchors.nativeDeadlineMs,anchors.hardDeadlineMs,preparation_id,preparation['readiness_digest']))
                # Fixed anchors include all preparation latency; slow commit cannot refresh the ticket.
                if await now_ms(db) >= claims['exp']*1000: raise WorkConflict('command_deadline_expired')
                result = dict(status='issued',ticket=ticket,operation=operation.model_dump())
                return True
            fresh = await self.store.admit(action_id,fence=fence,admission_check=admission)
        return result if fresh else dict(status='lookup_required')

    async def consume(self, connection, action_id, signed_challenge, *, request_id, nonce):
        """Authenticated current socket + pinned enforcer. Duplicate/unknown means lookup only.

        request_id/nonce correlate the pending protected-enforcer challenge, not permission.
        No socket/network awaits occur inside this transaction. All time uses PostgreSQL.
        """
        self._ready_service()
        if not self.prepare_clock.healthy():raise WorkConflict('command_clock_changed')
        async with self.input_scope.lock(), self.transport.guard(connection) as live:
            async with self.store._transaction(trusted=True) as db:
                task, action = await self.store._action(db,action_id)
                preparation,pbinding=await self._prepare_row(db,action)
                self._checked_ready(preparation,pbinding,preparation['ready_token'])
                row = await (await db.execute('SELECT * FROM work_command_dispatches WHERE action_id=%s FOR UPDATE', (action_id,))).fetchone()
                if not row: raise WorkNotFound()
                claims = self._row(row,action)
                binding = binding_of(claims)
                if (str(row['preparation_id'])!=pbinding.preparationId or row['readiness_digest']!=preparation['readiness_digest']
                        or sha(preparation['ready_token'])!=preparation['readiness_digest']
                        or row['native_deadline_ms']!=preparation['native_deadline_ms']):raise WorkConflict('command_readiness_changed')
                if (type(live) is not LiveCommandConnection or live.node_id != binding['nodeId']
                        or live.connection_id != binding['connectionId']):
                    raise WorkConflict('command_connection_changed')
                now = await now_ms(db)
                challenge = self.verifier.verify(signed_challenge,purpose='work_command_consume',issuer=self.enforcement_issuer,
                    audience=self.control_issuer,expected_binding=binding,now_ms=now,
                    expected_request=dict(requestId=request_id,nonce=nonce))
                if challenge.ticketDigest != row['ticket_digest']: raise WorkConflict('command_ticket_changed')
                if row['state'] != 'issued' or action['status'] == 'unknown':
                    return dict(status='lookup_required')
                self.store._active(task)
                profile,digest = await self.profiles.resolve_in_transaction(db,task)
                self._connection(live,profile,binding['connectionId'])
                if (digest != binding['profileDigest'] or action['status'] != 'admitted' or not action['unexpired']
                        or action['authority_generation'] != task['authority_generation']
                        or not action['requires_approval'] or action['decision']!='approved'):
                    raise WorkConflict('command_admission_changed')
                proof = row['engine_proof']
                if type(proof) is not dict or set(proof) != {'facts','activityId','correctionContextId'}:
                    raise WorkConflict('command_proof_changed')
                bounded_value(proof)
                try: facts = EngineActivityFacts(**proof['facts'])
                except (TypeError,ValueError): raise WorkConflict('command_proof_changed') from None
                context = WorkRuntimeContext(task['id'],action['run_id'],task['bot_id'],task['objective'],task['token_limit'],proof['correctionContextId'])
                fence = WorkFence(action['run_id'],row['original_claim_id'],row['original_epoch'])
                await self._sdk(db,context,facts,proof['activityId'],task,fence)
                await check_context(db,task,action['run_id'],action['correction_context_id'])
                if proof['correctionContextId'] != action['correction_context_id']:
                    raise WorkConflict('command_proof_changed')
                await self.input_scope.revalidate_in_transaction(db,context,task,row['operation']['command'],row['input_scope'])
                # Recheck current policy against the exact admitted command; never derive a new operation.
                self.profiles.check_command(profile,row['operation']['command'])
                now = await now_ms(db)
                if not self.prepare_clock.check(pbinding.preparationId,now,self.timing_policy,preparation=False):raise WorkConflict('command_clock_changed')
                if now >= min(row['expires_at_ms'],row['hard_deadline_ms']):
                    raise WorkConflict('command_deadline_expired')
                launch = min(now+5000,row['hard_deadline_ms'])
                permit = parse(PermitClaims,dict(**binding,iss=self.control_issuer,aud=self.enforcement_issuer,jti=str(uuid4()),
                    iat=now//1000,nbf=now//1000,exp=launch//1000,purpose='work_command_permit',requestId=request_id,nonce=nonce,
                    requestDigest=sha(signed_challenge),consumedAtMs=now,launchDeadlineMs=launch)).model_dump()
                token = self.signer.sign(permit,purpose='work_command_permit',now_ms=now)
                await db.execute("UPDATE work_command_dispatches SET state='consumed',consume_request_digest=%s,consume_nonce=%s,"
                    'consumed_at_ms=%s,permit_claims=%s WHERE action_id=%s AND state=\'issued\'',
                    (sha(signed_challenge),nonce,now,Jsonb(permit),action_id))
                # Keep the exact issued-token digest atomically with consumption. Readback must
                # not mint another token or trust the Host to invent this receipt binding.
                await self.store._event(db,task['id'],'command.permit_issued',dict(actionId=action_id,
                    dispatchId=binding['dispatchId'],preparationId=binding['preparationId'],permitDigest=sha(token)))
                await check_fence(db,action['run_id'],fence)
                if await now_ms(db) >= permit['exp']*1000: raise WorkConflict('command_deadline_expired')
                result = dict(status='consumed',permit=token)
            # Only a known commit returns a permit; a lost ACK never authorizes a retry.
            return result

    @staticmethod
    def _row(row, action):
        claims = parse(DispatchClaims,row['dispatch_claims']).model_dump()
        intent = action_command(action['intent'])
        operation = derive_operation(action['intent'],task_id=action['task_id'],run_id=action['run_id'],action_id=action['id'],
            generation=action['authority_generation'],original_epoch=row['original_epoch'],route=row['operation']['route']).model_dump()
        anchors = claims['anchors']
        if (row['task_id'] != action['task_id'] or row['action_id'] != action['id'] or row['operation'] != operation
                or row['intent_digest'] != action['intent_digest'] or operation['intentDigest'] != action['intent_digest']
                or operation_fingerprint(operation) != row['operation_fingerprint']
                or claims['operationFingerprint'] != row['operation_fingerprint'] or claims['taskId'] != action['task_id']
                or claims['runId'] != action['run_id'] or claims['actionId'] != action['id']
                or claims['dispatchId'] != str(row['dispatch_id']) or claims['connectionId'] != str(row['connection_id'])
                or claims['originalEpoch'] != row['original_epoch'] or claims['authorityGeneration'] != row['authority_generation']
                or claims['authorityGeneration'] != action['authority_generation'] or claims['intentDigest'] != action['intent_digest']
                or claims['profileDigest'] != intent.profileDigest or claims['exp']*1000 != row['expires_at_ms']
                or anchors['admittedAtMs'] != row['issued_at_ms'] or anchors['rootDeadlineMs'] != row['root_deadline_ms']
                or anchors['nativeDeadlineMs'] != row['native_deadline_ms'] or anchors['hardDeadlineMs'] != row['hard_deadline_ms']
                or any(claims[k] != v for k,v in operation['route'].items())
                or anchors['wallSeconds'] != intent.command.limits.wallSeconds
                or claims['preparationId']!=str(row['preparation_id']) or claims['readinessDigest']!=row['readiness_digest']):
            raise WorkConflict('command_dispatch_changed')
        return claims

    async def original(self, action_id):
        """Private original identity for lookup, including after closure. No executable token."""
        async with self.store._transaction(trusted=True) as db:
            _,action = await self.store._action(db,action_id)
            row = await (await db.execute('SELECT * FROM work_command_dispatches WHERE action_id=%s', (action_id,))).fetchone()
            if not row: raise WorkNotFound()
            claims = self._row(row,action)
            issued=await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='command.permit_issued' "
                "AND payload->>'actionId'=%s ORDER BY revision LIMIT 2",(action['task_id'],action_id))).fetchall()
            digest=None
            if row['state']=='consumed':
                from .work_command_contract import Digest
                from pydantic import TypeAdapter
                if len(issued)!=1:raise WorkConflict('command_permit_record_missing')
                value=issued[0]['payload']
                if (type(value) is not dict or set(value)!={'actionId','dispatchId','preparationId','permitDigest'}
                        or value['actionId']!=action_id or value['dispatchId']!=claims['dispatchId']
                        or value['preparationId']!=claims['preparationId']):raise WorkConflict('command_permit_record_changed')
                try: digest=TypeAdapter(Digest).validate_python(value['permitDigest'],strict=True)
                except (ValueError,TypeError):
                    raise WorkConflict('command_permit_record_changed') from None
            elif issued:raise WorkConflict('command_permit_record_changed')
            return dict(state=row['state'],binding=binding_of(claims),operation=row['operation'],
                permitClaims=row['permit_claims'],permitDigest=digest)

    async def close_unconsumed_in_transaction(self, db, task, reason):
        """Caller owns existing source/ancestor/Task locks. Never changes consumed/unknown facts."""
        if reason not in ('cancel','revoked','expired','source_changed','identity_changed'):
            raise ValueError('invalid_command_close_reason')
        await db.execute("UPDATE work_command_preparations SET state='closed',closed_at_ms=%s,close_reason=%s "
            "WHERE task_id=%s AND (state IN ('reserved','authorized') OR (state='ready' AND NOT EXISTS "
            "(SELECT 1 FROM work_command_dispatches d WHERE d.action_id=work_command_preparations.action_id)))",
            (await now_ms(db),reason,task['id']))
        await db.execute("UPDATE work_command_dispatches SET state='closed',closed_at_ms=%s,close_reason=%s "
            "WHERE task_id=%s AND state='issued'", (await now_ms(db),reason,task['id']))
