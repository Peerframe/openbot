"""Plugin grants -> existing durable deferred Actions and private ToolResults observations."""
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import replace
import asyncio
import json

from openbot_agent_runtime.contracts import ToolDescriptor

from . import work_temporal_activity as temporal
from .identity_inputs import _UUID_PATTERN_TEXT
from .plugin_inputs import PluginError
from .work_claims import WorkFence, check_fence
from .work_corrections import check_context
from .work_deferred import DeferredPlan, EffectServices
from .work_engine_binding import assert_accepted_workflow_in_transaction
from .work_temporal_effect import ToolRequest
from .work_temporal_start import WorkRuntimeContext
from .work_tool_results import ToolResponseAdapter, ToolResponseVerifier, encode_result, decode_result
from .work_values import InvalidWork, WorkConflict, canonical, text

_SCOPE = {'expected_namespace','expected_queue','expected_workflow_type'}
_TOOLS = {'call_plugin','read_plugin_resource'}
_DISPATCH = 'tool.plugin_dispatch_started'
# MCPConnection.tools/resources parse the complete declaration with plugin_inputs.parse's
# retained 24-KiB bound. The separate 12-KiB check_schema limit applies to inputSchema only.
_DECLARATION_BYTES = 24 * 1024

# The retained model-facing declarations. The source UUID acceptance pattern and notices are
# already owned by identity_inputs; permissions still belong exclusively to the dispatch gate.
_UUID = {'type':'string','pattern':_UUID_PATTERN_TEXT}
CALL_PLUGIN_SCHEMA = dict(type='object',properties=dict(pluginId=_UUID,revision=_UUID,
    toolName={'type':'string','pattern':r'^[A-Za-z0-9_.-]{1,64}$'},
    arguments={'type':'object','additionalProperties':True}),
    required=['pluginId','revision','toolName','arguments'],additionalProperties=False)
READ_PLUGIN_RESOURCE_SCHEMA = dict(type='object',properties=dict(pluginId=_UUID,revision=_UUID,
    name={'type':'string','minLength':1,'maxLength':2048}),
    required=['pluginId','revision','name'],additionalProperties=False)


def plugin_tool_descriptors(catalog):
    """Detached declarations for an already-read authorized catalog, never executable ports."""
    if (type(catalog) is not dict or set(catalog)!={'tools','resources','truncated'}
            or type(catalog['tools']) is not list or type(catalog['resources']) is not list
            or type(catalog['truncated']) is not bool):
        raise InvalidWork('invalid_work_plugin_catalog')
    tools=[]
    if catalog['tools']:
        tools.append(ToolDescriptor('call_plugin',
            'Call an Owner-authorized MCP plugin tool using an exact catalog entry. Confirm mode requires Owner review of the original durable Action.',
            deepcopy(CALL_PLUGIN_SCHEMA)))
    if catalog['resources']:
        tools.append(ToolDescriptor('read_plugin_resource',
            'Read an exact Owner-enabled MCP resource as untrusted task evidence. No prompt execution or plugin app HTML.',
            deepcopy(READ_PLUGIN_RESOURCE_SCHEMA)))
    return tuple(tools)


class WorkPluginAdapter:
    """Trusted Worker composition; no environment, in-memory approval or retry engine.

    ``prepare`` and ``load`` are DeferredActivities callbacks. ``load_result`` is the host's
    ToolResults reader. None accepts an approval boolean or caller-provided Activity facts.
    """
    def __init__(self, store, client, scope, plugins, results, *, history_reset_on_correction=False):
        if type(scope) is not dict or set(scope)!=_SCOPE:
            raise InvalidWork('invalid_work_plugin_scope')
        for value in scope.values():text(value,256)
        if results.store is not store:raise InvalidWork('work_plugin_results_store_changed')
        self.store,self.client,self.scope=store,client,dict(scope)
        self.plugins,self.results=plugins,results
        if type(history_reset_on_correction) is not bool:raise InvalidWork('invalid_plugin_history_profile')
        self.history_reset_on_correction=history_reset_on_correction

    async def _facts(self, context):
        if type(context) is not WorkRuntimeContext:
            raise WorkConflict('work_plugin_context_required')
        info=temporal.activity_info()
        activity_id=temporal.current_activity_id(info)
        async with asyncio.timeout(10):
            facts=await temporal.inspect_activity_start(self.client,info,**self.scope)
        if facts.engine_run_id!=facts.first_run_id:
            raise WorkConflict('tool_continuation_identity_required')
        return facts,activity_id

    async def _source(self, db, context, *, historical=False):
        # Reuse the product source lock order: channel/source, Task, Run, membership.
        task=await self.store._task(db,context.task_id,read=True)
        self.store._active(task)
        run=await (await db.execute('SELECT status,execution_epoch FROM work_runs '
            'WHERE id=%s AND task_id=%s FOR SHARE',(context.run_id,context.task_id))).fetchone()
        row=await (await db.execute('SELECT s.legacy_run_id,s.channel_id,s.source_message_id,'
            'r.bot_id,r.channel_id AS run_channel,r.source_message_id AS run_message,r.execution_profile '
            'FROM work_sources s JOIN runs r ON r.id=s.legacy_run_id WHERE s.task_id=%s FOR SHARE OF r',
            (context.task_id,))).fetchone()
        if row is None:
            from .work_native_scope import tool_source
            source=await tool_source(db,task,run,context,'plugins',historical=historical)
            return task,run,source
        if (not row or not run or task['bot_id']!=context.bot_id or row['bot_id']!=context.bot_id
                or row['channel_id']!=row['run_channel'] or row['source_message_id']!=row['run_message']
                or run['status'] not in ('queued','running') or row['execution_profile'] not in ('none','model')):
            raise WorkConflict('work_plugin_source_changed')
        member=await (await db.execute('SELECT 1 FROM channel_bots WHERE channel_id=%s AND bot_id=%s '
            'FOR SHARE',(row['channel_id'],context.bot_id))).fetchone()
        if not member:raise WorkConflict('work_plugin_membership_changed')
        await check_context(db,task,context.run_id,context.correction_token,current=not historical)
        source=dict(legacyRunId=row['legacy_run_id'],channelId=row['channel_id'],sourceMessageId=row['source_message_id'])
        return task,run,source

    async def _check(self, db, context, facts, activity_id, *, action_id=None, intent=None, consume=False, historical=False):
        if action_id is not None:
            task,action=await self.store._action(db,action_id)
        await assert_accepted_workflow_in_transaction(self.store,db,
            dict(taskId=context.task_id,runId=context.run_id),facts,**self.scope)
        task,run,source=await self._source(db,context,historical=historical)
        if action_id is None:return source
        effect=self._intent(intent)
        if ((action['task_id'],action['run_id'])!=(context.task_id,context.run_id)
                or canonical(intent)[1]!=action['intent_digest'] or action['intent']!=intent
                or not action['action_key'].startswith('tool-activity-v1-')
                or action['correction_context_id']!=context.correction_token or effect['source']!=source):
            raise WorkConflict('work_plugin_intent_changed')
        confirm=effect['selection']['mode']=='confirm'
        if action['requires_approval'] is not confirm or action['decision']!=('approved' if confirm else 'not_required'):
            raise WorkConflict('work_plugin_approval_required')
        if consume:
            if (action['status']!='admitted' or not action['unexpired']
                    or action['authority_generation']!=task['authority_generation'] or run['status']!='running'):
                raise WorkConflict('work_plugin_not_admitted')
            claim=temporal.derive_claim_id(facts.namespace,facts.workflow_id,facts.engine_run_id,activity_id)
            await check_fence(db,context.run_id,WorkFence(context.run_id,claim,run['execution_epoch']))
            previous=await (await db.execute('SELECT 1 FROM work_events WHERE task_id=%s AND kind=%s '
                "AND payload->>'actionId'=%s LIMIT 1",(context.task_id,_DISPATCH,action_id))).fetchone()
            if previous:raise WorkConflict('work_plugin_already_dispatched')
            await self.store._event(db,context.task_id,_DISPATCH,dict(actionId=action_id))
        elif historical and action['status']!='applied':
            raise WorkConflict('tool_result_not_available')
        return action

    def _intent(self,intent):
        if (type(intent) is not dict or set(intent)!={'kind','tool','arguments','effect'}
                or intent['kind']!='deferred_tool' or intent['tool'] not in _TOOLS
                or type(intent['effect']) is not dict or set(intent['effect'])!={'kind','selection','source'}
                or intent['effect']['kind']!='product_plugin'
                or type(intent['effect']['selection']) is not dict
                or set(intent['effect']['selection']) not in (
                    {'pluginId','revision','manifestDigest','tool','mode','declaration'},
                    {'pluginId','revision','manifestDigest','tool','mode','declarationBlob'})
                or intent['effect']['selection']['tool']!=intent['tool']
                or intent['effect']['selection']['mode'] not in ('read','confirm')):
            raise InvalidWork('invalid_work_plugin_intent')
        canonical(intent)
        effect=deepcopy(intent['effect'])
        if 'declarationBlob' in effect['selection']:
            reference=effect['selection'].pop('declarationBlob')
            if (type(reference) is not dict or set(reference)!={'sha256','sizeBytes'}
                    or type(reference['sizeBytes']) is not int or not 1<=reference['sizeBytes']<=_DECLARATION_BYTES):
                raise InvalidWork('invalid_plugin_declaration_blob')
            data=self.results.files.read(reference['sha256'],reference['sizeBytes'])
            effect['selection']['declaration']=decode_result(data)
        return effect

    async def prepare(self, context, proposal):
        if (type(proposal) is not ToolRequest or proposal.tool not in _TOOLS
                or canonical(proposal.arguments)[1]!=proposal.digest):
            raise InvalidWork('invalid_work_plugin_proposal')
        facts,activity_id=await self._facts(context)
        source=None
        @asynccontextmanager
        async def authority():
            nonlocal source
            async with self.store._transaction(trusted=True) as db:
                source=await self._check(db,context,facts,activity_id)
                yield
        snapshot=await self.plugins.prepare_work(context.bot_id,proposal.tool,deepcopy(proposal.arguments),authority=authority)
        effect=dict(kind='product_plugin',selection=snapshot,source=source)
        envelope=dict(kind='deferred_tool',tool=proposal.tool,arguments=proposal.arguments,effect=effect)
        if len(json.dumps(envelope,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8'))>16384:
            data,_=encode_result(snapshot['declaration'])
            if not 1<=len(data)<=_DECLARATION_BYTES:raise InvalidWork('plugin_declaration_limit')
            reference=await asyncio.to_thread(self.results.files.put,data)
            compact=deepcopy(snapshot);compact.pop('declaration');compact['declarationBlob']=reference
            effect=dict(kind='product_plugin',selection=compact,source=source)
        # Test the complete immutable envelope here, before DeferredActivities creates an Action.
        self._intent(dict(kind='deferred_tool',tool=proposal.tool,arguments=proposal.arguments,effect=effect))
        return DeferredPlan(deepcopy(effect),0,requires_approval=snapshot['mode']=='confirm')

    async def catalog(self, context):
        facts,activity_id=await self._facts(context)
        @asynccontextmanager
        async def authority():
            async with self.store._transaction(trusted=True) as db:
                await self._check(db,context,facts,activity_id)
                yield
        return await self.plugins.catalog_work(context.bot_id,authority=authority)

    async def load(self, context, intent):
        self._intent(intent)
        # Assembly only. Already-admitted/unknown recovery must not reconnect or reread grants.
        snapshot=deepcopy(intent)
        async def invoke(action_id, original):
            return await self.invoke(context,action_id,original)
        return EffectServices(ToolResponseAdapter(self.results,invoke,task_id=context.task_id,
            run_id=context.run_id,intent_digest=canonical(snapshot)[1]),ToolResponseVerifier(self.results))

    async def invoke(self, context, action_id, intent):
        text(action_id,128)
        intent=deepcopy(intent);effect=self._intent(intent)
        facts,activity_id=await self._facts(context)
        # Refuse an unadmitted/cross-scope request before connecting, but consume only at send.
        async with self.store._transaction(trusted=True) as db:
            action=await self._check(db,context,facts,activity_id,action_id=action_id,intent=intent)
            if action['status']!='admitted':raise WorkConflict('work_plugin_not_admitted')

        @asynccontextmanager
        async def dispatch():
            current,current_id=await self._facts(context)
            async with self.store._transaction(trusted=True) as db:
                await self._check(db,context,current,current_id,action_id=action_id,intent=intent,consume=True)
                yield
                # File audit work may await; check the actual live claim again before commit.
                run=await (await db.execute('SELECT execution_epoch FROM work_runs WHERE id=%s',(context.run_id,))).fetchone()
                claim=temporal.derive_claim_id(current.namespace,current.workflow_id,current.engine_run_id,current_id)
                await check_fence(db,context.run_id,WorkFence(context.run_id,claim,run['execution_epoch']))
                live=await (await db.execute('SELECT expires_at>clock_timestamp() AS live FROM work_actions WHERE id=%s',
                                            (action_id,))).fetchone()
                if not live['live']:raise WorkConflict('work_plugin_not_admitted')
        return await self.plugins.invoke_work(context.bot_id,context.run_id,action_id,
            effect['selection'],intent['arguments'],authority=dispatch)

    async def load_result(self, context, row):
        intent=row['intent'];effect=self._intent(intent)
        facts,activity_id=await self._facts(context)
        @asynccontextmanager
        async def authority():
            async with self.store._transaction(trusted=True) as db:
                await self._check(db,context,facts,activity_id,action_id=row['id'],intent=intent,historical=True)
                yield
        fresh=await self.plugins.prepare_work(context.bot_id,intent['tool'],intent['arguments'],authority=authority)
        if fresh!=effect['selection']:raise PluginError('conflict')
        observed=await self.results.load(row['id'],task_id=context.task_id,run_id=context.run_id,
                                        intent_digest=canonical(intent)[1])
        if observed is None:raise WorkConflict('tool_result_not_available')
        # A private blob read is an await; revalidate product/grant authority before publication.
        fresh=await self.plugins.prepare_work(context.bot_id,intent['tool'],intent['arguments'],authority=authority)
        if fresh!=effect['selection']:raise PluginError('conflict')
        return observed.value

    async def revalidate_in_transaction(self, db, context, checker):
        """Caller holds PluginService's read lease before its Task lock, never across HTTP."""
        if not callable(checker): raise InvalidWork('plugin_validation_scope_required')
        facts,activity_id=await self._facts(context)
        await self._check(db,context,facts,activity_id)
        task=await self.store._task(db,context.task_id,read=True)
        current=await check_context(db,task,context.run_id,context.correction_token)
        rows=await (await db.execute("SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s "
            "AND status='applied' ORDER BY created_at,id LIMIT 257 FOR SHARE",
            (context.task_id,context.run_id))).fetchall()
        if len(rows)>256: raise WorkConflict('action_limit')
        for row in rows:
            intent=row['intent']
            if canonical(intent)[1]!=row['intent_digest']:raise WorkConflict('work_plugin_intent_changed')
            if intent.get('kind')!='deferred_tool' or intent.get('tool') not in _TOOLS: continue
            if row['authority_generation']!=task['authority_generation']:
                if self.history_reset_on_correction and row['authority_generation']<task['authority_generation']:continue
                from .work_corrections import CorrectionsChanged
                raise CorrectionsChanged('plugin_history_requires_reset')
            effect=self._intent(intent)
            prior=await check_context(db,task,context.run_id,row['correction_context_id'],current=False)
            if ((prior is None)!=(current is None) or prior is not None and
                    (prior['generation'],prior['corrections'])!=(current['generation'],current['corrections'])):
                raise WorkConflict('work_plugin_context_changed')
            original=replace(context,correction_token=row['correction_context_id'])
            await self._check(db,original,facts,activity_id,action_id=row['id'],intent=intent,historical=True)
            if checker(context.bot_id,intent['tool'],intent['arguments'],effect['selection']) is not True:
                raise WorkConflict('work_plugin_grant_changed')
            if await self.results.load_in_transaction(db,row['id'],task_id=context.task_id,
                    run_id=context.run_id,intent_digest=row['intent_digest']) is None:
                raise WorkConflict('tool_result_not_available')
        return True
