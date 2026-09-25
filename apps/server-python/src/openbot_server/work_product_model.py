"""Fresh product configuration -> existing durable Model Action, without a Run cache.

Settings, credentials and Activity binding belong to control. A receipt recovers historical
observation without reviving provider authority; the next model step resolves current settings.
No Agent, retry loop, SQL schema or provider fallback is introduced.
"""
from copy import deepcopy
from dataclasses import dataclass, field
import hmac
import inspect
import json

from pydantic_ai.messages import ModelMessagesTypeAdapter

from .model_connections_inputs import ModelSelection
from .model_connections_port import ModelConnectionPort
from .model_presets import RetainedModelSettings, model_provider_base_url
from .product_model import ProductModelError, ProductModelPort
from .work_claims import WorkFence, check_fence
from .work_corrections import check_context
from .work_engine_binding import assert_accepted_workflow, assert_accepted_workflow_in_transaction
from .work_model_activity import configuration_record, execute_model_activity, model_request, operation_key
from . import work_temporal_activity as temporal_binding
from .work_temporal_activity import derive_claim_id
from .work_temporal_start import WorkRuntimeContext
from .work_task_profiles import resolve_product_source
from .work_values import InvalidWork, WorkConflict, tokens

_SCOPE_FIELDS = {'expected_namespace','expected_queue','expected_workflow_type'}
_RECOVERY = {'admitted','unknown','applied','not_applied'}


@dataclass(frozen=True)
class _Selected:
    source: dict
    configuration: dict
    credential: object = field(repr=False)

    @property
    def key(self):
        return self.credential['apiKey'] if self.configuration['source']=='singleton' else self.credential.api_key


def _reservation(request, max_output):
    # A conservative control estimate, not a claim about the provider's tokenizer or usage.
    # Existing validation already bounds messages/catalog before this pure policy is called.
    messages = ModelMessagesTypeAdapter.dump_json(request.messages)
    tools = json.dumps([dict(name=t.name,description=t.description,input_schema=t.input_schema)
                        for t in request.tools],ensure_ascii=False,separators=(',',':')).encode()
    return len(messages)+len(tools)+max_output


class ProductWorkModel:
    def __init__(self, store, client, scope, settings, connections, receipts, *,
                 max_output_tokens=4096, reserve_policy=None, transport_factory=None, media=None):
        if type(scope) is not dict or set(scope)!=_SCOPE_FIELDS:
            raise InvalidWork('invalid_product_model_scope')
        if type(max_output_tokens) is not int or not 1<=max_output_tokens<=65536:
            raise InvalidWork('invalid_model_output_limit')
        if reserve_policy is not None and not callable(reserve_policy):
            raise InvalidWork('invalid_model_reserve_policy')
        if transport_factory is not None and not callable(transport_factory):
            raise InvalidWork('invalid_model_transport_factory')
        self.store,self.client,self.scope = store,client,dict(scope)
        self.settings,self.connections,self.receipts = settings,connections,receipts
        if media is not None and media.store is not store:
            raise InvalidWork('invalid_product_media_store')
        self.media = media
        self.max_output_tokens = max_output_tokens
        self._reserve = reserve_policy or _reservation
        # Explicit synthetic transport injection only; the production ports use fixed no-proxy TLS.
        self._transport_factory = transport_factory

    async def _bind(self, context, expected_key=None):
        if type(context) is not WorkRuntimeContext:
            raise WorkConflict('product_model_context_required')
        info=temporal_binding.activity_info()
        activity_id=temporal_binding.current_activity_id(info)
        facts=await temporal_binding.inspect_activity_start(self.client,info,**self.scope)
        accepted=await assert_accepted_workflow(self.store,
            {'taskId':facts.start_input['taskId'],'runId':facts.start_input['runId']},facts,**self.scope)
        if (accepted.task_id,accepted.run_id)!=(context.task_id,context.run_id):
            raise WorkConflict('product_model_scope_changed')
        key=operation_key(accepted,activity_id)
        if expected_key is not None and key!=expected_key:
            raise WorkConflict('product_model_activity_changed')
        return accepted,activity_id,key,facts

    async def _accepted_in_transaction(self, db, context, facts, activity_id, key):
        # Facts are captured above from the actual SDK, never accepted by the public call.
        # Admission already owns Task UPDATE: opening another connection here would self-lock.
        accepted=await assert_accepted_workflow_in_transaction(self.store,db,
            {'taskId':context.task_id,'runId':context.run_id},facts,**self.scope)
        if operation_key(accepted,activity_id)!=key:
            raise WorkConflict('product_model_activity_changed')
        return accepted

    async def _source(self, db, context, *, historical=False):
        # _task takes channel/source locks before Task, matching source cancellation/publication.
        task = await self.store._task(db,context.task_id,read=True)
        self.store._active(task)
        run = await (await db.execute('SELECT status,execution_epoch FROM work_runs '
            'WHERE id=%s AND task_id=%s FOR SHARE',(context.run_id,context.task_id))).fetchone()
        if (not run or task['bot_id']!=context.bot_id or task['objective']!=context.objective
                or task['token_limit']!=context.token_limit
                or run['status'] not in ('queued','running')):
            raise WorkConflict('product_model_source_changed')
        row = await resolve_product_source(db,task,context.bot_id,
            command_profiles=self.store.command_profiles,browser_profiles=self.store.browser_profiles)
        await check_context(db,task,context.run_id,context.correction_token,current=not historical)
        return row,run

    async def _select(self, db, source):
        if source['execution_profile']=='none':
            active = await self.settings.active() if self.settings is not None else None
            if active is None:
                raise ProductModelError('model_configuration')
            try:
                config=RetainedModelSettings.model_validate(active).model_dump(exclude_none=True)
                if not config['agentEnabled'] or not config['agentEnabledAt']:
                    raise ValueError()
            except Exception:
                raise ProductModelError('model_configuration') from None
            protocol=('responses-v1' if config['provider']=='openai' else
                      'anthropic-messages-v1' if config['provider']=='anthropic' else 'chat-completions-v1')
            provenance=dict(source='singleton',revision=config['revision'],provider=config['provider'],
                model=config['model'],baseUrl=model_provider_base_url(config['provider'],config.get('baseUrl')),protocol=protocol)
            credential=config
        else:
            # resolve(None) has a retained F legacy default. It is not allowed for this explicit
            # queued selection port; neither the current Bot nor another connection is a fallback.
            try:
                selection=ModelSelection.model_validate(source['model_selection']).model_dump()
            except Exception:
                raise ProductModelError('model_configuration') from None
            if self.connections is None: raise ProductModelError('model_configuration')
            credential=await self.connections.resolve_in_transaction(db,selection)
            if credential is None or credential.source not in ('saved','environment'):
                raise ProductModelError('model_configuration')
            provenance=dict(source='environment' if credential.source=='environment' else 'connection',
                revision=credential.revision,connectionId=credential.connection_id,provider=credential.preset_id,
                model=credential.model_id,baseUrl=credential.base_url,protocol='anthropic-messages-v1'
                if credential.protocol=='anthropic-messages' else 'chat-completions-v1')
        return _Selected(deepcopy(source),configuration_record(provenance),credential)

    async def _fresh(self, db, context, selected):
        source,run=await self._source(db,context)
        current=await self._select(db,source)
        if (source!=selected.source or current.configuration!=selected.configuration
                or not hmac.compare_digest(current.key,selected.key)):
            raise WorkConflict('product_model_configuration_changed')
        return run

    async def call(self, context, request, *, admission_check=None, before_send=None):
        """One accepted Activity's durable model step; callbacks are trusted control checks.

        admission_check(db,task,action) must return True and runs inside Model Action admission.
        before_send() may raise to veto transport. Historical receipt recovery invokes neither
        provider nor configuration callbacks; root's outer Runtime authority guards still apply.
        """
        if (admission_check is not None and not callable(admission_check)) or (before_send is not None and not callable(before_send)):
            raise InvalidWork('invalid_product_model_check')
        accepted,activity_id,key,facts=await self._bind(context)
        async with self.store._transaction(trusted=True) as db:
            existing=await (await db.execute('SELECT * FROM work_actions WHERE run_id=%s AND action_key=%s',
                                             (context.run_id,key))).fetchone()
            recovering=bool(existing and existing['status'] in _RECOVERY)
            source,_=await self._source(db,context,historical=recovering)
            selected=None if recovering else await self._select(db,source)
        if selected is None:
            # Never decrypt a new key or manufacture a new intent for an already admitted call.
            # The core recomputes request digest and checks the existing immutable operation.
            original=existing['intent']
            if type(original) is not dict or original.get('kind')!='model':
                raise WorkConflict('model_operation_changed')
            async def forbidden(_):
                raise WorkConflict('model_recovery_cannot_send')
            return await execute_model_activity(self.store,self.client,**self.scope,receipts=self.receipts,
                provider=forbidden,request=request,provider_id=original['provider'],model_id=original['model'],
                max_output_tokens=original['maxOutputTokens'],reserved_tokens=existing['reserved_tokens'],
                protocol=original['protocol'],configuration=original.get('configuration'),input_media=original.get('inputMedia'),
                correction_context=context.correction_token)

        config=selected.configuration
        input_media=await self.media.binding(context) if self.media is not None else None
        detached,_=model_request(request,provider_id=config['provider'],model_id=config['model'],
            max_output_tokens=self.max_output_tokens,protocol=config['protocol'],configuration=config,input_media=input_media)
        reserved=self._reserve(detached,self.max_output_tokens)
        tokens(reserved)
        if reserved<self.max_output_tokens:
            raise InvalidWork('model_reservation_below_output_limit')
        if self.media is not None:
            reserved += self.media.reservation(input_media,config)
        tokens(reserved)

        async def admission(db,task,action):
            if (task['id'],action['task_id'],action['run_id'],action['action_key'])!=(context.task_id,context.task_id,context.run_id,key):
                raise WorkConflict('product_model_scope_changed')
            await self._accepted_in_transaction(db,context,facts,activity_id,key)
            await self._fresh(db,context,selected)
            if self.media is not None:
                await self.media.admit_in_transaction(db,context,input_media)
            if admission_check is not None:
                result=admission_check(db,deepcopy(task),deepcopy(action))
                if not inspect.isawaitable(result) or await result is not True:
                    raise WorkConflict('product_admission_refused')
                await self._accepted_in_transaction(db,context,facts,activity_id,key)
                await self._fresh(db,context,selected)
            return True

        async def live():
            current,activity,_,current_facts=await self._bind(context,key)
            async with self.store._transaction(trusted=True) as db:
                await self._accepted_in_transaction(db,context,current_facts,activity,key)
                run=await self._fresh(db,context,selected)
                action=await (await db.execute('SELECT status,authority_generation FROM work_actions '
                    'WHERE task_id=%s AND run_id=%s AND action_key=%s FOR SHARE',
                    (context.task_id,context.run_id,key))).fetchone()
                task=await (await db.execute('SELECT authority_generation FROM work_tasks WHERE id=%s',
                                             (context.task_id,))).fetchone()
                if (not action or action['status']!='admitted' or run['status']!='running'
                        or action['authority_generation']!=task['authority_generation']):
                    raise WorkConflict('product_model_admission_changed')
                claim=derive_claim_id(current.namespace,current.workflow_id,current.engine_run_id,activity)
                await check_fence(db,context.run_id,WorkFence(context.run_id,claim,run['execution_epoch']))

        async def send_gate():
            await live()
            if self.media is not None:
                await self.media.revalidate(context,input_media)
            if before_send is not None:
                result=before_send()
                if not inspect.isawaitable(result):
                    raise InvalidWork('invalid_product_model_check')
                await result
                # Configuration/file changes during the awaited root data check must revoke
                # the snapshot before the first byte can cross the real HTTP transport seam.
                if self.media is not None:
                    await self.media.revalidate(context,input_media)
            # Keep configuration/fence the final fresh transaction after awaited data gates.
            await live()

        async def media_loader():
            return await self.media.hydrate(context,input_media,config)

        transport=self._transport_factory() if self._transport_factory is not None else None
        options=dict(max_output_tokens=self.max_output_tokens,transport=transport,before_send=send_gate,
                     media_loader=media_loader if input_media is not None else None)
        port=(ProductModelPort(selected.credential,**options) if config['source']=='singleton' else
              ModelConnectionPort(selected.credential,policy=self.connections.policy,**options))
        async with port:
            return await execute_model_activity(self.store,self.client,**self.scope,receipts=self.receipts,
                provider=port,request=detached,provider_id=config['provider'],model_id=config['model'],
                max_output_tokens=self.max_output_tokens,reserved_tokens=reserved,protocol=config['protocol'],
                configuration=config,correction_context=context.correction_token,admission_check=admission,input_media=input_media)
