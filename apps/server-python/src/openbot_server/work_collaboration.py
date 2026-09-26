"""Short SQL collaboration facts and shared root-to-leaf authority. No scheduler or I/O effects.

Adapted from OpenBot's retained MIT postgres-agent-collaboration implementation. A child
relation is an immutable receipt; reading it never grants authority or creates another child.
"""
from datetime import timedelta
from uuid import uuid4

from psycopg.types.json import Jsonb

from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .task_models import project_run
from .task_store import task_title
from .work_values import WorkConflict, WorkNotFound

MAX_DEPTH = 2
MAX_DESCENDANTS = 4
TREE_SECONDS = 300


async def _links(db, task_id):
    links, seen = [], {task_id}
    while True:
        row = await (await db.execute('SELECT * FROM work_collaborations WHERE child_task_id=%s', (task_id,))).fetchone()
        if row is None: return list(reversed(links))
        if len(links) >= MAX_DEPTH or row['parent_task_id'] in seen:
            raise WorkConflict('collaboration_ancestry_invalid')
        links.append(row); task_id = row['parent_task_id']; seen.add(task_id)


async def root_deadline(db, task_id, run_id):
    """Earliest claim of this exact root Run. Reclaim/restart never extends the tree."""
    row = await (await db.execute("SELECT payload,created_at FROM work_events WHERE task_id=%s "
        "AND kind='run.claimed' AND payload->>'runId'=%s ORDER BY created_at,revision LIMIT 1", (task_id,run_id))).fetchone()
    if (row is None or set(row['payload']) != {'runId','epoch'} or type(row['payload']['epoch']) is not int
            or not 1 <= row['payload']['epoch'] <= 10000):
        raise WorkConflict('collaboration_root_claim_required')
    return row['created_at'] + timedelta(seconds=TREE_SECONDS)


async def lock_task(db, task_id, *, read=False):
    """Replacement for store._task: lock source, then root-to-leaf Task, with no active check.

    The channel advisory lock precedes Task, including roots with no children yet. This makes
    first creation linearize with membership removal/cancel and prevents SHARE->UPDATE races.
    Callers must not hold a descendant Task before entering. Receipt settlement is allowed
    after cancellation; only assert_active/check_active grants *new* work authority.
    """
    links = await _links(db, task_id)
    ids = [links[0]['root_task_id']] + [x['child_task_id'] for x in links] if links else [task_id]
    if (links and links[0]['source_kind']=='task') or await (await db.execute(
            'SELECT 1 FROM work_task_profiles WHERE task_id=%s',(task_id,))).fetchone():
        from .work_native_collaboration import lock_task as lock_native
        return await lock_native(db,task_id,links,ids)
    if links and (links[0]['parent_task_id'] != ids[0] or ids[-1] != task_id):
        raise WorkConflict('collaboration_ancestry_invalid')
    async def source_row(identity):
        return await (await db.execute('SELECT s.*,r.bot_id,r.parent_run_id,r.root_run_id,r.delegated_by_bot_id,'
            'r.execution_profile,r.node_id,r.instruction,r.channel_id AS run_channel,r.source_message_id AS run_message,'
            'm.channel_id AS message_channel,r.created_at AS run_created_at,m.created_at AS message_created_at '
            'FROM work_sources s JOIN runs r ON r.id=s.legacy_run_id JOIN messages m ON m.id=s.source_message_id '
            'WHERE s.task_id=%s', (identity,))).fetchone()
    sources = {}
    for identity in ids:
        source = await source_row(identity)
        if source: sources[identity] = source
    channels = {x['channel_id'] for x in sources.values()}
    if len(channels) > 1 or links and len(sources) != len(ids):
        raise WorkConflict('collaboration_source_changed')
    if channels:
        channel = next(iter(channels))
        await db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,731))', (channel,))
        await db.execute('SELECT id FROM channels WHERE id=%s FOR KEY SHARE', (channel,))
        for identity in ids:
            if identity in sources:
                await db.execute('SELECT id FROM runs WHERE id=%s FOR SHARE', (sources[identity]['legacy_run_id'],))
                refreshed = await source_row(identity)
                if refreshed != sources[identity]: raise WorkConflict('collaboration_source_changed')
    tasks = []
    for identity in ids:
        # One source-channel serialization lock prevents lock upgrades in nested authority checks.
        mode = 'FOR SHARE' if read and not channels else 'FOR UPDATE'
        task = await (await db.execute('SELECT * FROM work_tasks WHERE id=%s '+mode, (identity,))).fetchone()
        if task is None: raise WorkNotFound()
        tasks.append(task)
    if await _links(db, task_id) != links: raise WorkConflict('collaboration_ancestry_changed')
    for index, link in enumerate(links, 1):
        parent, child = sources[ids[index-1]], sources[ids[index]]
        if (link['depth'] != index or link['root_task_id'] != ids[0] or link['parent_task_id'] != ids[index-1]
                or link['child_source_run_id'] != child['legacy_run_id']
                or link['assignment_message_id'] != child['source_message_id']
                or child['parent_run_id'] != parent['legacy_run_id'] or child['root_run_id'] != sources[ids[0]]['legacy_run_id']
                or child['delegated_by_bot_id'] != tasks[index-1]['bot_id']):
            raise WorkConflict('collaboration_ancestry_invalid')
    tree = links[0] if links else await (await db.execute('SELECT * FROM work_collaborations WHERE root_task_id=%s '
        'ORDER BY created_at,creation_action_id LIMIT 1', (task_id,))).fetchone()
    deadline = None
    if tree:
        deadline = await root_deadline(db, ids[0], tree['root_work_run_id'])
        if any(x['deadline_at'] != deadline or x['root_work_run_id'] != tree['root_work_run_id'] for x in links+[tree]):
            raise WorkConflict('collaboration_deadline_changed')
    members = True
    if tree:
        for task in tasks:
            source = sources.get(task['id'])
            if (source is None or source['bot_id'] != task['bot_id'] or source['instruction'] != task['objective']
                    or source['channel_id'] != source['run_channel'] or source['channel_id'] != source['message_channel']
                    or source['source_message_id'] != source['run_message']):
                raise WorkConflict('collaboration_source_changed')
            member = await (await db.execute('SELECT b.computer_profile FROM channel_bots cb JOIN bots b ON b.id=cb.bot_id '
                'WHERE cb.channel_id=%s AND cb.bot_id=%s FOR SHARE OF cb,b', (source['channel_id'],task['bot_id']))).fetchone()
            members = members and bool(member and member['computer_profile'] in ('none','model')
                and source['execution_profile'] in ('none','model') and source['node_id'] is None)
    now = (await (await db.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
    facts = dict(tasks=tuple(dict(x) for x in tasks),sources=sources,links=tuple(links),rootTaskId=ids[0],
        rootWorkRunId=tree['root_work_run_id'] if tree else None,deadline=deadline,members=members,live=deadline is None or now<deadline)
    result = tasks[-1]; result['_collaboration'] = facts
    return result


def assert_active(task):
    facts = task.get('_collaboration')
    if facts is None: return
    if not facts['members'] or not facts['live']:
        raise WorkConflict('collaboration_authority_closed')
    for ancestor in facts['tasks']:
        if not ancestor['authority_active'] or ancestor['cancel_requested'] or ancestor['status'] not in ('queued','open'):
            raise WorkConflict('collaboration_ancestor_closed')


async def check_active(db, task):
    assert_active(task)
    await check_deadline(db,task)


async def check_deadline(db, task):
    """Final fence also runs after this transaction writes its own completed status."""
    deadline = task['_collaboration']['deadline']
    if deadline is not None:
        live = await (await db.execute('SELECT clock_timestamp()<%s AS live', (deadline,))).fetchone()
        if not live['live']: raise WorkConflict('collaboration_deadline_expired')


async def creation_scope(db, task, work_run_id):
    facts = task['_collaboration']; assert_active(task)
    root_id = facts['rootTaskId']; root_run = facts['rootWorkRunId'] or work_run_id
    if not facts['links'] and root_run != work_run_id:
        raise WorkConflict('collaboration_root_run_changed')
    deadline = await root_deadline(db,root_id,root_run)
    live = await (await db.execute('SELECT clock_timestamp()<%s AS live', (deadline,))).fetchone()
    if not live['live']: raise WorkConflict('collaboration_deadline_expired')
    return dict(rootTaskId=root_id,rootWorkRunId=root_run,deadline=deadline.isoformat(),depth=len(facts['links'])+1)


async def cascade(db, store, task_id, *, reason='cancel', include_self=True):
    """Close existing subtree in this transaction; never cancel/forget unknown observations.

    Trusted callers invoke for Owner cancel/revoke, source removal, tree timeout or terminal
    parent failure. Caller already owns authorization. No engine/network call is performed.
    """
    if reason not in ('cancel','revoke','expired','failed'): raise WorkConflict('invalid_collaboration_closure')
    task = await lock_task(db,task_id)
    rows = await (await db.execute('SELECT child_task_id,parent_task_id,depth FROM work_collaborations '
        'WHERE root_task_id=%s ORDER BY depth,child_task_id', (task['_collaboration']['rootTaskId'],))).fetchall()
    selected = {task_id}; order = [task_id] if include_self else []
    for row in rows:
        if row['parent_task_id'] in selected:
            selected.add(row['child_task_id']); order.append(row['child_task_id'])
    for identity in order:
        current = await lock_task(db,identity)
        if current['status'] not in ('queued','open'): continue
        cancel = reason != 'revoke'
        if not current['authority_active'] and (not cancel or current['cancel_requested']): continue
        await db.execute('UPDATE work_tasks SET authority_active=false,authority_generation=authority_generation+1,'
            'cancel_requested=cancel_requested OR %s WHERE id=%s', (cancel,identity))
        current['cancel_requested'] = current['cancel_requested'] or cancel
        await store._finish_cancel(db,current)
        await store._event(db,identity,'task.cancel_requested' if cancel else 'task.authority_revoked',dict(collaborationReason=reason))
    return tuple(order)


async def create_child(db, store, sources, task, action, target, selection, scope, assignment):
    """Caller owns current Action/fence and files lease. One short authoritative SQL effect."""
    original = await receipt(db,action)
    if original is not None: return original
    if task['_collaboration'].get('sourceKind')=='task':
        from .work_native_collaboration import create_child as create_native
        return await create_native(db,store,task,action,target,selection,scope,assignment)
    facts = task['_collaboration']; chain = facts['tasks']; parent = facts['sources'][task['id']]
    if scope['depth'] > MAX_DEPTH or target['id'] in {x['bot_id'] for x in chain}:
        raise WorkConflict('collaboration_task_limit')
    count = await (await db.execute('SELECT count(*) AS n FROM work_collaborations WHERE root_task_id=%s', (scope['rootTaskId'],))).fetchone()
    if count['n'] >= MAX_DESCENDANTS: raise WorkConflict('collaboration_task_limit')
    message_id,run_id = str(uuid4()),str(uuid4())
    await db.execute("INSERT INTO messages(id,channel_id,author_type,author_id,reply_to_message_id,content) VALUES(%s,%s,'bot',%s,%s,%s)",
        (message_id,parent['channel_id'],task['bot_id'],parent['source_message_id'],assignment))
    row = await (await db.execute('INSERT INTO runs(id,channel_id,bot_id,source_message_id,execution_profile,instruction,title,status,'
        'parent_run_id,root_run_id,delegated_by_bot_id,model_selection) '
        "VALUES(%s,%s,%s,%s,%s,%s,%s,'queued',%s,%s,%s,%s) RETURNING *", (run_id,parent['channel_id'],target['id'],message_id,
        target['computer_profile'],assignment,task_title(assignment),parent['legacy_run_id'],facts['sources'][scope['rootTaskId']]['legacy_run_id'],
        task['bot_id'],Jsonb(selection) if selection is not None else None))).fetchone()
    child = await sources.admit(db,project_run(row))
    await db.execute('INSERT INTO work_collaborations(creation_action_id,intent_digest,parent_task_id,parent_work_run_id,'
        'child_task_id,child_work_run_id,child_source_run_id,root_task_id,root_work_run_id,assignment_message_id,depth,deadline_at) '
        'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (action['id'],action['intent_digest'],task['id'],action['run_id'],child['id'],
        child['runs'][0]['id'],run_id,scope['rootTaskId'],scope['rootWorkRunId'],message_id,scope['depth'],scope['deadline']))
    await store._event(db,task['id'],'collaboration.created',dict(actionId=action['id'],childTaskId=child['id'],childRunId=run_id))
    for identity,bot,kind,payload in ((parent['legacy_run_id'],task['bot_id'],'TASK_DELEGATED',dict(childRunId=run_id,targetBotId=target['id'])),
        (run_id,target['id'],'RUN_CREATED',dict(sourceMessageId=message_id,executionProfile=target['computer_profile'])),
        (run_id,task['bot_id'],'MESSAGE_CREATED',dict(messageId=message_id,kind='delegation'))):
        await db.execute('INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) VALUES(%s,%s,%s,%s,%s,%s)',
            (str(uuid4()),identity,parent['channel_id'],bot,kind,Jsonb(payload)))
    return dict(runId=run_id,botId=target['id'],status='queued')


async def receipt(db, action):
    """Recover original committed creation, even after revocation. Never calls create/admit."""
    native=await (await db.execute("SELECT * FROM work_collaborations WHERE creation_action_id=%s AND source_kind='task'",(action['id'],))).fetchone()
    if native:
        from .work_native_collaboration import receipt as native_receipt
        return await native_receipt(db,action,native)
    row = await (await db.execute('SELECT c.*,r.bot_id,r.instruction,r.model_selection,m.author_type,m.author_id,m.content,'
        's.task_id AS mapped_task,s.source_message_id,t.bot_id AS parent_bot FROM work_collaborations c '
        'JOIN runs r ON r.id=c.child_source_run_id JOIN messages m ON m.id=c.assignment_message_id '
        'JOIN work_sources s ON s.legacy_run_id=r.id JOIN work_tasks t ON t.id=c.parent_task_id '
        'WHERE c.creation_action_id=%s', (action['id'],))).fetchone()
    if row is None: return None
    effect = action['intent']['effect']; args = action['intent']['arguments']
    if (action['status'] not in ('admitted','unknown','applied') or action['intent']['tool'] not in ('start_task','delegate_task')
            or row['intent_digest'] != action['intent_digest'] or row['parent_task_id'] != action['task_id']
            or row['parent_work_run_id'] != action['run_id'] or row['mapped_task'] != row['child_task_id']
            or row['source_message_id'] != row['assignment_message_id'] or row['author_type'] != 'bot'
            or row['author_id'] != row['parent_bot'] or row['bot_id'] != args['botId'].lower()
            or row['content'] != args['task'].strip(_ECMASCRIPT_WHITESPACE) or row['instruction'] != args['task'].strip(_ECMASCRIPT_WHITESPACE)
            or row['model_selection'] != effect['target']['modelSelection']
            or row['root_task_id'] != effect['tree']['rootTaskId'] or row['root_work_run_id'] != effect['tree']['rootWorkRunId']
            or row['deadline_at'].isoformat() != effect['tree']['deadline']):
        raise WorkConflict('collaboration_receipt_changed')
    return dict(runId=row['child_source_run_id'],botId=row['bot_id'],status='queued')


async def child_relation(db, parent_task_id, source_run_id):
    row = await (await db.execute('SELECT c.*,t.bot_id,t.status,t.result_summary,t.authority_active,t.cancel_requested '
        'FROM work_collaborations c JOIN work_tasks t ON t.id=c.child_task_id '
        "WHERE c.parent_task_id=%s AND ((c.source_kind='channel' AND c.child_source_run_id=%s) OR (c.source_kind='task' AND c.child_work_run_id=%s))", (parent_task_id,source_run_id,source_run_id))).fetchone()
    if row is None: raise WorkConflict('collaboration_child_not_found')
    return row


def terminal_result(row):
    if row['status'] not in ('completed','failed','cancelled'): return None
    result = dict(runId=row['child_work_run_id'] if row['source_kind']=='task' else row['child_source_run_id'],botId=row['bot_id'],status=row['status'])
    if row['source_kind']=='task':result.update(sourceKind='task',taskId=row['child_task_id'])
    if row['status'] == 'completed':
        if not isinstance(row['result_summary'],str): raise WorkConflict('collaboration_result_missing')
        result['result'] = row['result_summary']
    else: result['error'] = 'child_'+row['status']
    return result
