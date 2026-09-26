"""Native collaboration uses real Work identities and explicit, narrowing Owner scope.

No legacy Run, channel membership or message is fabricated. The retained Temporal workflow
owns waiting and the fixed root deadline; these functions only commit/read bounded SQL facts.
"""
from .work_values import WorkConflict,WorkNotFound


def subset(parent,child,child_bot):
    if parent is None or child is None:return False
    p,c=parent['value'],child['value'];a,b=p['request'],c['request']
    return (child_bot in a['collaboratorBotIds'] and child_bot not in b['collaboratorBotIds']
        and set(b['collaboratorBotIds'])<=set(a['collaboratorBotIds'])
        and set(b['attachmentIds'])<=set(a['attachmentIds'])
        and all(not b[k] or a[k] for k in ('knowledge','plugins','web'))
        and c['attachments']==[x for x in p['attachments'] if x['id'] in b['attachmentIds']])


async def lock_task(db,task_id,links,ids):
    from .work_collaboration import _links,root_deadline
    from .work_task_profiles import resolve_product_source
    if links and (links[0]['parent_task_id']!=ids[0] or ids[-1]!=task_id):
        raise WorkConflict('collaboration_ancestry_invalid')
    # Same root lock covers first child creation and every later root/descendant operation.
    # Unlike the channel lock, its key is a native Work identity, never an invented channel.
    await db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,731))',('native-task:'+ids[0],))
    tasks=[];sources={}
    for identity in ids:
        row=await (await db.execute('SELECT * FROM work_tasks WHERE id=%s FOR UPDATE',(identity,))).fetchone()
        if row is None:raise WorkNotFound()
        tasks.append(row)
        sources[identity]=await resolve_product_source(db,row,row['bot_id'])
        if sources[identity]['source_kind']!='task':raise WorkConflict('collaboration_source_changed')
    if await _links(db,task_id)!=links:raise WorkConflict('collaboration_ancestry_changed')
    for i,link in enumerate(links,1):
        if (link['source_kind']!='task' or link['depth']!=i or link['root_task_id']!=ids[0]
                or link['parent_task_id']!=ids[i-1] or link['child_source_run_id'] is not None
                or link['assignment_message_id'] is not None
                or not subset(sources[ids[i-1]]['native_scope'],sources[ids[i]]['native_scope'],tasks[i]['bot_id'])):
            raise WorkConflict('collaboration_ancestry_invalid')
        for task,run in ((ids[i-1],link['parent_work_run_id']),(ids[i],link['child_work_run_id'])):
            if not await (await db.execute('SELECT 1 FROM work_runs WHERE task_id=%s AND id=%s',(task,run))).fetchone():
                raise WorkConflict('collaboration_ancestry_invalid')
    tree=links[0] if links else await (await db.execute('SELECT * FROM work_collaborations WHERE root_task_id=%s '
        'ORDER BY created_at,creation_action_id LIMIT 1',(task_id,))).fetchone()
    deadline=None;members=True
    if tree:
        deadline=await root_deadline(db,ids[0],tree['root_work_run_id'])
        if any(x['source_kind']!='task' or x['deadline_at']!=deadline or x['root_work_run_id']!=tree['root_work_run_id'] for x in links+[tree]):
            raise WorkConflict('collaboration_deadline_changed')
        for task in tasks:
            bot=await (await db.execute('SELECT computer_profile FROM bots WHERE id=%s FOR SHARE',(task['bot_id'],))).fetchone()
            members=members and bool(bot and bot['computer_profile'] in ('none','model'))
    now=(await (await db.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
    facts=dict(tasks=tuple(dict(t) for t in tasks),sources={},nativeSources=sources,sourceKind='task',links=tuple(links),
        rootTaskId=ids[0],rootWorkRunId=tree['root_work_run_id'] if tree else None,deadline=deadline,members=members,live=deadline is None or now<deadline)
    result=tasks[-1];result['_collaboration']=facts;return result


async def target(db,task,identity,arguments,files,*,check_files):
    from .task_store import attachment_ids
    from .work_native_scope import validate_attachments
    native=task['_collaboration']['nativeSources'][task['id']]['native_scope']
    if native is None or identity not in native['value']['request']['collaboratorBotIds']:
        raise WorkConflict('collaboration_target_not_granted')
    bot=await (await db.execute('SELECT id,computer_profile FROM bots WHERE id=%s FOR SHARE',(identity,))).fetchone()
    if not bot or bot['computer_profile'] not in ('none','model'):raise WorkConflict('collaboration_target_unavailable')
    refs=attachment_ids(arguments['task'])
    if not set(refs)<=set(native['value']['request']['attachmentIds']):raise WorkConflict('collaboration_attachment_not_granted')
    snapshots=[]
    if refs:
        if check_files:
            # Validate only forwarded grants. An unused deleted attachment cannot be silently
            # replaced, but does not revoke a separate child which never received it.
            narrowed=dict(native['value'],request=dict(native['value']['request'],attachmentIds=sorted(refs)),
                attachments=[x for x in native['value']['attachments'] if x['id'] in refs])
            validate_attachments(files,narrowed)
            snapshots=[dict(id=x['id'],sha256=x['sha256']) for x in narrowed['attachments']]
    return bot,snapshots


async def list_collaborators(db,task):
    native=task['_collaboration']['nativeSources'][task['id']]['native_scope']
    if native is None:raise WorkConflict('native_task_capability_unavailable')
    ids=native['value']['request']['collaboratorBotIds'];ancestors={x['bot_id'] for x in task['_collaboration']['tasks']}
    rows=await (await db.execute("SELECT id,left(name,65) AS name,left(role,161) AS role,left(description,2001) AS description "
        "FROM bots WHERE id=ANY(%s) AND computer_profile IN ('none','model') ORDER BY id FOR SHARE",(ids,))).fetchall()
    bots=[dict(x) for x in rows if x['id'] not in ancestors]
    if any(len(x['name'])>64 or len(x['role'])>160 or len(x['description'])>2000 for x in bots):
        raise WorkConflict('collaboration_profile_invalid')
    return dict(bots=bots,truncated=False)


async def create_child(db,store,task,action,target,selection,scope,assignment):
    from .task_store import attachment_ids
    from .work_collaboration import MAX_DEPTH,MAX_DESCENDANTS
    facts=task['_collaboration'];chain=facts['tasks']
    if scope['depth']>MAX_DEPTH or target['id'] in {x['bot_id'] for x in chain}:raise WorkConflict('collaboration_task_limit')
    count=await (await db.execute('SELECT count(*) AS n FROM work_collaborations WHERE root_task_id=%s',(scope['rootTaskId'],))).fetchone()
    if count['n']>=MAX_DESCENDANTS:raise WorkConflict('collaboration_task_limit')
    parent=facts['nativeSources'][task['id']]['native_scope']['value']['request']
    inherited=dict(parent,attachmentIds=sorted(attachment_ids(assignment)),collaboratorBotIds=sorted(
        set(parent['collaboratorBotIds'])-{x['bot_id'] for x in chain}-{target['id']}))
    # The native profile hook captures current model selection in this same transaction. Compare
    # it with the admitted target; a concurrent Bot reconfiguration must not select a new model.
    child=await store.create_in_transaction(db,bot_id=target['id'],objective=assignment,token_limit=task['token_limit'],
        request_key='native-collaboration:'+action['id'],scope=inherited)
    profile=await (await db.execute('SELECT execution_profile,model_selection FROM work_task_profiles WHERE task_id=%s',(child['id'],))).fetchone()
    if not profile or profile['execution_profile']!=target['computer_profile'] or profile['model_selection']!=selection:
        raise WorkConflict('collaboration_target_changed')
    rid=child['runs'][0]['id']
    await db.execute('INSERT INTO work_collaborations(creation_action_id,intent_digest,parent_task_id,parent_work_run_id,child_task_id,'
        'child_work_run_id,root_task_id,root_work_run_id,depth,deadline_at,source_kind) '
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'task')",(action['id'],action['intent_digest'],task['id'],action['run_id'],child['id'],rid,
        scope['rootTaskId'],scope['rootWorkRunId'],scope['depth'],scope['deadline']))
    await store._event(db,task['id'],'collaboration.created',dict(actionId=action['id'],childTaskId=child['id'],childRunId=rid,sourceKind='task'))
    return dict(runId=rid,botId=target['id'],status='queued',sourceKind='task',taskId=child['id'])


async def receipt(db,action,row):
    from .work_task_profiles import resolve_product_source
    from .identity_inputs import _ECMASCRIPT_WHITESPACE
    effect=action['intent']['effect'];args=action['intent']['arguments']
    child=await (await db.execute('SELECT * FROM work_tasks WHERE id=%s',(row['child_task_id'],))).fetchone()
    if not child:raise WorkConflict('collaboration_receipt_changed')
    source=await resolve_product_source(db,child,child['bot_id'])
    from .work_native_scope import provenance
    from .task_store import attachment_ids
    from .work_collaboration import _links
    parent=await (await db.execute('SELECT * FROM work_tasks WHERE id=%s',(row['parent_task_id'],))).fetchone()
    if parent is None:raise WorkConflict('collaboration_receipt_changed')
    parent_source=await resolve_product_source(db,parent,parent['bot_id'])
    if provenance(parent_source,'collaboration')!=effect['source']:raise WorkConflict('collaboration_receipt_changed')
    links=await _links(db,parent['id']);ids=[parent['id']]+[x['parent_task_id'] for x in links]
    ancestors=await (await db.execute('SELECT bot_id FROM work_tasks WHERE id=ANY(%s)',(ids,))).fetchall()
    allowed=parent_source['native_scope']['value']['request']
    inherited=dict(allowed,attachmentIds=sorted(attachment_ids(args['task'])),collaboratorBotIds=sorted(
        set(allowed['collaboratorBotIds'])-{x['bot_id'] for x in ancestors}-{child['bot_id']}))
    if (not subset(parent_source['native_scope'],source['native_scope'],child['bot_id'])
            or source['native_scope']['value']['request']!=inherited):raise WorkConflict('collaboration_receipt_changed')
    if (action['status'] not in ('admitted','unknown','applied') or action['intent']['tool'] not in ('start_task','delegate_task')
            or row['intent_digest']!=action['intent_digest'] or row['parent_task_id']!=action['task_id']
            or row['parent_work_run_id']!=action['run_id'] or row['child_source_run_id'] is not None or row['assignment_message_id'] is not None
            or child['bot_id']!=args['botId'].lower() or child['objective']!=args['task'].strip(_ECMASCRIPT_WHITESPACE)
            or source['source_kind']!='task' or source['model_selection']!=effect['target']['modelSelection']
            or source['execution_profile']!=effect['target']['profile'] or row['root_task_id']!=effect['tree']['rootTaskId']
            or row['root_work_run_id']!=effect['tree']['rootWorkRunId'] or row['deadline_at'].isoformat()!=effect['tree']['deadline']
            or not await (await db.execute('SELECT 1 FROM work_runs WHERE id=%s AND task_id=%s',
                                           (row['child_work_run_id'],row['child_task_id']))).fetchone()):
        raise WorkConflict('collaboration_receipt_changed')
    return dict(runId=row['child_work_run_id'],botId=child['bot_id'],status='queued',sourceKind='task',taskId=child['id'])


async def child_current(db,child,source):
    from .work_task_profiles import resolve_product_source
    from .work_native_scope import provenance
    parent=await (await db.execute('SELECT * FROM work_tasks WHERE id=%s',(child['parent_task_id'],))).fetchone()
    current=await resolve_product_source(db,parent,parent['bot_id'])
    if provenance(current,'collaboration')!=source:raise WorkConflict('collaboration_child_authority_changed')
    task=await (await db.execute('SELECT * FROM work_tasks WHERE id=%s',(child['child_task_id'],))).fetchone()
    own=await resolve_product_source(db,task,task['bot_id'])
    bot=await (await db.execute('SELECT computer_profile FROM bots WHERE id=%s FOR SHARE',(task['bot_id'],))).fetchone()
    if (child['source_kind']!='task' or own['source_kind']!='task' or child['bot_id']!=task['bot_id']
            or not subset(current['native_scope'],own['native_scope'],task['bot_id'])
            or not bot or bot['computer_profile'] not in ('none','model')):
        raise WorkConflict('collaboration_child_authority_changed')
