"""Actual PostgreSQL native tree authority and SDK Activity calls; no engine/network loop."""
import asyncio
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4
import psycopg
from psycopg.types.json import Jsonb
import pytest
pytest.importorskip('pydantic_ai',reason='The locked Worker SDK profile is required')
from openbot_server.work_product_collaboration import WorkCollaborationAdapter,collaboration_tool_descriptors
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_collaboration_activities import CollaborationActivities
from openbot_server.work_values import WorkConflict,canonical
from openbot_server.work_task_profiles import resolve_product_source,product_capabilities
from test_work_native_scope import native,anyio_backend,grant,harness,Fixture,SCOPE
from test_work_native_capabilities import tools


async def setup(f,*,scope=None,objective=None,existing=None):
    h=await harness(f,scope if scope is not None else grant(f)|dict(collaboratorBotIds=[f.peer]),objective=objective,existing=existing)
    await f.store.claim(h.task['id'],h.context.run_id,'initial-model-'+h.context.run_id)
    sources=WorkSourceAdmission(f.store,token_limit=1000)
    a=WorkCollaborationAdapter(f.store,h.client,SCOPE,sources,f.results,f.files,history_reset_on_correction=True)
    t=await tools(f,h,a,collaboration_tool_descriptors(native=True))
    async def relations():
        async with f.store._transaction(trusted=True) as db:
            return await (await db.execute('SELECT * FROM work_collaborations WHERE parent_task_id=%s ORDER BY created_at',(h.task['id'],))).fetchall()
    return Fixture(**locals())


@pytest.mark.anyio
async def test_native_tree_keeps_real_identity_and_narrowed_attachment_scope(native):
    f=native;one=f.files.owner_persist('one.txt',b'one');two=f.files.owner_persist('two.txt',b'two')
    scope=grant(f,[one['id'],two['id']])|dict(collaboratorBotIds=[f.peer],knowledge=True,web=True)
    n=await setup(f,scope=scope)
    listing=await n.t.prepare('list_collaborators');assert (await n.t.execute(listing))['status']=='applied'
    assert [x['id'] for x in (await n.t.result(listing))['bots']]==[f.peer]
    assignment='Review [OpenBot attachment: '+one['id']+']'
    identity=await n.t.prepare('start_task',dict(botId=f.peer,task=assignment))
    assert (await n.t.execute(identity))['status']=='applied'
    assert (await n.t.execute(identity))['status']=='applied'
    child=(await n.relations())[0];value=await n.t.result(identity)
    assert value==dict(runId=child['child_work_run_id'],taskId=child['child_task_id'],sourceKind='task',status='queued',botId=f.peer)
    assert child['child_source_run_id'] is None and child['assignment_message_id'] is None
    async with f.store._transaction(trusted=True) as db:
        task=await f.store._task(db,child['child_task_id']);source=await resolve_product_source(db,task,f.peer)
        captured=source['native_scope']['value']['request']
        assert captured['attachmentIds']==[one['id']] and captured['collaboratorBotIds']==[]
        assert product_capabilities(source)==frozenset(('model','report','result_review','attachments','knowledge','web'))
        root=await f.store._task(db,n.h.task['id'])
        assert task['_collaboration']['deadline']==root['_collaboration']['deadline']
        assert (task['_collaboration']['deadline']-(await (await db.execute("SELECT created_at FROM work_events WHERE task_id=%s AND kind='run.claimed' ORDER BY revision LIMIT 1",(root['id'],))).fetchone())['created_at']).total_seconds()==300
        assert (await (await db.execute('SELECT count(*) AS n FROM runs WHERE bot_id=ANY(%s)',([f.bot,f.peer],))).fetchone())['n']==0
        assert (await (await db.execute('SELECT count(*) AS n FROM channel_bots WHERE bot_id=ANY(%s)',([f.bot,f.peer],))).fetchone())['n']==0
    assert await n.h.env.run(n.a.unconsumed_children,n.h.context)==(identity,)
    join=await n.h.env.run(n.a.join_request,n.h.context,identity)
    assert join.arguments==dict(runId=child['child_work_run_id'])
    wait=await n.t.prepare('wait_for_task',join.arguments)
    assert await n.h.env.run(n.a.readiness,n.h.context,await n.t.row(wait))=='pending'
    with psycopg.connect(f.dsn) as db:
        db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(child['child_work_run_id'],))
        db.execute("UPDATE work_tasks SET status='completed',result_summary='Synthetic committed child answer' WHERE id=%s",(child['child_task_id'],))
    assert (await n.t.execute(wait))['status']=='applied'
    assert (await n.t.result(wait))['result']=='Synthetic committed child answer'
    assert await n.h.env.run(n.a.unconsumed_children,n.h.context)==()


@pytest.mark.anyio
@pytest.mark.parametrize('lost',[True,False])
async def test_native_child_unknown_restores_only_committed_sql(native,lost):
    n=await setup(native);identity=await n.t.prepare('delegate_task',dict(botId=native.peer,task='Review evidence'))
    if lost:
        with patch.object(native.results,'save',side_effect=asyncio.CancelledError()),pytest.raises(asyncio.CancelledError):await n.t.execute(identity)
        assert len(await n.relations())==1
    else:
        with patch.object(n.a,'invoke',side_effect=ConnectionError('synthetic lost')):assert (await n.t.execute(identity))['status']=='unknown'
    with patch.object(n.a,'invoke',side_effect=AssertionError('No resend')):
        assert (await n.t.execute(identity))['status']==('applied' if lost else 'unknown')
    assert len(await n.relations())==(1 if lost else 0)


@pytest.mark.anyio
@pytest.mark.parametrize('change',['ungranted_bot','self','ungranted_asset','deleted_asset','disabled_bot','absent_scope'])
async def test_native_no_scope_widening_or_disabled_target(native,change):
    f=native;asset=f.files.owner_persist('one.txt',b'one');scope=grant(f,[asset['id']])|dict(collaboratorBotIds=[f.peer])
    if change=='absent_scope':scope=grant(f)
    n=await setup(f,scope=scope);args=dict(botId=f.peer,task='Review evidence')
    if change=='ungranted_bot':args['botId']=str(uuid4())
    if change=='self':args['botId']=f.bot
    if change=='ungranted_asset':args['task']='Read [OpenBot attachment: '+str(uuid4())+']'
    if change=='deleted_asset':
        args['task']='Read [OpenBot attachment: '+asset['id']+']';f.files.owner_set_deleted(asset['id'],True)
    if change=='disabled_bot':
        with psycopg.connect(f.dsn) as db:db.execute("UPDATE bots SET computer_profile='browser' WHERE id=%s",(f.peer,))
    with pytest.raises(WorkConflict):await n.t.prepare('start_task',args)
    assert await n.relations()==[]


@pytest.mark.anyio
async def test_native_cancel_closes_real_descendant_without_legacy_rows(native):
    f=native;n=await setup(f);identity=await n.t.prepare('start_task',dict(botId=f.peer,task='Review evidence'))
    await n.t.execute(identity);child=(await n.relations())[0]
    await f.store.cancel(f.token,n.h.task['id'])
    task=await f.store.snapshot(f.token,child['child_task_id'])
    assert task['authorityActive'] is False
    with pytest.raises(WorkConflict):await n.t.result(identity)
    row=await n.t.row(identity)
    services=await n.a.load(n.h.context,row['intent'])
    with patch.object(n.a,'invoke',side_effect=AssertionError('No resend')):
        assert await services.adapter.lookup(identity) is not None


@pytest.mark.anyio
async def test_native_child_scope_corruption_and_fixed_deadline_refuse(native):
    f=native;n=await setup(f);identity=await n.t.prepare('start_task',dict(botId=f.peer,task='Review evidence'));await n.t.execute(identity)
    child=(await n.relations())[0]
    with psycopg.connect(f.dsn) as db:
        value=db.execute('SELECT scope FROM work_task_scopes WHERE task_id=%s',(child['child_task_id'],)).fetchone()[0]
        original=value.copy();value={**value,'request':{**value['request'],'web':True}}
        db.execute('UPDATE work_task_scopes SET scope=%s,scope_digest=%s WHERE task_id=%s',(Jsonb(value),canonical(value)[1],child['child_task_id']))
    with pytest.raises(WorkConflict):await n.t.result(identity)
    with psycopg.connect(f.dsn) as db:
        db.execute('UPDATE work_task_scopes SET scope=%s,scope_digest=%s WHERE task_id=%s',(Jsonb(original),canonical(original)[1],child['child_task_id']))
        db.execute("UPDATE work_events SET created_at=created_at-interval '301 seconds' WHERE task_id=%s AND kind='run.claimed'",(n.h.task['id'],))
    with pytest.raises(WorkConflict):await n.t.prepare('start_task',dict(botId=f.peer,task='After deadline'))


@pytest.mark.anyio
async def test_native_two_level_subset_and_server_deadline_observation(native):
    f=native;third,fourth=str(uuid4()),str(uuid4());f.bots.extend([third,fourth])
    with psycopg.connect(f.dsn) as db:
        for bot in (third,fourth):db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'Analyst','none')",(bot,'Native '+bot))
    n=await setup(f,scope=grant(f)|dict(collaboratorBotIds=[f.peer,third,fourth],knowledge=True))
    root_action=await n.t.prepare('start_task',dict(botId=f.peer,task='Review evidence'));await n.t.execute(root_action)
    child=(await n.relations())[0];c=await setup(f,existing=child['child_task_id'])
    with pytest.raises(WorkConflict):await c.t.prepare('start_task',dict(botId=f.bot,task='Ancestor not authorized'))
    identity=await c.t.prepare('start_task',dict(botId=third,task='Review subsidiary evidence'));assert (await c.t.execute(identity))['status']=='applied'
    grand=(await c.relations())[0];g=await setup(f,existing=grand['child_task_id'])
    with pytest.raises(WorkConflict,match='task_limit'):await g.t.prepare('start_task',dict(botId=fourth,task='Exceeds depth'))
    deadlines=[]
    for current in (n,c,g):
        current.h.host.deferred=current.t.activities
        observer=CollaborationActivities(current.h.host,current.a.join_request,current.a.unconsumed_children)
        deadlines.append(await current.h.env.run(observer.observed_deadline))
    assert deadlines[0]==deadlines[1]==deadlines[2]
    assert deadlines[0]['rootTaskId']==n.h.context.task_id and deadlines[0]['rootRunId']==n.h.context.run_id
    with psycopg.connect(f.dsn) as db:
        assert db.execute('SELECT scope->\'request\'->\'collaboratorBotIds\' FROM work_task_scopes WHERE task_id=%s',(grand['child_task_id'],)).fetchone()[0]==[fourth]
    await f.store.revoke(f.token,n.h.task['id'])
    with pytest.raises(WorkConflict):await g.t.prepare('list_collaborators')


@pytest.mark.anyio
async def test_native_concurrent_same_creation_and_cancel_have_no_duplicate(native):
    f=native;n=await setup(f);identity=await n.t.prepare('start_task',dict(botId=f.peer,task='Review evidence'))
    outcomes=await asyncio.gather(n.t.execute(identity),n.t.execute(identity),return_exceptions=True)
    assert any(isinstance(x,dict) and x['status']=='applied' for x in outcomes)
    assert len(await n.relations())==1
    await asyncio.wait_for(asyncio.gather(f.store.cancel(f.token,n.h.task['id']),f.store.cancel(f.token,n.h.task['id'])),10)
    child=(await n.relations())[0]
    assert not (await f.store.snapshot(f.token,child['child_task_id']))['authorityActive']
