"""Native Work knowledge provenance. Employee learning remains inspired by Hermes Agent.

No channel or legacy Run is synthesized. The accepted Activity gate and immutable native
scope are both mandatory; a context/receipt alone grants no authority.
"""
import inspect
from uuid import uuid4
from .knowledge_runtime_values import KnowledgeTarget, KnowledgeUnavailable
from .work_values import WorkConflict


async def binding(db,context,gate):
    from .work_collaboration import lock_task,assert_active
    from .work_task_profiles import resolve_product_source
    from .work_native_scope import provenance
    task=await lock_task(db,context.task_id)
    assert_active(task)
    run=await (await db.execute('SELECT * FROM work_runs WHERE id=%s AND task_id=%s FOR SHARE',
                                (context.run_id,context.task_id))).fetchone()
    if (task['owner_id']!='owner' or task['bot_id']!=context.bot_id or task['status']!='open'
            or not task['authority_active'] or task['cancel_requested'] or not run
            or run['status']!='running' or run['execution_epoch']<1):
        raise KnowledgeUnavailable('knowledge_binding_changed')
    source=provenance(await resolve_product_source(db,task,context.bot_id),'knowledge')
    result=gate(db,context)
    if not inspect.isawaitable(result): raise KnowledgeUnavailable('knowledge_binding_required')
    if await result is not True: raise KnowledgeUnavailable('knowledge_binding_changed')
    return KnowledgeTarget(context,None,None,task['authority_generation'],run['execution_epoch'],source)


async def audit(db,target,kind,payload):
    from .work_store import PostgresWorkStore
    await PostgresWorkStore._event(db,target.context.task_id,kind,dict(payload,executor='work-agent',
        taskId=target.context.task_id,workRunId=target.context.run_id))


async def completed_source(db,task,context,target):
    from .work_task_profiles import resolve_product_source
    from .work_native_scope import provenance
    if (target.context.task_id,target.context.run_id,target.context.bot_id,target.source_run_id,target.source_message_id)!=(
            context.task_id,context.run_id,context.bot_id,None,None):
        raise WorkConflict('knowledge_scope_changed')
    if provenance(await resolve_product_source(db,task,context.bot_id),'knowledge')!=target.native_source:
        raise WorkConflict('knowledge_scope_changed')


async def insert_proposal(db,store,context,action_id,value):
    source=dict(kind='task',taskId=context.task_id,runId=context.run_id)
    existing=await (await db.execute('SELECT * FROM knowledge_proposals WHERE source_work_run_id=%s FOR UPDATE',
                                     (context.run_id,))).fetchone()
    if existing:
        if existing['bot_id']!=context.bot_id or existing['status']!='pending' or any(existing[k]!=v for k,v in value.items()):
            raise WorkConflict('knowledge_proposal_changed')
        return [dict(id=existing['id'],status='pending',source=source)]
    count=(await (await db.execute("SELECT count(*) AS n FROM knowledge_proposals WHERE bot_id=%s AND status='pending'",
                                   (context.bot_id,))).fetchone())['n']
    payload=dict(executor='work-agent',taskId=context.task_id,workRunId=context.run_id,actionId=action_id)
    if count>=50:
        payload['reason']='pending_limit';kind='KNOWLEDGE_PROPOSAL_SKIPPED';result=[]
    else:
        identity=str(uuid4());payload['proposalId']=identity;kind='KNOWLEDGE_PROPOSED'
        await db.execute('INSERT INTO knowledge_proposals(id,bot_id,source_kind,source_work_run_id,kind,title,content) '
            "VALUES (%s,%s,'task',%s,%s,%s,%s)",(identity,context.bot_id,context.run_id,value['kind'],value['title'],value['content']))
        result=[dict(id=identity,status='pending',source=source)]
    if not await (await db.execute("SELECT 1 FROM work_events WHERE task_id=%s AND kind=%s AND payload->>'actionId'=%s",
                                   (context.task_id,kind,action_id))).fetchone():
        await store._event(db,context.task_id,kind,payload)
    return result


async def reviewed_provenance(db,row):
    provenance=row['provenance'];tid=provenance.get('sourceTaskId');rid=provenance.get('sourceWorkRunId');pid=provenance.get('proposalId')
    if any(type(x) is not str for x in (tid,rid,pid)): return False
    # A terminal source cannot be reopened by the product. Its proposal FK is the deletion
    # barrier: hold that row before the unlocked terminal read, so source deletion cannot
    # commit its CASCADE during consumption. Taking an old source Task lock here would invert
    # current Task/Bot -> knowledge order against Owner review's source Task -> Bot order.
    proposal=await (await db.execute("SELECT 1 FROM knowledge_proposals WHERE id=%s AND bot_id=%s AND source_kind='task' "
        "AND source_work_run_id=%s AND memory_id=%s AND status='accepted' FOR SHARE",(pid,row['bot_id'],rid,row['id']))).fetchone()
    if not proposal:return False
    source=await (await db.execute('SELECT t.status AS task_status,r.status FROM work_tasks t JOIN work_runs r ON r.task_id=t.id '
        'WHERE t.id=%s AND r.id=%s AND t.bot_id=%s',(tid,rid,row['bot_id']))).fetchone()
    return bool(source and source['task_status']=='completed' and source['status']=='completed')



async def review_proposal(db,bot_id,proposal_id,value):
    from .employee_knowledge import _one,_now,_insert_memory,_write_memory_event,MEMORY_FIELDS
    from .employee_knowledge_inputs import KnowledgeProposalInput
    from .control_errors import ControlError
    from .work_collaboration import lock_task
    from .work_store import PostgresWorkStore
    original=await _one(db,'SELECT p.*,r.task_id FROM knowledge_proposals p JOIN work_runs r ON r.id=p.source_work_run_id '
        "WHERE p.id=%s AND p.bot_id=%s AND p.source_kind='task'",(proposal_id,bot_id),missing='knowledge_proposal_not_found')
    # Completion owns Task -> Bot capacity -> proposal. Owner review follows the same order.
    task=await lock_task(db,original['task_id'])
    await _one(db,'SELECT id FROM bots WHERE id=%s FOR UPDATE',(bot_id,))
    proposal=await _one(db,'SELECT * FROM knowledge_proposals WHERE id=%s AND bot_id=%s FOR UPDATE',
                        (proposal_id,bot_id),missing='knowledge_proposal_not_found')
    if proposal['status']!='pending': raise ControlError(409,'knowledge_proposal_already_reviewed')
    run=await _one(db,'SELECT task_id,status FROM work_runs WHERE id=%s FOR SHARE',(proposal['source_work_run_id'],),missing='source_task_not_found')
    if (run['task_id']!=task['id'] or task['bot_id']!=bot_id or task['status']!='completed'
            or run['status']!='completed' or not task['completion_digest']):
        raise ControlError(409,'source_task_not_completed')
    now=await _now(db);memory_id=None
    if value['decision']=='accept':
        draft=KnowledgeProposalInput.model_validate(dict(kind=proposal['kind'],title=value['title'],content=value['content'])).model_dump()
        draft.update(sensitivity='internal',portability='never',modelUseEnabled=value['modelUseEnabled'])
        memory=await _insert_memory(db,bot_id,draft,dict(source='reviewed-work-proposal',actor='owner',proposalId=proposal_id,
            sourceTaskId=task['id'],sourceWorkRunId=proposal['source_work_run_id']),now)
        memory_id=memory['id']
        await _write_memory_event(db,bot_id,memory_id,'created',1,list(MEMORY_FIELDS),now)
    await db.execute("UPDATE knowledge_proposals SET status=%s,title='',content='',memory_id=%s,reviewed_at=%s WHERE id=%s",
        ('accepted' if value['decision']=='accept' else 'rejected',memory_id,now,proposal_id))
    await PostgresWorkStore._event(db,task['id'],'KNOWLEDGE_PROPOSAL_REVIEWED',dict(actor='owner',proposalId=proposal_id,
        decision=value['decision'],memoryId=memory_id,workRunId=proposal['source_work_run_id']))
    return dict(proposalId=proposal_id,decision=value['decision'],memoryId=memory_id)
