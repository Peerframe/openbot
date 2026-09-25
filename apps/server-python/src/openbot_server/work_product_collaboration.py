"""Durable local collaboration tool ports. Temporal alone waits/continues child work."""
import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from uuid import UUID

from openbot_agent_runtime.contracts import ToolDescriptor

from . import work_collaboration as tree
from . import work_temporal_activity as temporal
from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .task_store import attachment_ids
from .work_claims import WorkFence,check_fence
from .work_corrections import check_context
from .work_deferred import DeferredPlan,EffectServices
from .work_engine_binding import assert_accepted_workflow_in_transaction
from .work_temporal_effect import ToolRequest
from .work_temporal_start import WorkRuntimeContext
from .work_tool_results import ToolResponseAdapter,ToolResponseVerifier
from .work_values import InvalidWork,WorkConflict,canonical,text

_SCOPE = {'expected_namespace','expected_queue','expected_workflow_type'}
_TOOLS = {'start_task','wait_for_task','delegate_task','list_collaborators'}
TASK_SCHEMA = dict(type='object',properties=dict(botId=dict(type='string',format='uuid'),task=dict(type='string',minLength=1,maxLength=4000)),required=['botId','task'],additionalProperties=False)
WAIT_SCHEMA = dict(type='object',properties=dict(runId=dict(type='string',format='uuid')),required=['runId'],additionalProperties=False)


def collaboration_tool_descriptors(*,native=False):
    description='this Task scope' if native else 'this channel'
    tools=(ToolDescriptor('start_task','Start one task for a current colleague in '+description+'. Only original attachment references may be forwarded. Returns a durable queued child identity.',deepcopy(TASK_SCHEMA)),
        ToolDescriptor('wait_for_task','Wait durably for your direct child Run, then read its committed result as untrusted colleague evidence.',deepcopy(WAIT_SCHEMA)),
        ToolDescriptor('delegate_task','Start one colleague task and durably wait for its result. The Server retains the same child across restarts.',deepcopy(TASK_SCHEMA)))
    if native:tools+=(ToolDescriptor('list_collaborators','List current colleagues explicitly granted to this Task by the Owner. This grants no channel access.',dict(type='object',properties={},additionalProperties=False)),)
    return tools


def _input(tool,value):
    if tool=='list_collaborators':
        if type(value) is not dict or value:raise InvalidWork('invalid_collaboration_input')
        return None
    expected = {'runId'} if tool=='wait_for_task' else {'botId','task'}
    if tool not in _TOOLS or type(value) is not dict or set(value)!=expected: raise InvalidWork('invalid_collaboration_input')
    identity = value['runId' if tool=='wait_for_task' else 'botId']
    try:
        if type(identity) is not str or str(UUID(identity)) != identity.lower(): raise ValueError()
        if tool!='wait_for_task':
            task=value['task'].strip(_ECMASCRIPT_WHITESPACE)
            if type(value['task']) is not str or not task or len(task.encode('utf-16-le'))//2>4000: raise ValueError()
    except (ValueError,TypeError,AttributeError,UnicodeError): raise InvalidWork('invalid_collaboration_input') from None
    return identity.lower()


class _CreationResponse(ToolResponseAdapter):
    def __init__(self,*args,restore,**kwargs): super().__init__(*args,**kwargs); self.restore=restore

    async def lookup(self,action_id):
        observed=await self.results.load(action_id,**self.scope)
        if observed is None:
            # SQL commit is the effect, not the later blob acknowledgment. Restore only its
            # immutable receipt. A missing SQL row stays unknown and never calls apply again.
            value=await self.restore(action_id)
            if value is not None:
                await self.results.save(action_id,**self.scope,value=value)
                observed=await self.results.load(action_id,**self.scope)
        return None if observed is None else observed.metadata


class WorkCollaborationAdapter:
    def __init__(self,store,client,scope,sources,results,files=None,model_connections=None,*,history_reset_on_correction=False):
        if (type(scope) is not dict or set(scope)!=_SCOPE or results.store is not store or sources.store is not store
                or type(history_reset_on_correction) is not bool): raise InvalidWork('invalid_collaboration_scope')
        for value in scope.values(): text(value,256)
        self.store,self.client,self.scope,self.sources,self.results=store,client,dict(scope),sources,results
        self.files,self.model_connections=files,model_connections
        self.history_reset_on_correction=history_reset_on_correction

    async def _facts(self,ctx):
        if type(ctx) is not WorkRuntimeContext: raise WorkConflict('collaboration_context_required')
        info=temporal.activity_info(); activity_id=temporal.current_activity_id(info)
        async with asyncio.timeout(10): facts=await temporal.inspect_activity_start(self.client,info,**self.scope)
        if facts.engine_run_id!=facts.first_run_id: raise WorkConflict('tool_continuation_identity_required')
        return facts,activity_id

    @asynccontextmanager
    async def _files(self,arguments):
        refs=attachment_ids(arguments.get('task',''))
        if refs:
            if self.files is None: raise WorkConflict('collaboration_attachments_unavailable')
            async with self.files.lock(): yield
        else: yield

    async def _source(self,db,ctx,*,historical=False):
        task=await self.store._task(db,ctx.task_id);self.store._active(task)
        facts=task['_collaboration']; source=facts['sources'].get(ctx.task_id)
        run=await (await db.execute('SELECT * FROM work_runs WHERE task_id=%s AND id=%s FOR SHARE',(ctx.task_id,ctx.run_id))).fetchone()
        if facts.get('sourceKind')=='task':
            from .work_native_scope import tool_source
            source=await tool_source(db,task,run,ctx,'collaboration',historical=historical)
            return task,run,source
        if (source is None or run is None or task['bot_id']!=ctx.bot_id or task['objective']!=ctx.objective
                or task['token_limit']!=ctx.token_limit or source['bot_id']!=ctx.bot_id or source['instruction']!=ctx.objective
                or source['channel_id']!=source['run_channel'] or source['channel_id']!=source['message_channel']
                or source['source_message_id']!=source['run_message'] or source['execution_profile'] not in ('none','model') or source['node_id'] is not None
                or run['status'] not in ('queued','running')): raise WorkConflict('collaboration_source_changed')
        member=await (await db.execute('SELECT b.computer_profile FROM channel_bots cb JOIN bots b ON b.id=cb.bot_id '
            'WHERE cb.channel_id=%s AND cb.bot_id=%s FOR SHARE OF cb,b',(source['channel_id'],ctx.bot_id))).fetchone()
        if not member or member['computer_profile'] not in ('none','model'): raise WorkConflict('collaboration_membership_changed')
        await check_context(db,task,ctx.run_id,ctx.correction_token,current=not historical)
        return task,run,dict(legacyRunId=source['legacy_run_id'],channelId=source['channel_id'],sourceMessageId=source['source_message_id'])

    async def _target(self,db,task,source,arguments,*,check_files=True):
        identity=_input('start_task',arguments)
        facts=task['_collaboration']
        if identity in {x['bot_id'] for x in facts['tasks']} or len(facts['links'])>=tree.MAX_DEPTH:
            raise WorkConflict('collaboration_task_limit')
        if source.get('kind')=='task':
            from .work_native_collaboration import target as native_target
            target,snapshots=await native_target(db,task,identity,arguments,self.files,check_files=check_files)
        else:
            target=await (await db.execute('SELECT b.id,b.computer_profile FROM channel_bots cb JOIN bots b ON b.id=cb.bot_id '
                'WHERE cb.channel_id=%s AND cb.bot_id=%s FOR SHARE OF cb,b',(source['channelId'],identity))).fetchone()
            if not target or target['computer_profile'] not in ('none','model'): raise WorkConflict('collaboration_target_unavailable')
            refs=attachment_ids(arguments['task'])
            if not set(refs)<=set(attachment_ids(task['objective'])): raise WorkConflict('collaboration_attachment_not_granted')
            snapshots=[]
            if refs:
                if self.files is None: raise WorkConflict('collaboration_attachments_unavailable')
                if check_files:
                    self.files.validate_references(source['channelId'],refs)
                    for identity in refs:
                        item=self.files.metadata(source['channelId'],identity)
                        snapshots.append(dict(id=identity,sha256=item['sha256']))
        selection=None;model_provenance=None
        if target['computer_profile']=='model':
            if self.model_connections is None: raise WorkConflict('collaboration_model_unavailable')
            selection=await self.model_connections.in_transaction(db,target['id'])
            if type(selection) is not dict: raise WorkConflict('collaboration_model_unavailable')
            resolved=await self.model_connections.resolve_in_transaction(db,selection)
            if resolved is None: raise WorkConflict('collaboration_model_unavailable')
            model_provenance=resolved.provenance()
        return target,dict(botId=target['id'],profile=target['computer_profile'],modelSelection=selection,modelProvenance=model_provenance,attachments=snapshots)

    @staticmethod
    def _intent(intent):
        if (type(intent) is not dict or set(intent)!={'kind','tool','arguments','effect'} or intent['kind']!='deferred_tool'
                or intent['tool'] not in _TOOLS or type(intent['effect']) is not dict): raise InvalidWork('invalid_collaboration_intent')
        _input(intent['tool'],intent['arguments']);effect=intent['effect']
        expected=({'kind','source'} if intent['tool']=='list_collaborators' else
            {'kind','source','tree','child'} if intent['tool']=='wait_for_task' else {'kind','source','tree','target'})
        if set(effect)!=expected or effect['kind']!='product_collaboration': raise InvalidWork('invalid_collaboration_intent')
        canonical(intent);return effect

    async def _check(self,db,ctx,facts,activity_id,*,action_id=None,intent=None,admitted=False,historical=False):
        task,run,source=await self._source(db,ctx,historical=historical)
        await assert_accepted_workflow_in_transaction(self.store,db,dict(taskId=ctx.task_id,runId=ctx.run_id),facts,**self.scope)
        if action_id is None: return task,run,source
        _,action=await self.store._action(db,action_id);effect=self._intent(intent)
        if ((action['task_id'],action['run_id'])!=(ctx.task_id,ctx.run_id) or action['intent']!=intent
                or action['intent_digest']!=canonical(intent)[1] or not action['action_key'].startswith('tool-activity-v1-')
                or (not historical and action['correction_context_id']!=ctx.correction_token) or action['requires_approval'] is not False
                or action['decision']!='not_required' or effect['source']!=source): raise WorkConflict('collaboration_intent_changed')
        if admitted:
            if (action['status']!='admitted' or not action['unexpired'] or action['authority_generation']!=task['authority_generation']
                    or run['status']!='running'): raise WorkConflict('collaboration_not_admitted')
            claim=temporal.derive_claim_id(facts.namespace,facts.workflow_id,facts.engine_run_id,activity_id)
            await check_fence(db,ctx.run_id,WorkFence(ctx.run_id,claim,run['execution_epoch']))
        elif historical:
            if action['status']!='applied': raise WorkConflict('tool_result_not_available')
            current=await check_context(db,task,ctx.run_id,ctx.correction_token)
            if not await self._same_context(db,task,ctx,action,current):
                raise WorkConflict('collaboration_history_requires_reset')
        return task,run,source,action

    async def prepare(self,ctx,proposal):
        if type(proposal) is not ToolRequest or proposal.tool not in _TOOLS or canonical(proposal.arguments)[1]!=proposal.digest:
            raise InvalidWork('invalid_collaboration_proposal')
        _input(proposal.tool,proposal.arguments);facts,activity=await self._facts(ctx)
        async with self._files(proposal.arguments),self.store._transaction(trusted=True) as db:
            task,_,source=await self._check(db,ctx,facts,activity)
            if proposal.tool=='list_collaborators':
                if source.get('kind')!='task':raise WorkConflict('native_collaborators_required')
                return DeferredPlan(dict(kind='product_collaboration',source=source),0,requires_approval=False)
            scope=await tree.creation_scope(db,task,ctx.run_id)
            if proposal.tool=='wait_for_task':
                child=await tree.child_relation(db,ctx.task_id,proposal.arguments['runId'].lower())
                await self._child_current(db,child,source)
                selection=dict(child=self._child(child))
            else:
                _,target=await self._target(db,task,source,proposal.arguments);selection=dict(target=target)
            effect=dict(kind='product_collaboration',source=source,tree=scope,**selection)
            remaining=await (await db.execute('SELECT extract(epoch FROM (%s::timestamptz-clock_timestamp())) AS n',(scope['deadline'],))).fetchone()
            expiry=max(1,min(tree.TREE_SECONDS,int(remaining['n'])))
        return DeferredPlan(effect,0,requires_approval=False,expires_seconds=expiry)

    @staticmethod
    def _child(row):
        return dict(creationActionId=row['creation_action_id'],taskId=row['child_task_id'],workRunId=row['child_work_run_id'],runId=row['child_work_run_id'] if row['source_kind']=='task' else row['child_source_run_id'])

    async def load(self,ctx,intent):
        # Construction is deliberately authority-free: closed historical Actions still need
        # lookup/verification of committed SQL receipts. Only invoke can perform a new effect.
        self._intent(intent)
        async def invoke(action_id,original): return await self.invoke(ctx,action_id,original)
        values=dict(task_id=ctx.task_id,run_id=ctx.run_id,intent_digest=canonical(intent)[1])
        if intent['tool'] in ('wait_for_task','list_collaborators'): adapter=ToolResponseAdapter(self.results,invoke,**values)
        else:
            async def restore(action_id):
                async with self.store._transaction(trusted=True) as db:
                    _,row=await self.store._action(db,action_id)
                    if (row['task_id'],row['run_id'],row['intent_digest'])!=(ctx.task_id,ctx.run_id,values['intent_digest']):
                        raise WorkConflict('collaboration_receipt_changed')
                    return await tree.receipt(db,row)
            adapter=_CreationResponse(self.results,invoke,restore=restore,**values)
        return EffectServices(adapter,ToolResponseVerifier(self.results))

    async def invoke(self,ctx,action_id,intent):
        intent=deepcopy(intent);effect=self._intent(intent);facts,activity=await self._facts(ctx)
        async with self._files(intent['arguments']),self.store._transaction(trusted=True) as db:
            task,run,source,action=await self._check(db,ctx,facts,activity,action_id=action_id,intent=intent,admitted=True)
            if intent['tool']=='list_collaborators':
                if source.get('kind')!='task':raise WorkConflict('native_collaborators_required')
                from .work_native_collaboration import list_collaborators
                value=await list_collaborators(db,task)
                await self._check(db,ctx,facts,activity,action_id=action_id,intent=intent,admitted=True)
                return value
            scope=await tree.creation_scope(db,task,ctx.run_id)
            if scope!=effect['tree']: raise WorkConflict('collaboration_tree_changed')
            if intent['tool']=='wait_for_task':
                child=await tree.child_relation(db,ctx.task_id,intent['arguments']['runId'].lower())
                if self._child(child)!=effect['child']: raise WorkConflict('collaboration_child_changed')
                await self._child_current(db,child,source)
                value=tree.terminal_result(child)
                if value is None: raise WorkConflict('collaboration_child_pending')
            else:
                target,selected=await self._target(db,task,source,intent['arguments'])
                if selected!=effect['target']: raise WorkConflict('collaboration_target_changed')
                value=await tree.create_child(db,self.store,self.sources,task,action,target,selected['modelSelection'],scope,intent['arguments']['task'].strip(_ECMASCRIPT_WHITESPACE))
            # Re-read clock/fence after all awaited configuration/files/SQL, before this commit.
            await self._check(db,ctx,facts,activity,action_id=action_id,intent=intent,admitted=True)
            await tree.creation_scope(db,task,ctx.run_id)
            return value

    async def readiness(self,ctx,row):
        """Short current-authority read, no admission, retry, child creation or wait."""
        intent=row['intent'];effect=self._intent(intent);facts,activity=await self._facts(ctx)
        async with self.store._transaction(trusted=True) as db:
            await self._check(db,ctx,facts,activity,action_id=row['id'],intent=intent)
            if intent['tool']!='wait_for_task': return 'ready'
            child=await tree.child_relation(db,ctx.task_id,intent['arguments']['runId'].lower())
            if self._child(child)!=effect['child']: raise WorkConflict('collaboration_child_changed')
            await self._child_current(db,child,effect['source'])
            return 'ready' if tree.terminal_result(child) is not None else 'pending'

    async def join_request(self,ctx,creation_action_id):
        """Trusted root Activity derives this exact child; feed returned request to normal prepare."""
        facts,activity=await self._facts(ctx)
        async with self.store._transaction(trusted=True) as db:
            await self._check(db,ctx,facts,activity)
            _,row=await self.store._action(db,creation_action_id)
            if (row['task_id'],row['run_id'])!=(ctx.task_id,ctx.run_id) or row['status']!='applied':
                raise WorkConflict('collaboration_creation_not_applied')
            receipt=await tree.receipt(db,row)
            if receipt is None: raise WorkConflict('collaboration_child_not_found')
            arguments=dict(runId=receipt['runId'])
            return ToolRequest('wait_for_task',arguments,canonical(arguments)[1])

    async def _same_context(self,db,task,ctx,row,current):
        prior=await check_context(db,task,ctx.run_id,row['correction_context_id'],current=False)
        if prior is not None and prior['generation']!=row['authority_generation']:
            raise WorkConflict('collaboration_history_changed')
        if row['authority_generation']!=task['authority_generation']: return False
        if prior is None or current is None: return prior is current
        # A new segment freezes a new ID even when the complete trusted history is unchanged.
        return prior['generation']==current['generation'] and prior['corrections']==current['corrections']

    async def _history(self,db,ctx,task,*,current_only=False):
        current=await check_context(db,task,ctx.run_id,ctx.correction_token)
        rows=await (await db.execute("SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s AND status='applied' "
            'ORDER BY created_at,id LIMIT 257 FOR SHARE',(ctx.task_id,ctx.run_id))).fetchall()
        if len(rows)>256: raise WorkConflict('action_limit')
        selected=[]
        for row in rows:
            intent=row['intent']
            # Validate before discriminating: corrupt kind/tool cannot hide a consumed receipt.
            if canonical(intent)[1]!=row['intent_digest']: raise WorkConflict('collaboration_intent_changed')
            if (type(intent) is not dict or (intent.get('tool') not in _TOOLS
                    and (type(intent.get('effect')) is not dict or intent['effect'].get('kind')!='product_collaboration'))):
                continue
            self._intent(intent)
            if not await self._same_context(db,task,ctx,row,current):
                if (current_only or self.history_reset_on_correction) and row['authority_generation']<task['authority_generation']:
                    continue
                raise WorkConflict('collaboration_history_requires_reset')
            selected.append(row)
        return selected

    async def unconsumed_children(self,ctx):
        facts,activity=await self._facts(ctx)
        async with self.store._transaction(trusted=True) as db:
            await self._check(db,ctx,facts,activity)
            return await self.unconsumed_in_transaction(db,ctx)

    async def unconsumed_in_transaction(self,db,ctx):
        """Current-semantic join barrier under the caller's existing Task/source locks.

        The caller owns the accepted SDK Activity/fence proof. This method rechecks current
        Task/source/correction authority without a new connection, network or execution.
        """
        task,_,_=await self._source(db,ctx)
        joins=await self._history(db,ctx,task,current_only=True)
        consumed=set()
        for row in joins:
            if row['intent']['tool']!='wait_for_task': continue
            observed=await self.results.load_in_transaction(db,row['id'],task_id=ctx.task_id,run_id=ctx.run_id,intent_digest=row['intent_digest'])
            if observed is None: raise WorkConflict('tool_result_not_available')
            await self._validate_observation(db,ctx,row,observed.value)
            consumed.add(row['intent']['effect']['child']['creationActionId'])
        rows=await (await db.execute('SELECT creation_action_id FROM work_collaborations WHERE parent_task_id=%s '
            'ORDER BY created_at,creation_action_id LIMIT 5',(ctx.task_id,))).fetchall()
        if len(rows)>tree.MAX_DESCENDANTS: raise WorkConflict('collaboration_task_limit')
        await tree.check_active(db,task)
        return tuple(row['creation_action_id'] for row in rows if row['creation_action_id'] not in consumed)

    async def load_result(self,ctx,row):
        facts,activity=await self._facts(ctx);intent=row['intent'];effect=self._intent(intent)
        async with self.store._transaction(trusted=True) as db:
            await self._check(db,ctx,facts,activity,action_id=row['id'],intent=intent,historical=True)
            observed=await self.results.load_in_transaction(db,row['id'],task_id=ctx.task_id,run_id=ctx.run_id,intent_digest=row['intent_digest'])
            if observed is None: raise WorkConflict('tool_result_not_available')
            await self._validate_observation(db,ctx,row,observed.value)
            return observed.value

    async def _validate_observation(self,db,ctx,row,value):
        effect=self._intent(row['intent'])
        if row['intent']['tool']=='list_collaborators':
            from .work_native_collaboration import list_collaborators
            task=await self.store._task(db,ctx.task_id)
            if effect['source'].get('kind')!='task' or value!=await list_collaborators(db,task):
                raise WorkConflict('collaboration_result_changed')
        elif row['intent']['tool']=='wait_for_task':
            child=await tree.child_relation(db,ctx.task_id,row['intent']['arguments']['runId'].lower())
            if self._child(child)!=effect['child'] or tree.terminal_result(child)!=value:
                raise WorkConflict('collaboration_result_changed')
            await self._child_current(db,child,effect['source'])
        elif await tree.receipt(db,row)!=value: raise WorkConflict('collaboration_result_changed')

    async def _child_current(self,db,child,source):
        if source.get('kind')=='task':
            from .work_native_collaboration import child_current
            return await child_current(db,child,source)
        # Completed work closes execution authority, not the need for current source membership.
        row=await (await db.execute('SELECT r.bot_id,r.channel_id,r.execution_profile,r.node_id,s.task_id,s.source_message_id '
            'FROM runs r JOIN work_sources s ON s.legacy_run_id=r.id WHERE r.id=%s FOR SHARE OF r',
            (child['child_source_run_id'],))).fetchone()
        member=await (await db.execute('SELECT b.computer_profile FROM channel_bots cb JOIN bots b ON b.id=cb.bot_id '
            'WHERE cb.channel_id=%s AND cb.bot_id=%s FOR SHARE OF cb,b',
            (source['channelId'],child['bot_id']))).fetchone()
        if (row is None or member is None or row['task_id']!=child['child_task_id']
                or row['bot_id']!=child['bot_id'] or row['channel_id']!=source['channelId']
                or row['source_message_id']!=child['assignment_message_id'] or row['node_id'] is not None
                or row['execution_profile'] not in ('none','model') or member['computer_profile'] not in ('none','model')):
            raise WorkConflict('collaboration_child_authority_changed')

    async def revalidate_in_transaction(self,db,ctx):
        task,_,_=await self._source(db,ctx)
        rows=await self._history(db,ctx,task)
        for row in rows:
            observed=await self.results.load_in_transaction(db,row['id'],task_id=ctx.task_id,run_id=ctx.run_id,intent_digest=row['intent_digest'])
            if observed is None: raise WorkConflict('tool_result_not_available')
            await self._validate_observation(db,ctx,row,observed.value)
        await tree.check_active(db,task)
        return True

    async def collect_results(self,ctx):
        facts,activity=await self._facts(ctx)
        async with self.store._transaction(trusted=True) as db:
            task,_,_=await self._check(db,ctx,facts,activity)
            rows=await self._history(db,ctx,task,current_only=True)
        return tuple([dict(actionId=row['id'],payload=await self.load_result(ctx,row)) for row in rows])
