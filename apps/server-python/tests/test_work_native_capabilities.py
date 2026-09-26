"""Explicit native grants, real PostgreSQL and SDK/MCP; all transports are synthetic."""
import asyncio
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4
import psycopg
import pytest
pytest.importorskip('pydantic_ai',reason='The locked Worker SDK profile is required')
from openbot_agent_runtime.catalog import ToolCatalog
from openbot_server.work_deferred import DeferredActivities
from openbot_server.work_product_knowledge import ProductWorkKnowledge,knowledge_tool_descriptors
from openbot_server.work_product_plugins import WorkPluginAdapter,plugin_tool_descriptors
from openbot_server.work_product_web import WorkWebAdapter,web_tool_descriptors
from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
from openbot_server.knowledge_runtime_values import KnowledgeUnavailable
from openbot_server.work_values import WorkConflict
from openbot_server.plugin_service import PluginService
from openbot_server.plugin_inputs import PluginError
from openbot_server import work_temporal_activity as temporal
from test_work_native_scope import native,anyio_backend,grant,harness,Fixture,SCOPE
from test_plugin_service import remote,installed
from test_public_source import converter,web_remote
from test_work_product_knowledge import DRAFT


async def tools(f,h,adapter,descriptors):
    async def catalog(_):return ToolCatalog(descriptors,max_tools=8,max_bytes=16384)
    h.host.ports.deferred_catalog=catalog;h.host.load_tool_result=adapter.load_result
    activities=DeferredActivities(h.host,adapter.prepare,adapter.load)
    async def prepare(tool,args={}):
        h.env.info=replace(h.env.info,activity_id='prepare-'+uuid4().hex)
        return await h.env.run(activities.prepare_request,dict(call_id='untrusted',tool=tool,arguments=args),h.context.correction_token)
    async def row(identity):
        async with f.store._transaction(trusted=True) as db:return (await f.store._action(db,identity))[1]
    async def execute(identity):
        h.env.info=replace(h.env.info,activity_id='execute-'+identity)
        return await h.env.run(activities.execute,identity)
    async def result(identity):
        h.env.info=replace(h.env.info,activity_id='result-'+identity)
        return (await h.env.run(activities.result,identity))['result']
    return Fixture(**locals())


@pytest.mark.anyio
async def test_native_web_requires_explicit_grant_and_never_resends(native,web_remote):
    f=native
    for scope in (None,grant(f)):
        h=await harness(f,scope);a=WorkWebAdapter(f.store,h.client,SCOPE,f.results,web=web_remote['client'])
        with pytest.raises(WorkConflict):await h.env.run(a.catalog,h.context)
    h=await harness(f,grant(f)|{'web':True},objective='Read https://example.com/evidence');a=WorkWebAdapter(f.store,h.client,SCOPE,f.results,web=web_remote['client'])
    t=await tools(f,h,a,web_tool_descriptors(await h.env.run(a.catalog,h.context)))
    identity=await t.prepare('fetch',{'url':'https://example.com/evidence'})
    assert (await t.execute(identity))['status']=='applied'
    assert (await t.execute(identity))['status']=='applied' and len(web_remote['requests'])==1
    assert (await t.result(identity))['text']=='Synthetic public evidence'
    await f.store.revoke(f.token,h.task['id'])
    with pytest.raises(WorkConflict):await t.result(identity)
    assert len(web_remote['requests'])==1


@pytest.mark.anyio
async def test_native_plugins_intersect_scope_and_live_owner_grant(native,remote,tmp_path):
    f=native;service=PluginService(f.dsn,tmp_path/'plugins.json',local_endpoints=(remote['endpoint'],))
    plugin=await installed(service,dict(token=f.token,botId=f.bot),remote,'confirm')
    for scope in (None,grant(f)):
        h=await harness(f,scope);a=WorkPluginAdapter(f.store,h.client,SCOPE,service,f.results)
        with pytest.raises(WorkConflict):await h.env.run(a.catalog,h.context)
    h=await harness(f,grant(f)|{'plugins':True});a=WorkPluginAdapter(f.store,h.client,SCOPE,service,f.results)
    t=await tools(f,h,a,plugin_tool_descriptors(await h.env.run(a.catalog,h.context)))
    identity=await t.prepare('call_plugin',dict(pluginId=plugin['id'],revision=plugin['revision'],toolName='write_note',arguments={'note':'native synthetic note'}))
    row=await t.row(identity);assert row['requires_approval']
    with pytest.raises(WorkConflict):await t.execute(identity)
    await f.store.decide(f.token,identity,intent_digest=row['intent_digest'],approved=True)
    assert (await t.execute(identity))['status']=='applied'
    assert (await t.execute(identity))['status']=='applied'
    assert remote['effects']==['native synthetic note']
    assert (await t.result(identity))['result']['isError'] is False
    await service.grant(f.token,plugin['id'],f.bot,{'revision':plugin['revision'],'tools':[],'resources':[],'prompts':[]})
    with pytest.raises((WorkConflict,PluginError)):await t.result(identity)
    assert remote['effects']==['native synthetic note']


async def knowledge(f,scope=True):
    h=await harness(f,grant(f)|{'knowledge':scope})
    a=ProductWorkKnowledge(f.store,h.client,SCOPE,f.results,history_reset_on_correction=True)
    return h,a,await tools(f,h,a,knowledge_tool_descriptors())


async def revalidate(f,h,a):
    h.env.info=replace(h.env.info,activity_id='validate-'+uuid4().hex)
    await h.env.run(temporal.claim_current_activity,f.store,h.client,**SCOPE)
    async def check():
        async with f.store._transaction(trusted=True) as db:return await a.revalidate_in_transaction(db,h.context)
    return await h.env.run(check)


@pytest.mark.anyio
async def test_native_knowledge_grant_and_current_owner_content(native):
    f=native;h,a,t=await knowledge(f,False)
    with pytest.raises(WorkConflict):await t.prepare('read_employee_memory')
    owner=PostgresEmployeeKnowledge(f.dsn)
    m=(await owner.create_memory(f.token,f.bot,dict(kind='semantic',title='Fact',content='Reviewed synthetic evidence.',
        sensitivity='internal',portability='never',modelUseEnabled=True)))['memory']
    h,a,t=await knowledge(f)
    action=await t.prepare('read_employee_memory');assert (await t.execute(action))['status']=='applied'
    assert (await t.result(action))['memories'][0]['id']==m['id']
    assert await revalidate(f,h,a) is True
    row=await t.row(action);observed=await f.results.load(action,task_id=h.context.task_id,run_id=h.context.run_id,intent_digest=row['intent_digest'])
    assert observed.value['receipt']['schema']=='openbot.work-knowledge/v2'
    assert observed.value['receipt']['target']['context']['channel_id'] is None
    await owner.update_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,modelUseEnabled=False))
    with pytest.raises(KnowledgeUnavailable):await revalidate(f,h,a)
    with psycopg.connect(f.dsn) as db:
        assert db.execute('SELECT count(*) FROM runs WHERE bot_id=%s',(f.bot,)).fetchone()[0]==0


@pytest.mark.anyio
async def test_native_pending_only_after_verified_commit_then_owner_review(native):
    f=native;h,a,t=await knowledge(f);action=await t.prepare('propose_memory',DRAFT)
    assert (await t.execute(action))['status']=='applied'
    assert (await t.result(action))==dict(status='prepared',requiresOwnerReview=True,activeMemoryChanged=False)
    owner=PostgresEmployeeKnowledge(f.dsn);assert await owner.proposals(f.token,f.bot)==[]
    h.env.info=replace(h.env.info,activity_id='completion')
    await h.env.run(temporal.claim_current_activity,f.store,h.client,**SCOPE)
    async def complete():
        async with f.store._transaction(trusted=True) as db:
            candidate=await a.prepare_completion(db,h.context)
            with pytest.raises(WorkConflict):await a.insert_completed(db,h.context,candidate)
            await db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(h.context.run_id,))
            await db.execute("UPDATE work_tasks SET status='completed',authority_active=false,authority_generation=authority_generation+1,completion_digest=%s WHERE id=%s",('a'*64,h.context.task_id))
            result=await a.insert_completed(db,h.context,candidate)
            assert await a.insert_completed(db,h.context,candidate)==result
            return result
    result=await h.env.run(complete);source=dict(kind='task',taskId=h.context.task_id,runId=h.context.run_id)
    assert result[0]['source']==source
    proposals=await owner.proposals(f.token,f.bot)
    assert len(proposals)==1 and proposals[0]['source']==source and 'sourceRunId' not in proposals[0]
    reviewed=await owner.review_proposal(f.token,f.bot,result[0]['id'],dict(decision='accept',ownerReviewed=True,title=DRAFT['title'],content=DRAFT['content'],modelUseEnabled=True))
    next_h,next_a,next_t=await knowledge(f);read=await next_t.prepare('read_employee_memory')
    assert (await next_t.execute(read))['status']=='applied'
    assert (await next_t.result(read))['memories'][0]['id']==reviewed['memoryId']
    with psycopg.connect(f.dsn) as db:
        assert db.execute('SELECT source_kind,source_run_id,source_work_run_id FROM knowledge_proposals WHERE id=%s',(result[0]['id'],)).fetchone()==('task',None,h.context.run_id)


@pytest.mark.anyio
@pytest.mark.parametrize('change',['delete','correction','cancel','scope','wrong_sdk'])
async def test_native_knowledge_consumption_revalidates_receipt_authority(native,change):
    from psycopg.types.json import Jsonb
    from openbot_server.work_corrections import CorrectionStore,CorrectionsChanged
    from openbot_server.work_values import canonical
    f=native;owner=PostgresEmployeeKnowledge(f.dsn)
    m=(await owner.create_memory(f.token,f.bot,dict(kind='semantic',title='Fact',content='Reviewed evidence',sensitivity='internal',portability='never',modelUseEnabled=True)))['memory']
    h,a,t=await knowledge(f);identity=await t.prepare('read_employee_memory');assert (await t.execute(identity))['status']=='applied'
    if change=='delete':await owner.delete_memory(f.token,f.bot,m['id'],dict(expectedRevision=1,ownerReviewed=True))
    elif change=='cancel':await f.store.cancel(f.token,h.task['id'])
    elif change=='correction':
        snapshot=await f.store.snapshot(f.token,h.task['id'])
        await CorrectionStore(f.store).request(f.token,h.task['id'],run_id=h.context.run_id,instruction='Use a revised scope',expected_sequence=0,request_key=str(uuid4()))
    elif change=='scope':
        with psycopg.connect(f.dsn) as db:
            value=db.execute('SELECT scope FROM work_task_scopes WHERE task_id=%s',(h.task['id'],)).fetchone()[0]
            value['request']['web']=True
            db.execute('UPDATE work_task_scopes SET scope=%s,scope_digest=%s WHERE task_id=%s',(Jsonb(value),canonical(value)[1],h.task['id']))
    else:h.env.info=replace(h.env.info,task_queue='wrong-queue')
    with pytest.raises((KnowledgeUnavailable,WorkConflict,CorrectionsChanged)):await t.result(identity)


@pytest.mark.anyio
async def test_native_proposal_cap_and_rollback(native):
    from openbot_server import work_temporal_activity as temporal
    f=native;h,a,t=await knowledge(f);identity=await t.prepare('propose_memory',DRAFT);await t.execute(identity)
    h.env.info=replace(h.env.info,activity_id='completion-cap')
    await h.env.run(temporal.claim_current_activity,f.store,h.client,**SCOPE)
    with psycopg.connect(f.dsn) as db:
        for i in range(50):
            rid=str(uuid4())
            db.execute('INSERT INTO work_runs(id,task_id,ordinal) VALUES(%s,%s,%s)',(rid,h.task['id'],i+2))
            db.execute("INSERT INTO knowledge_proposals(id,bot_id,source_kind,source_work_run_id,kind,title,content) VALUES(%s,%s,'task',%s,'semantic','Synthetic cap','Synthetic only')",(str(uuid4()),f.bot,rid))
    async def complete(fail):
        async with f.store._transaction(trusted=True) as db:
            candidate=await a.prepare_completion(db,h.context)
            await db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(h.context.run_id,))
            await db.execute("UPDATE work_tasks SET status='completed',authority_active=false,authority_generation=authority_generation+1,completion_digest=%s WHERE id=%s",('a'*64,h.context.task_id))
            assert await a.insert_completed(db,h.context,candidate)==[]
            if fail:raise RuntimeError('synthetic rollback')
    with pytest.raises(RuntimeError):await h.env.run(complete,True)
    assert (await f.store.snapshot(f.token,h.task['id']))['status']=='open'
    await h.env.run(complete,False)
    with psycopg.connect(f.dsn) as db:
        assert db.execute('SELECT count(*) FROM knowledge_proposals WHERE bot_id=%s',(f.bot,)).fetchone()[0]==50
        assert db.execute("SELECT count(*) FROM work_events WHERE task_id=%s AND kind='KNOWLEDGE_PROPOSAL_SKIPPED'",(h.task['id'],)).fetchone()[0]==1


@pytest.mark.anyio
async def test_native_reviewed_skill_catalog_and_revocation(native):
    f=native;owner=PostgresEmployeeKnowledge(f.dsn);slug='native-'+uuid4().hex
    skill=(await owner.import_skill(f.token,f.bot,dict(markdown=f'---\nname: {slug}\ndescription: Check evidence\n---\nKeep source timestamps.\n',version='1.0.0',reason='Synthetic test')))['skill']
    try:
        await owner.set_skill_state(f.token,f.bot,skill['id'],dict(state='verified',reason='Synthetic Owner review',confidence=90,ownerReviewed=True,reviewedContentSha256=skill['contentSha256']))
        h,a,t=await knowledge(f)
        # A merely valid ID is insufficient; reading requires an applied current catalog.
        plan=await t.prepare('read_skill',{'skillId':skill['id']})
        assert (await t.execute(plan))['status']=='unknown'
        catalog=await t.prepare('knowledge_catalog');assert (await t.execute(catalog))['status']=='applied'
        assert (await t.result(catalog))['skills'][0]['id']==skill['id']
        read=await t.prepare('read_skill',{'skillId':skill['id']});assert (await t.execute(read))['status']=='applied'
        assert (await t.result(read))['markdown']==skill['skillMarkdown']
        await owner.set_skill_state(f.token,f.bot,skill['id'],dict(state='revoked',reason='Owner revoked',ownerReviewed=True))
        with pytest.raises(KnowledgeUnavailable):await revalidate(f,h,a)
    finally:
        with psycopg.connect(f.dsn) as db:db.execute('DELETE FROM skills WHERE id=%s',(skill['id'],))


@pytest.mark.anyio
async def test_native_runtime_catalog_exposes_only_implemented_explicit_scope(native,remote,tmp_path):
    from openbot_server.work_product_runtime import ProductWorkRuntime
    from openbot_server.work_sources import WorkSourceAdmission
    from test_work_product_model import CONFIG
    f=native;f.product.model=f.settings;await f.settings.save(CONFIG)
    service=PluginService(f.dsn,tmp_path/'runtime-plugins.json',local_endpoints=(remote['endpoint'],))
    await installed(service,dict(token=f.token,botId=f.bot),remote,'read');f.product.plugins=service
    asset=f.files.owner_persist('evidence.txt',b'synthetic source')
    h=await harness(f,grant(f,[asset['id']])|dict(collaboratorBotIds=[f.peer],knowledge=True,plugins=True,web=True))
    runtime=ProductWorkRuntime(f.store,h.client,SCOPE,f.product,sources=WorkSourceAdmission(f.store,token_limit=1000))
    try:
        prompt=await h.env.run(runtime.load_prompt,h.context)
        services=await h.env.run(runtime.load_services,h.context)
        names={tool.name for tool in services.model_tools}
        assert {'read_attachment','knowledge_catalog','read_skill','read_employee_memory','propose_memory','fetch','call_plugin','read_plugin_resource','start_task','delegate_task','wait_for_task','list_collaborators','write_report'}<=names
        assert not names & {'read_channel_context','read_task_status','list_channel_bots'}
        assert 'evidence.txt' in prompt and 'channelId' not in prompt
        assert remote['effects']==[]
    finally:await service.close()


@pytest.mark.anyio
async def test_native_reviewed_provenance_does_not_invert_source_task_bot_locks(native):
    from psycopg.types.json import Jsonb
    from openbot_server.work_native_knowledge import reviewed_provenance
    from openbot_server.work_collaboration import lock_task
    from test_work_native_scope import args
    f=native;source=await f.store.create(f.token,**args(f,scope=grant(f)|{'knowledge':True}))
    rid=source['runs'][0]['id'];pid=str(uuid4())
    owner=PostgresEmployeeKnowledge(f.dsn)
    memory=(await owner.create_memory(f.token,f.bot,dict(kind='semantic',title='Reviewed fact',content='Synthetic source',sensitivity='internal',portability='never',modelUseEnabled=True)))['memory']
    with psycopg.connect(f.dsn) as db:
        db.execute("UPDATE work_tasks SET status='completed',completion_digest=%s WHERE id=%s",('a'*64,source['id']))
        db.execute("UPDATE work_runs SET status='completed' WHERE id=%s",(rid,))
        db.execute("INSERT INTO knowledge_proposals(id,bot_id,source_kind,source_work_run_id,kind,title,content,status,memory_id,reviewed_at) VALUES(%s,%s,'task',%s,'semantic','','','accepted',%s,clock_timestamp())",(pid,f.bot,rid,memory['id']))
        db.execute('UPDATE employee_memories SET provenance=%s WHERE id=%s',(Jsonb(dict(source='reviewed-work-proposal',sourceTaskId=source['id'],sourceWorkRunId=rid,proposalId=pid,actor='owner')),memory['id']))
    source_locked=asyncio.Event();bot_locked=asyncio.Event()
    async def reviewer():
        async with f.store._transaction(trusted=True) as db:
            await lock_task(db,source['id']);source_locked.set();await bot_locked.wait()
            await db.execute('SELECT id FROM bots WHERE id=%s FOR UPDATE',(f.bot,))
    async def reader():
        await source_locked.wait()
        async with f.store._transaction(trusted=True) as db:
            await db.execute('SELECT id FROM bots WHERE id=%s FOR SHARE',(f.bot,));bot_locked.set()
            row=await (await db.execute('SELECT * FROM employee_memories WHERE id=%s FOR SHARE',(memory['id'],))).fetchone()
            assert await reviewed_provenance(db,row) is True
    await asyncio.wait_for(asyncio.gather(reviewer(),reader()),5)
