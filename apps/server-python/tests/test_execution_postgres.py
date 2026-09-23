"""Persisted lifecycle with real PostgreSQL locks; no live models or private database."""
import asyncio
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
import pytest

from openbot_server.database import StoreUnavailable
from openbot_server.execution_completion import PendingSteering
from openbot_server.execution_store import PostgresExecutionStore
from openbot_server.run_command_store import PostgresRunCommandStore, RunCommandConflict
from openbot_server.runtime_ports import RuntimeDenied
from openbot_server.task_inputs import parse_message
from openbot_server.task_models import RunUsage, project_run
from openbot_server.task_store import PostgresTaskStore
from test_auth_postgres import authentication
from test_task_postgres import prepare
from test_run_command_postgres import child

SINCE = '2000-01-01T00:00:00Z'


@pytest.fixture
def execution(fixture):
    yield fixture
    # Only rows owned by this module. Do not leave test roots consuming the global six-root gate.
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("UPDATE runs SET status='failed' WHERE status='running' AND bot_id IN "
                           "(SELECT id FROM bots WHERE name LIKE 'Lifecycle %')")


def queued(fixture,label):
    first,chief,channel = prepare(fixture,'Lifecycle '+label)
    run = asyncio.run(PostgresTaskStore(fixture['dsn']).submit(fixture['token'],channel.id,
        parse_message({'content':'Verify the evidence','botId':first.id}))).run
    return run,chief


def running(fixture,label):
    run,chief = queued(fixture,label)
    result = asyncio.run(PostgresExecutionStore(fixture['dsn']).claim(run,SINCE))
    assert result is not None and result.status == 'running'
    return result,chief


def read(fixture,identity):
    with psycopg.connect(fixture['dsn'],row_factory=dict_row) as connection:
        return project_run(connection.execute('SELECT * FROM runs WHERE id=%s',(identity,)).fetchone())


def events(fixture,identity):
    with psycopg.connect(fixture['dsn']) as connection:
        return connection.execute('SELECT type,payload FROM run_events WHERE run_id=%s ORDER BY created_at,id',(identity,)).fetchall()


def counts(fixture,identity):
    with psycopg.connect(fixture['dsn']) as connection:
        return tuple(connection.execute(query,(identity,)).fetchone()[0] for query in (
            "SELECT count(*) FROM messages WHERE run_id=%s AND author_type='bot'",
            'SELECT count(*) FROM artifacts WHERE run_id=%s',
            'SELECT count(*) FROM knowledge_proposals WHERE source_run_id=%s'))


def usage(step=1,*,model='fixture'):
    return RunUsage(provider='deepseek',model=model,steps=step,inputTokens=None,outputTokens=step*2)


async def wait_for_lock(fixture):
    async with await psycopg.AsyncConnection.connect(fixture['dsn'],autocommit=True) as connection:
        for _ in range(80):
            cursor = await connection.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='openbot-control-execution' AND wait_event_type='Lock'")
            if (await cursor.fetchone())[0]:
                return
            await asyncio.sleep(0.01)
    pytest.fail('Execution writer did not reach the database lock')


def evidence(fixture,run):
    memory_id,skill_id = str(uuid4()),str(uuid4())
    markdown = '---\nname: fixture\ndescription: checked\n---\nVerify facts.'
    digest = hashlib.sha256(markdown.encode()).hexdigest()
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("INSERT INTO employee_memories(id,bot_id,kind,title,content,model_use_enabled) "
            "VALUES (%s,%s,'semantic','Reviewed fact','Verified evidence',true)",(memory_id,run.botId))
        connection.execute("INSERT INTO skills(id,slug,name,description,version,source,content_sha256,skill_markdown) "
            "VALUES (%s,%s,'Fixture','checked','1.0.0','manual',%s,%s)",(skill_id,'fixture-'+skill_id,digest,markdown))
        connection.execute("INSERT INTO employee_skills(bot_id,skill_id,state,reviewed_content_sha256) "
            "VALUES (%s,%s,'verified',%s)",(run.botId,skill_id,digest))
    return {'id':memory_id,'revision':1},{'id':skill_id,'revision':1,'sha256':digest}


def artifact(fixture,run,text='# Evidence\nVerified locally.\n'):
    identity = str(uuid4())
    key = f'runs/{run.id}/{identity}.md'
    path = Path(fixture['artifactDirectory'])/key
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(text.encode())
    return {'artifact':{'id':identity,'runId':run.id,'name':'Evidence.md','mediaType':'text/markdown',
        'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'sizeBytes':path.stat().st_size,
        'createdAt':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')},
        'storageKey':key,'metadata':{'generator':'owned-fixture'}}


def test_concurrent_claims_have_one_winner_and_serialize_each_bot_channel(execution):
    fixture=execution
    run,_=queued(fixture,'claim contenders')
    other=asyncio.run(PostgresTaskStore(fixture['dsn']).submit(fixture['token'],run.channelId,parse_message({'content':'Second','botId':run.botId}))).run
    async def check():
        store=PostgresExecutionStore(fixture['dsn'])
        results=await asyncio.gather(*(store.claim(candidate,SINCE) for candidate in (run,run,other)))
        winners=[r for r in results if r is not None]
        assert len(winners)==1
        assert Counter(kind for kind,_ in events(fixture,winners[0].id))['RUN_STARTED']==1
        await store.fail(winners[0])
        loser=other if winners[0].id==run.id else run
        assert (await store.claim(loser,SINCE)).status=='running'
    asyncio.run(check())


def test_six_root_global_gate_across_channels_and_release(execution):
    fixture=execution
    candidates=[queued(fixture,f'root capacity {i}')[0] for i in range(7)]
    async def check():
        store=PostgresExecutionStore(fixture['dsn'])
        winners=[]
        for candidate in candidates:
            value=await store.claim(candidate,SINCE)
            if value is not None:
                winners.append(value)
        assert len(winners)==6
        assert await store.claim(candidates[-1],SINCE) is None
        await store.fail(winners[0])
        assert (await store.claim(candidates[-1],SINCE)).status=='running'
    asyncio.run(check())


def test_claim_uses_persisted_identity_membership_profile_and_startup_cutoff(execution):
    fixture=execution
    since=datetime.now(timezone.utc)
    run,chief=queued(fixture,'claim eligibility')
    store=PostgresExecutionStore(fixture['dsn'])
    assert run.id in {r.id for r in asyncio.run(store.queued(since))}
    assert asyncio.run(store.claim(run.model_copy(update={'botId':chief.id}),SINCE)) is None
    assert asyncio.run(store.claim(run,'2099-01-01T00:00:00Z')) is None
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(run.channelId,run.botId))
    assert asyncio.run(store.claim(run,SINCE)) is None
    assert read(fixture,run.id).status=='queued'


def test_claim_audit_failure_rolls_back_transition(execution):
    fixture=execution
    run,_=queued(fixture,'claim audit rollback')
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("CREATE FUNCTION execution_reject_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type='RUN_STARTED' THEN RAISE EXCEPTION 'private fixture'; END IF; RETURN NEW; END $$")
        connection.execute('CREATE TRIGGER execution_reject_start BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION execution_reject_start()')
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresExecutionStore(fixture['dsn']).claim(run,SINCE))
        assert read(fixture,run.id).status=='queued'
        assert not any(kind=='RUN_STARTED' for kind,_ in events(fixture,run.id))
    finally:
        with psycopg.connect(fixture['dsn']) as connection:
            connection.execute('DROP TRIGGER execution_reject_start ON run_events')
            connection.execute('DROP FUNCTION execution_reject_start()')


def test_background_execution_survives_owner_logout_but_not_revoked_membership(execution):
    fixture=execution
    run,_=running(fixture,'cookie independence')
    issued=asyncio.run(authentication(fixture).login(fixture['ownerPassword'],'192.0.2.85'))
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=%s',
                           (hashlib.sha256(issued.token.encode()).hexdigest(),))
    store=PostgresExecutionStore(fixture['dsn'])
    asyncio.run(store.assert_active(run))
    assert asyncio.run(store.usage(run,usage())).modelUsage.inputTokens is None
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(run.channelId,run.botId))
    for operation in (store.assert_active(run),store.usage(run,usage(2)),store.progress(run,'model','Late')):
        with pytest.raises(RuntimeDenied) as denied:
            asyncio.run(operation)
        assert denied.value.code=='scope_revoked'
    assert asyncio.run(store.fail(run,'scope_revoked')).status=='failed'


def test_ancestry_is_loaded_from_storage_and_cycles_scope_and_forged_roots_fail(execution):
    fixture=execution
    root,chief=running(fixture,'ancestor authority')
    with psycopg.connect(fixture['dsn']) as connection:
        child_id=child(connection,root,chief.id)
    descendant=read(fixture,child_id).model_copy(update={'parentRunId':None,'rootRunId':None,'delegatedByBotId':None})
    store=PostgresExecutionStore(fixture['dsn'])
    asyncio.run(store.assert_active(descendant))
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(root.channelId,root.botId))
    with pytest.raises(RuntimeDenied) as denied:
        asyncio.run(store.assert_active(descendant))
    assert denied.value.code=='scope_revoked'
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES (%s,%s)',(root.channelId,root.botId))
        connection.execute('UPDATE runs SET parent_run_id=%s,root_run_id=%s,delegated_by_bot_id=%s WHERE id=%s',
                           (child_id,child_id,chief.id,root.id))
    with pytest.raises(RuntimeDenied) as denied:
        asyncio.run(store.assert_active(descendant))
    assert denied.value.code=='invalid_target'


def test_usage_cas_rejects_duplicates_skips_and_changed_provider_identity(execution):
    fixture=execution
    run,_=running(fixture,'usage CAS')
    async def check():
        store=PostgresExecutionStore(fixture['dsn'])
        results=await asyncio.gather(store.usage(run,usage()),store.usage(run,usage()),return_exceptions=True)
        assert sum(isinstance(v,RuntimeDenied) for v in results)==1
        for value in (usage(3),usage(2,model='different')):
            with pytest.raises(RuntimeDenied):
                await store.usage(run,value)
        await store.usage(run,usage(2))
        assert (await store.current(run)).modelUsage.steps==2
    asyncio.run(check())
    rows=[payload for kind,payload in events(fixture,run.id) if kind=='MODEL_USAGE_RECORDED']
    assert len(rows)==2 and rows[-1]['inputTokens'] is None


def test_failure_cancels_descendants_once_and_cannot_replace_cancellation(execution):
    fixture=execution
    run,chief=running(fixture,'failure cascade')
    with psycopg.connect(fixture['dsn']) as connection:
        child_id=child(connection,run,chief.id)
    store=PostgresExecutionStore(fixture['dsn'])
    failed=asyncio.run(store.fail(run,'model_unavailable'))
    assert failed.status=='failed' and failed.errorCode=='model_unavailable'
    assert read(fixture,child_id).status=='cancelled'
    assert ('RUN_CANCELLED',{'executor':'native-agent','actor':'ancestor-failure','ancestorRunId':run.id}) in events(fixture,child_id)
    assert asyncio.run(store.fail(run)) is None
    other,_=running(fixture,'failure after cancellation')
    asyncio.run(PostgresRunCommandStore(fixture['dsn']).cancel(fixture['token'],other.id))
    assert asyncio.run(store.fail(other)) is None
    assert read(fixture,other.id).status=='cancelled'


def test_completion_preserves_artifacts_references_proposal_and_steering(execution):
    fixture=execution
    run,_=running(fixture,'complete all assets')
    memory,skill=evidence(fixture,run)
    record=artifact(fixture,run)
    correction=asyncio.run(PostgresRunCommandStore(fixture['dsn']).steer(fixture['token'],run.id,'Separate evidence from inference.'))
    store=PostgresExecutionStore(fixture['dsn'])
    with pytest.raises(PendingSteering):
        asyncio.run(store.complete(run,'Delivered.',artifacts=[record],references=[memory],skill_references=[skill]))
    assert counts(fixture,run.id)==(0,0,0) and read(fixture,run.id).status=='running'
    result=asyncio.run(store.complete(run,'Delivered.',artifacts=[record],references=[memory],skill_references=[skill],
        proposal={'kind':'procedural','title':'Check evidence','content':'Separate facts from inference.'},applied_steering_ids=[correction.id]))
    assert result.run.status=='completed' and result.message.runId==run.id and result.message.replyToMessageId==run.sourceMessageId
    assert counts(fixture,run.id)==(1,1,1)
    with psycopg.connect(fixture['dsn']) as connection:
        assert connection.execute('SELECT status,memory_id FROM knowledge_proposals WHERE source_run_id=%s',(run.id,)).fetchone()==('pending',None)
    expected={'run':result.run.model_dump(mode='json',exclude_none=True),'message':result.message.model_dump(mode='json',exclude_none=True),
              'artifacts':[r.model_dump(mode='json') for r in result.artifacts],'storageKey':record['storageKey']}
    with os.fdopen(os.open(fixture['executionResult'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as output:
        json.dump(expected,output)


def test_two_completions_publish_exactly_one_reply(execution):
    fixture=execution
    run,_=running(fixture,'complete contenders')
    async def check():
        store=PostgresExecutionStore(fixture['dsn'])
        results=await asyncio.gather(store.complete(run,'First.'),store.complete(run,'Second.'),return_exceptions=True)
        assert sum(isinstance(value,RuntimeDenied) for value in results)==1
        assert len([value for value in results if not isinstance(value,Exception)])==1
    asyncio.run(check())
    assert counts(fixture,run.id)==(1,0,0)
    assert Counter(kind for kind,_ in events(fixture,run.id))['RUN_COMPLETED']==1


@pytest.mark.parametrize('target',['memory','skill'])
def test_reference_revocation_while_completion_waits_never_publishes(execution,target):
    fixture=execution
    run,_=running(fixture,'reference race '+target)
    memory,skill=evidence(fixture,run)
    async def check():
        async with await psycopg.AsyncConnection.connect(fixture['dsn']) as revoke:
            if target=='memory':
                await revoke.execute('UPDATE employee_memories SET model_use_enabled=false,revision=revision+1 WHERE id=%s',(memory['id'],))
            else:
                await revoke.execute("UPDATE employee_skills SET state='revoked',revision=revision+1 WHERE bot_id=%s AND skill_id=%s",(run.botId,skill['id']))
            pending=asyncio.create_task(PostgresExecutionStore(fixture['dsn']).complete(run,'Too late.',references=[memory],skill_references=[skill]))
            try:
                await wait_for_lock(fixture)
                await revoke.commit()
                with pytest.raises(RuntimeDenied) as denied:
                    await pending
                assert denied.value.code==('memory_changed' if target=='memory' else 'skills_changed')
            finally:
                if not pending.done(): pending.cancel()
                await asyncio.gather(pending,return_exceptions=True)
    asyncio.run(check())
    assert counts(fixture,run.id)==(0,0,0) and read(fixture,run.id).status=='running'


def test_completion_audit_failure_rolls_back_every_published_asset(execution):
    fixture=execution
    run,_=running(fixture,'completion rollback')
    memory,skill=evidence(fixture,run)
    record=artifact(fixture,run)
    instruction=asyncio.run(PostgresRunCommandStore(fixture['dsn']).steer(fixture['token'],run.id,'Check references.'))
    before=events(fixture,run.id)
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("CREATE FUNCTION execution_reject_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type='RUN_COMPLETED' THEN RAISE EXCEPTION 'fixture audit refusal'; END IF; RETURN NEW; END $$")
        connection.execute('CREATE TRIGGER execution_reject_final BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION execution_reject_final()')
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresExecutionStore(fixture['dsn']).complete(run,'Delivery.',artifacts=[record],
                references=[memory],skill_references=[skill],applied_steering_ids=[instruction.id],
                proposal={'kind':'procedural','title':'Verify','content':'Check references.'}))
        assert counts(fixture,run.id)==(0,0,0) and read(fixture,run.id).status=='running'
        assert events(fixture,run.id)==before
        # SQL rollback cannot promise to remove pre-existing bytes owned by the file port.
        assert (Path(fixture['artifactDirectory'])/record['storageKey']).is_file()
    finally:
        with psycopg.connect(fixture['dsn']) as connection:
            connection.execute('DROP TRIGGER execution_reject_final ON run_events')
            connection.execute('DROP FUNCTION execution_reject_final()')


def test_pending_proposal_limit_does_not_undo_delivery(execution):
    fixture=execution
    run,_=running(fixture,'proposal saturation')
    with psycopg.connect(fixture['dsn']) as connection:
        for _ in range(50):
            previous=str(uuid4())
            connection.execute("INSERT INTO runs(id,channel_id,bot_id,execution_profile,title,instruction,status) "
                "VALUES (%s,%s,%s,'none','Previous','Previous','completed')",(previous,run.channelId,run.botId))
            connection.execute("INSERT INTO knowledge_proposals(id,bot_id,source_run_id,kind,title,content) "
                "VALUES (%s,%s,%s,'procedural','Review pending','Verify first.')",(str(uuid4()),run.botId,previous))
    result=asyncio.run(PostgresExecutionStore(fixture['dsn']).complete(run,'Delivered.',
        proposal={'kind':'procedural','title':'Review later','content':'Verify facts.'}))
    assert result.run.status=='completed' and counts(fixture,run.id)==(1,0,0)
    assert ('KNOWLEDGE_PROPOSAL_SKIPPED',{'executor':'native-agent','reason':'pending_limit'}) in events(fixture,run.id)


def test_parent_completion_requires_finished_children(execution):
    fixture=execution
    root,chief=running(fixture,'unfinished children')
    with psycopg.connect(fixture['dsn']) as connection:
        child_id=child(connection,root,chief.id)
    store=PostgresExecutionStore(fixture['dsn'])
    with pytest.raises(RunCommandConflict):
        asyncio.run(store.complete(root,'Premature.'))
    assert counts(fixture,root.id)==(0,0,0)
    asyncio.run(store.fail(read(fixture,child_id)))
    assert asyncio.run(store.complete(root,'Checked child failure.')).run.status=='completed'


@pytest.mark.parametrize('operation',['usage','complete','progress'])
def test_committed_cancellation_wins_against_waiting_execution_writer(execution,operation):
    fixture=execution
    root,_=running(fixture,'cancellation race '+operation)
    async def check():
        async with await psycopg.AsyncConnection.connect(fixture['dsn']) as cancel:
            await cancel.execute("UPDATE runs SET status='cancelled' WHERE id=%s",(root.id,))
            store=PostgresExecutionStore(fixture['dsn'])
            call={'usage':lambda:store.usage(root,usage()),'complete':lambda:store.complete(root,'Too late.'),
                  'progress':lambda:store.progress(root,'model','Too late.') }[operation]
            pending=asyncio.create_task(call())
            try:
                await wait_for_lock(fixture)
                await cancel.commit()
                with pytest.raises(RuntimeDenied) as denied: await pending
                assert denied.value.code=='conflict'
            finally:
                if not pending.done(): pending.cancel()
                await asyncio.gather(pending,return_exceptions=True)
    asyncio.run(check())
    assert counts(fixture,root.id)==(0,0,0) and read(fixture,root.id).modelUsage is None
    assert not any(kind in ('RUN_COMPLETED','MODEL_USAGE_RECORDED','RUN_PROGRESS') for kind,_ in events(fixture,root.id))


def test_committed_correction_during_completion_lock_wait_must_be_applied(execution):
    fixture=execution
    run,_=running(fixture,'late correction')
    async def check():
        async with await psycopg.AsyncConnection.connect(fixture['dsn']) as steer:
            await steer.execute('SELECT id FROM runs WHERE id=%s FOR UPDATE',(run.id,))
            pending=asyncio.create_task(PostgresExecutionStore(fixture['dsn']).complete(run,'Premature.'))
            try:
                await wait_for_lock(fixture)
                await steer.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
                    "VALUES (%s,%s,%s,%s,'RUN_STEERING_SUBMITTED',%s)",
                    (str(uuid4()),run.id,run.channelId,run.botId,Jsonb({'executor':'native-agent','actor':'owner','instruction':'Recheck.'})))
                await steer.commit()
                with pytest.raises(PendingSteering): await pending
            finally:
                if not pending.done(): pending.cancel()
                await asyncio.gather(pending,return_exceptions=True)
    asyncio.run(check())
    assert counts(fixture,run.id)==(0,0,0)


def test_context_freezes_source_start_cutoffs_and_bounded_reference(execution):
    fixture=execution
    run,_=running(fixture,'context cutoff')
    reference_id=str(uuid4())
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("INSERT INTO messages(id,channel_id,author_type,author_id,content,created_at) "
            "VALUES (%s,%s,'human','owner',%s,'2001-01-01')",(reference_id,run.channelId,'事实🧪'*2000))
        connection.execute('UPDATE messages SET reply_to_message_id=%s WHERE id=%s',(reference_id,run.sourceMessageId))
        connection.execute("INSERT INTO messages(id,channel_id,author_type,author_id,content,created_at) "
            "VALUES (%s,%s,'human','owner','Future task','2099-01-01')",(str(uuid4()),run.channelId))
        connection.execute("INSERT INTO messages(id,channel_id,author_type,author_id,content,created_at) "
            "VALUES (%s,%s,'bot',%s,'Unrelated late reply','2099-01-01')",(str(uuid4()),run.channelId,run.botId))
    store=PostgresExecutionStore(fixture['dsn'])
    history=asyncio.run(store.context(run))
    assert len(history)==2 and history[0]['id']==run.sourceMessageId
    assert history[1]['referenced'] is True and history[1]['id']==reference_id
    assert len(history[1]['content'].encode())==1600
    assert asyncio.run(store.context(run))==history
    assert asyncio.run(store.tasks(run))==[{'title':run.title,'status':'running'}]
    Path(fixture['contextResult']).write_text(json.dumps({'run':run.model_dump(mode='json',exclude_none=True),
        'context':history,'tasks':asyncio.run(store.tasks(run))}))
    # Keep this run active for the TypeScript context oracle after Python finishes.
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("UPDATE bots SET name='Context oracle retained' WHERE id=%s",(run.botId,))
