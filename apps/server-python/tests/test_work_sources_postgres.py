"""Real source-to-Work transactions, retained reads and revocation/publication races."""
import asyncio
import hashlib
from uuid import uuid4

import psycopg
import pytest

from openbot_server.conversation_interactions import PostgresConversationInteractions
from openbot_server.run_command_store import PostgresRunCommandStore, RunCommandConflict
from openbot_server.run_query import read_run_records
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_sources import WorkSourceAdmission
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import WorkConflict


@pytest.fixture
def setup(fixture, tmp_path):
    bot, channel = str(uuid4()), str(uuid4())
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES(%s,%s,'assistant','none')", (bot,'Source '+bot))
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,%s,'Synthetic only')", (channel,'Source '+channel))
        db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)', (channel,bot))
    tmp_path.chmod(0o700)
    store = PostgresWorkStore(fixture['dsn'],files=LocalWorkFiles(tmp_path))
    sources = WorkSourceAdmission(store, token_limit=10000)
    return dict(fixture,botId=bot,channelId=channel),store,sources


async def submit(setup, objective='Read the supplied facts'):
    f,store,sources=setup
    result=await PostgresTaskStore(f['dsn'],work_sources=sources).submit(f['token'],f['channelId'],
        CreateMessageInput(content=objective,botId=f['botId']))
    async with store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s', (result.run.id,))).fetchone()
    task=await store.snapshot(f['token'],row['task_id'])
    return result.run,task


async def projected(store, identity):
    async with store._transaction(trusted=True) as db:
        return (await read_run_records(db,[identity]))[identity]


async def completion(setup, task):
    f,store,_=setup
    run=task['runs'][0]['id']
    fence=await store.claim(task['id'],run,str(uuid4()))
    context=await CorrectionStore(store).freeze(task['id'],run,'final')
    current=await store.snapshot(f['token'],task['id'])
    return dict(fence=fence,expected_revision=current['revision'],summary='Fixture independently checked.',
        artifacts=[],verification={'source':'source-fixture','reference':'checked-facts',
        'sha256':hashlib.sha256(b'facts').hexdigest()},correction_context=context['id'])


def test_atomic_source_admission_and_full_chinese_objective(setup):
    async def check():
        f,store,_=setup
        run,task=await submit(setup,'中'*8000)
        assert task['objective']==run.instruction=='中'*8000
        async with store._transaction(trusted=True) as db:
            row=await (await db.execute('SELECT state FROM work_admissions WHERE run_id=%s', (task['runs'][0]['id'],))).fetchone()
            assert row['state']=='pending'
            assert (await (await db.execute('SELECT count(*) AS n FROM messages WHERE channel_id=%s', (f['channelId'],))).fetchone())['n']==1
        assert (await projected(store,run.id)).status=='queued'
    asyncio.run(check())


def test_refused_execution_rolls_back_source_message_and_work(setup):
    f,store,_=setup
    with psycopg.connect(f['dsn']) as db:
        db.execute("UPDATE bots SET computer_profile='docker-linux' WHERE id=%s",(f['botId'],))
    async def check():
        with pytest.raises(WorkConflict,match='isolated_execution_unqualified'):
            await submit(setup)
        async with store._transaction(trusted=True) as db:
            for table in ('messages','runs'):
                assert (await (await db.execute(f'SELECT count(*) AS n FROM {table} WHERE channel_id=%s', (f['channelId'],))).fetchone())['n']==0
            assert (await (await db.execute('SELECT count(*) AS n FROM work_tasks WHERE bot_id=%s', (f['botId'],))).fetchone())['n']==0
    asyncio.run(check())


def test_queued_steering_preserves_chinese_and_cancels_the_same_work(setup):
    async def check():
        f,store,sources=setup;run,task=await submit(setup)
        commands=PostgresRunCommandStore(f['dsn'],work_sources=sources)
        event=await commands.steer(f['token'],run.id,'改'*4000)
        context=await CorrectionStore(store).freeze(task['id'],task['runs'][0]['id'],'first')
        assert context['corrections'][0]['instruction']==event.instruction=='改'*4000
        async with store._transaction(trusted=True) as db:
            assert (await (await db.execute('SELECT request_key FROM work_corrections WHERE task_id=%s', (task['id'],))).fetchone())['request_key']=='source:'+event.id
        result=await commands.cancel(f['token'],run.id)
        assert result.run.status=='cancelled'
        final=await store.snapshot(f['token'],task['id'])
        assert final['cancelRequested'] and not final['authorityActive'] and final['status']=='cancelled'
        assert (await commands.cancel(f['token'],run.id)).run.status=='cancelled'
    asyncio.run(check())


def test_completed_source_has_one_bot_message_and_no_second_lifecycle_writer(setup):
    async def check():
        f,store,sources=setup;run,task=await submit(setup)
        args=await completion(setup,task)
        for _ in range(2):
            await store.complete(task['id'],task['runs'][0]['id'],**args)
        result=await projected(store,run.id)
        assert result.status=='completed' and result.resultSummary==args['summary']
        async with store._transaction(trusted=True) as db:
            assert (await (await db.execute('SELECT status FROM runs WHERE id=%s', (run.id,))).fetchone())['status']=='queued'
            rows=await (await db.execute("SELECT * FROM messages WHERE channel_id=%s AND author_type='bot'", (f['channelId'],))).fetchall()
            assert len(rows)==1 and rows[0]['content']==args['summary'] and rows[0]['run_id']==run.id
        with pytest.raises(RunCommandConflict):
            await PostgresRunCommandStore(f['dsn'],work_sources=sources).cancel(f['token'],run.id)
        removed=await PostgresConversationInteractions(f['dsn'],work_sources=sources).remove_member(f['token'],f['channelId'],f['botId'])
        assert removed['cancelledRuns']==[]
    asyncio.run(check())


def test_unknown_admitted_effect_remains_blocked_after_cancel(setup):
    async def check():
        f,store,sources=setup;run,task=await submit(setup)
        rid=task['runs'][0]['id'];fence=await store.claim(task['id'],rid,'effect')
        context=await CorrectionStore(store).freeze(task['id'],rid,'first')
        aid=await store.propose(task['id'],rid,fence=fence,action_key='write',intent={'write':'fixture'},
            reserved_tokens=0,requires_approval=False,correction_context=context['id'])
        await store.admit(aid,fence=fence)
        result=await PostgresRunCommandStore(f['dsn'],work_sources=sources).cancel(f['token'],run.id)
        assert result.run.status=='blocked'
        final=await store.snapshot(f['token'],task['id'])
        assert final['cancelRequested'] and final['attention']=='reconciliation'
        assert not final['authorityActive']
    asyncio.run(check())


def test_membership_removal_and_publication_serialize_without_deadlock(setup):
    async def check():
        f,store,sources=setup;run,task=await submit(setup);args=await completion(setup,task)
        interactions=PostgresConversationInteractions(f['dsn'],work_sources=sources)
        async with asyncio.timeout(8):
            published,removed=await asyncio.gather(
                store.complete(task['id'],task['runs'][0]['id'],**args),
                interactions.remove_member(f['token'],f['channelId'],f['botId']),return_exceptions=True)
        assert not isinstance(removed,Exception)
        final=await store.snapshot(f['token'],task['id'])
        async with store._transaction(trusted=True) as db:
            count=(await (await db.execute("SELECT count(*) AS n FROM messages WHERE channel_id=%s AND author_type='bot'", (f['channelId'],))).fetchone())['n']
        if final['status']=='completed':
            assert not isinstance(published,Exception) and count==1 and not removed['cancelledRuns']
        else:
            assert final['status']=='cancelled' and isinstance(published,WorkConflict) and count==0
        assert not final['authorityActive']
    asyncio.run(check())


def test_unmapped_historical_run_retains_original_read_and_cancel(setup):
    async def check():
        f,store,_=setup
        run=(await PostgresTaskStore(f['dsn']).submit(f['token'],f['channelId'],
             CreateMessageInput(content='Historical fixture',botId=f['botId']))).run
        assert (await projected(store,run.id)).status=='queued'
        assert (await PostgresRunCommandStore(f['dsn']).cancel(f['token'],run.id)).run.status=='cancelled'
    asyncio.run(check())
