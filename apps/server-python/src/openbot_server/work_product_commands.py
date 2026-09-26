"""Approved offline commands through the original Work admission and protected Host evidence."""
import asyncio
from copy import deepcopy
from dataclasses import replace
import hashlib
import time

from openbot_agent_runtime.contracts import ToolDescriptor

from .task_store import attachment_ids
from .work_command_actions import action_command
from .work_command_channel import CommandChannelDriver
from .work_command_contract import Command, parse, bounded_value
from .work_command_store import now_ms
from .work_command_v2_contract import BindingV2
from .work_deferred import DeferredPlan, EffectServices
from .work_effects import recover_action
from .work_product_binding import ProductWorkBinding
from .work_tool_results import ToolResponseVerifier
from .work_values import InvalidWork, WorkConflict, canonical


COMMAND_TOOL = ToolDescriptor('run_command',
    'Propose one offline command for Owner approval. Read only the supplied /input files; write '
    'the declared UTF-8 text or CSV file under /output. No network or secrets are available. '
    'A process exit proves an observation, not correctness of its content.',
    dict(type='object',properties=dict(
        argv=dict(type='array',minItems=1,maxItems=64,items=dict(type='string',minLength=1,maxLength=4096)),
        output=dict(type='object',properties=dict(name=dict(type='string',minLength=1,maxLength=128,
            pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]*$'),mediaType=dict(type='string',enum=['text/plain','text/csv']),
            maxBytes=dict(type='integer',minimum=1,maximum=65536)),
            required=['name','mediaType','maxBytes'],additionalProperties=False)),
        required=['argv','output'],additionalProperties=False))


class ProductWorkCommands:
    def __init__(self, store, client, scope, results, driver):
        if (type(driver) is not CommandChannelDriver or driver.service.store is not store
                or results.store is not store or driver.service.profiles is not store.command_profiles):
            raise InvalidWork('product_command_composition_required')
        self.store,self.results,self.driver=store,results,driver
        self.binding=ProductWorkBinding(store,client,scope)
        self.service=driver.service
        self.files=driver.service.input_scope.files

    async def _snapshot(self, db, context, arguments=None, *, require_fence=False):
        source=await self.binding.check(db,context,require_fence=require_fence)
        if source.get('execution_profile')!='docker-linux':raise WorkConflict('command_profile_required')
        task=await self.store._task(db,context.task_id,read=True)
        profile,digest=await self.service.profiles.resolve_in_transaction(db,task)
        refs=sorted(attachment_ids(context.objective))
        if len(refs)>8:raise WorkConflict('command_input_limit')
        self.files.validate_references(source['channel_id'],refs)
        manifest=[];attachments=[];blobs={};descriptors=[]
        for index,identity in enumerate(refs,1):
            metadata,data=self.files.read(source['channel_id'],identity)
            name=f'input-{index:02d}'
            manifest.append(dict(path=name,size=len(data),sha256=metadata['sha256']))
            attachments.append(dict(path=name,attachmentId=identity))
            blobs[name]=data
            descriptors.append(dict(path='/input/'+name,attachmentId=identity,name=metadata['name'],
                sizeBytes=len(data),sha256=metadata['sha256']))
        if sum(item['size'] for item in manifest)>20*1024*1024:raise WorkConflict('command_input_limit')
        policy=self.service.profiles.policies[profile.policyId][1]
        if arguments is None:
            return dict(inputs=descriptors,image=policy['image'],limits=deepcopy(policy['limits']),
                outputDirectory='/output',maxOutputBytes=65536,network='none',rootfs='readonly',requiresOwnerApproval=True)
        if type(arguments) is not dict or set(arguments)!={'argv','output'}:
            raise InvalidWork('command_arguments_required')
        command=parse(Command,dict(**deepcopy(policy),**deepcopy(arguments),inputManifest=manifest,
            inputDigest='sha256:'+hashlib.sha256(bounded_value(manifest)).hexdigest(),
            network='none',rootfs='readonly',user='10001:10001',environment=[]))
        if command.output.maxBytes>65536:raise InvalidWork('command_product_output_limit')
        await self.service.input_scope.freeze_in_transaction(db,context,task,command.model_dump(),attachments)
        return command,profile,digest,attachments,blobs

    async def describe(self, context):
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                return await self._snapshot(db,context)

    async def prepare(self, context, request):
        if request.tool!='run_command' or canonical(request.arguments)[1]!=request.digest:
            raise InvalidWork('command_proposal_changed')
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                command,_,digest,_,_=await self._snapshot(db,context,request.arguments)
        return DeferredPlan(dict(kind='work_command',version=1,profileDigest=digest,command=command.model_dump()),
            0,True,expires_seconds=300)

    async def _original(self, db, context, intent):
        checked=action_command(intent)
        command,profile,digest,attachments,blobs=await self._snapshot(db,context,intent['arguments'])
        if checked.profileDigest!=digest or checked.command!=command:
            raise WorkConflict('command_intent_changed')
        return command,profile,attachments,blobs

    async def load(self, context, intent):
        action_command(intent)
        original=deepcopy(intent)
        adapter=_CommandObservation(self,context,original)
        verifier=ToolResponseVerifier(self.results)
        async def execute(action_id,fence):
            async with self.files.lock():
                async with self.store._transaction(trusted=True) as db:
                    command,profile,attachments,blobs=await self._original(db,context,original)
            connection=self.service.transport.connection(profile.route.nodeId)
            try:
                await self.driver.execute(context,action_id,fence=fence,connection=connection,
                    command=command.model_dump(),attachments=attachments,blobs=blobs)
            except asyncio.CancelledError:raise
            except Exception:
                # Only an admitted Action can use the existing readback resolver. A failed
                # preparation remains reserved and must never be started again.
                async with self.store._transaction(trusted=True) as db:
                    _,row=await self.store._action(db,action_id)
                    if row['status'] not in ('admitted','unknown'):raise
            return await recover_action(self.store,task_id=context.task_id,run_id=context.run_id,
                action_id=action_id,adapter=adapter,verifier=verifier)
        # The fixed preparation/runtime/stop envelope exceeds the generic 60-second claim.
        # Replays retain their original claim; root/Action/native deadlines remain unchanged.
        return EffectServices(adapter,verifier,execute,claim_seconds=120)

    async def _evidence(self, db, context, row, observed):
        await self._original(db,context,row['intent'])
        if observed is None:raise WorkConflict('command_observation_missing')
        value=observed.value
        if type(value) is not dict or set(value)!={'schema','token','verifiedAtMs','receipt','output','payload'}:
            raise WorkConflict('command_observation_changed')
        if value['schema']!='openbot.work-command-observation/v1':raise WorkConflict('command_observation_changed')
        # The token is historical private evidence. Current permission is checked above;
        # replay never extends the native deadline or enables a new execution.
        claims=value['receipt'];binding={k:claims[k] for k in BindingV2.model_fields}
        receipt=self.service.verifier.verify(value['token'],purpose='work_command_receipt',
            issuer=self.service.enforcement_issuer,audience=self.service.control_issuer,
            expected_binding=binding,expected_request=dict(requestId=claims['requestId'],nonce=claims['nonce']),
            now_ms=value['verifiedAtMs'])
        dispatch=await (await db.execute('SELECT * FROM work_command_dispatches WHERE action_id=%s',
            (row['id'],))).fetchone()
        if (not dispatch or any(dispatch['dispatch_claims'][k]!=v for k,v in binding.items())
                or receipt.model_dump()!=claims or receipt.intentDigest!=row['intent_digest']
                or receipt.actionId!=row['id'] or receipt.taskId!=context.task_id or receipt.runId!=context.run_id
                or receipt.observation.phase!='exited'):
            raise WorkConflict('command_receipt_changed')
        self.service._row(dispatch,row)
        events=await (await db.execute("SELECT payload FROM work_events WHERE task_id=%s AND kind='command.permit_issued' "
            "AND payload->>'actionId'=%s ORDER BY revision LIMIT 2",(context.task_id,row['id']))).fetchall()
        expected=dict(actionId=row['id'],dispatchId=receipt.dispatchId,preparationId=receipt.preparationId,
            permitDigest=receipt.permitDigest)
        if len(events)!=1 or events[0]['payload']!=expected:raise WorkConflict('command_permit_record_changed')
        data=self.store.files.read(value['output']['sha256'],value['output']['sizeBytes'])
        if (len(receipt.observation.outputs)!=1 or value['output']!=dict(
                sha256=receipt.observation.outputs[0].sha256,sizeBytes=receipt.observation.outputs[0].sizeBytes)
                or value['payload']!=_payload(receipt.observation,data)):
            raise WorkConflict('command_output_changed')
        expected_output=action_command(row['intent']).command.output
        found=receipt.observation.outputs[0]
        if (found.name!=expected_output.name or found.mediaType!=expected_output.mediaType
                or found.sizeBytes>expected_output.maxBytes):raise WorkConflict('command_output_changed')
        return value['payload'],data

    async def load_result(self, context, row):
        await self.binding.claim(context)
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                observed=await self.results.load_in_transaction(db,row['id'],task_id=context.task_id,
                    run_id=context.run_id,intent_digest=row['intent_digest'])
                payload,_=await self._evidence(db,context,row,observed)
                return deepcopy(payload)

    async def _rows(self, db, context):
        rows=await (await db.execute("SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s "
            "AND authority_generation=(SELECT authority_generation FROM work_tasks WHERE id=%s) "
            "AND intent->>'tool'='run_command' AND status='applied' ORDER BY created_at,id LIMIT 257",
            (context.task_id,context.run_id,context.task_id))).fetchall()
        if len(rows)>256:raise WorkConflict('action_limit')
        return rows

    async def revalidate_in_transaction(self, db, context):
        for row in await self._rows(db,context):
            original=replace(context,correction_token=row['correction_context_id'])
            observed=await self.results.load_in_transaction(db,row['id'],task_id=context.task_id,
                run_id=context.run_id,intent_digest=row['intent_digest'])
            await self._evidence(db,original,row,observed)
        return True

    async def artifacts(self, context):
        values=[]
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                await self.binding.check(db,context)
                for row in await self._rows(db,context):
                    observed=await self.results.load_in_transaction(db,row['id'],task_id=context.task_id,
                        run_id=context.run_id,intent_digest=row['intent_digest'])
                    payload,data=await self._evidence(db,replace(context,correction_token=row['correction_context_id']),row,observed)
                    output=payload['output']
                    values.append(dict(key=row['id'],name=output['name'],mediaType=output['mediaType'],data=data))
        return tuple(values)


def _payload(observation,data):
    output=observation.outputs[0].model_dump()
    decoded=data.decode('utf-8','strict')
    excerpt=data[:16384].decode('utf-8',errors='ignore')
    return dict(status='exited',exitCode=observation.exitCode,output=output,text=excerpt,
        truncated=len(excerpt)!=len(decoded),untrusted=True,publishedOnTaskCompletion=True)


class _CommandObservation:
    def __init__(self, owner, context, intent):
        self.owner,self.context,self.intent=owner,context,intent
        self.scope=dict(task_id=context.task_id,run_id=context.run_id,intent_digest=canonical(intent)[1])

    async def apply(self,*_):raise WorkConflict('command_admission_service_required')

    async def lookup(self,action_id):
        o=self.owner
        observed=await o.results.load(action_id,**self.scope)
        if observed is not None:return observed.metadata
        async with o.files.lock():
            async with o.store._transaction(trusted=True) as db:
                _,profile,_,_=await o._original(db,self.context,self.intent)
        connection=o.service.transport.connection(profile.route.nodeId)
        # Observation is bounded by the original native deadline and a fixed local ceiling.
        # This loop issues only fresh readback challenges, never prepare/dispatch/consume.
        original=await o.service.original(action_id)
        async with o.store._transaction(trusted=True) as db:current=await now_ms(db)
        budget=max(0,min(55,(original['binding']['hardDeadlineMs']-current)/1000))
        deadline=time.monotonic()+budget
        for _ in range(128):
            if time.monotonic()>=deadline:return None
            async with asyncio.timeout(max(.001,deadline-time.monotonic())):
                result=await o.driver.lookup(connection,action_id,include_output=True)
            observation=result['receipt']['observation']
            if observation['phase']=='exited':break
            if observation['phase'] not in ('prepared','running'):return None
            await asyncio.sleep(min(.5,max(0,deadline-time.monotonic())))
        else:return None
        if len(observation['outputs'])!=1:return None
        async with o.files.lock():
            async with o.store._transaction(trusted=True) as db:
                await o._original(db,self.context,self.intent)
                current=await now_ms(db)
        claims=result['receipt']
        verified=o.service.verifier.verify(result['token'],purpose='work_command_receipt',
            issuer=o.service.enforcement_issuer,audience=o.service.control_issuer,
            expected_binding={k:claims[k] for k in BindingV2.model_fields},
            expected_request=dict(requestId=claims['requestId'],nonce=claims['nonce']),now_ms=current)
        output=await asyncio.to_thread(o.store.files.put,result['output'])
        value=dict(schema='openbot.work-command-observation/v1',token=result['token'],verifiedAtMs=current,
            receipt=verified.model_dump(),output=output,payload=_payload(verified.observation,result['output']))
        return await o.results.save(action_id,**self.scope,value=value)
