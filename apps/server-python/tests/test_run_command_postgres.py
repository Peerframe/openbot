"""Run commands against the owned PostgreSQL fixture, including actual lock contenders."""
import asyncio
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
from psycopg.types.json import Jsonb
import pytest

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.run_command_store import (PostgresRunCommandStore, RunCommandConflict,
    RunCommandNotFound, InvalidRunCommand, SteeringAttachmentRefused, read_steering)
from openbot_server.task_inputs import parse_message
from openbot_server.task_store import PostgresTaskStore
from test_auth_postgres import authentication
from test_task_postgres import prepare


def task(fixture, label):
    first, chief, channel = prepare(fixture, label)
    result = asyncio.run(PostgresTaskStore(fixture['dsn']).submit(
        fixture['token'], channel.id, parse_message({'content': label, 'botId': first.id})))
    return result.run, chief


def event_rows(fixture, run_id):
    with psycopg.connect(fixture['dsn']) as connection:
        return connection.execute("SELECT type,payload FROM run_events WHERE run_id=%s "
                                  "AND type IN ('RUN_CANCELLED','RUN_STEERING_SUBMITTED') ORDER BY created_at,id", (run_id,)).fetchall()


def state(fixture, run_id):
    with psycopg.connect(fixture['dsn']) as connection:
        return connection.execute('SELECT status FROM runs WHERE id=%s', (run_id,)).fetchone()[0]


def child(connection, run, bot_id, *, parent_id=None, status='running', profile='none', channel_id=None):
    identity = str(uuid4())
    connection.execute("INSERT INTO runs(id,parent_run_id,root_run_id,delegated_by_bot_id,channel_id,bot_id,"
        "execution_profile,instruction,title,status) VALUES (%s,%s,%s,%s,%s,%s,%s,'child','child',%s)",
        (identity,parent_id or run.id,run.id,run.botId,channel_id or run.channelId,bot_id,profile,status))
    return identity


async def wait_for_lock(fixture):
    async with await psycopg.AsyncConnection.connect(fixture['dsn'], autocommit=True) as observer:
        for _ in range(80):
            cursor = await observer.execute("SELECT count(*) FROM pg_stat_activity WHERE "
                "application_name='openbot-control-run-commands' AND wait_event_type='Lock'")
            if (await cursor.fetchone())[0]:
                return
            await asyncio.sleep(0.01)
    pytest.fail('Run command did not reach the expected database lock')


def test_cancel_stops_only_active_native_descendants_and_typescript_reads_identically(fixture):
    run, chief = task(fixture, 'Python cancel tree')
    _, _, other = prepare(fixture, 'Python other cancel scope')
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("UPDATE runs SET status='running',model_usage=%s WHERE id=%s", (
            Jsonb({'provider':'deepseek','model':'fixture','steps':1,'inputTokens':None,'outputTokens':2}),run.id))
        direct = child(connection,run,chief.id)
        grandchild = child(connection,run,run.botId,parent_id=direct,status='queued')
        ended = child(connection,run,chief.id,status='completed')
        foreign = child(connection,run,chief.id,channel_id=other.id)
        worker = str(uuid4())
        connection.execute("INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) "
            "VALUES (%s,%s,%s,'docker-linux','worker','worker','running')",(worker,run.channelId,chief.id))
    store = PostgresRunCommandStore(fixture['dsn'])
    result = asyncio.run(store.cancel(fixture['token'],run.id))
    assert result.run.status == 'cancelled' and result.run.modelUsage.inputTokens is None
    assert {value.id for value in result.descendants} == {direct,grandchild}
    assert all(value.status == 'cancelled' for value in result.descendants)
    assert event_rows(fixture,run.id) == [('RUN_CANCELLED',{'executor':'native-agent','actor':'owner'})]
    for identity in (direct,grandchild):
        assert event_rows(fixture,identity) == [('RUN_CANCELLED',{'executor':'native-agent','actor':'owner','ancestorRunId':run.id})]
    assert state(fixture,ended) == 'completed'
    assert state(fixture,foreign) == state(fixture,worker) == 'running'
    second = asyncio.run(store.cancel(fixture['token'],run.id))
    assert second.run == result.run and second.descendants == ()
    assert len(event_rows(fixture,run.id)) == 1
    with os.fdopen(os.open(fixture['runCommandResult'], os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as output:
        json.dump({'run':result.run.model_dump(mode='json',exclude_none=True),
                   'descendants':[r.model_dump(mode='json',exclude_none=True) for r in result.descendants]},output)


def test_repeated_concurrent_cancel_has_one_audit_and_one_descendant_set(fixture):
    run, chief = task(fixture,'Python duplicate cancellation')
    with psycopg.connect(fixture['dsn']) as connection:
        child_id = child(connection,run,chief.id)
    async def check():
        store = PostgresRunCommandStore(fixture['dsn'])
        results = await asyncio.gather(*(store.cancel(fixture['token'],run.id) for _ in range(3)))
        assert all(value.run.status == 'cancelled' for value in results)
        assert sum(len(value.descendants) for value in results) == 1
    asyncio.run(check())
    assert len(event_rows(fixture,run.id)) == len(event_rows(fixture,child_id)) == 1


@pytest.mark.parametrize('status',['assigned','waiting_approval','blocked','completed','failed'])
def test_terminal_and_worker_lifecycle_states_cannot_be_cancelled_here(fixture,status):
    run,_ = task(fixture,'Python nonnative state '+status)
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute('UPDATE runs SET status=%s WHERE id=%s',(status,run.id))
    with pytest.raises(RunCommandConflict):
        asyncio.run(PostgresRunCommandStore(fixture['dsn']).cancel(fixture['token'],run.id))
    assert state(fixture,run.id) == status and event_rows(fixture,run.id) == []


@pytest.mark.parametrize('method',['cancel','steer'])
def test_missing_and_foreign_profiles_refuse_commands(fixture,method):
    run,_ = task(fixture,'Python command profile '+method)
    store = PostgresRunCommandStore(fixture['dsn'])
    def command(identity):
        return getattr(store,method)(fixture['token'],identity,*(['correct'] if method == 'steer' else []))
    with pytest.raises(RunCommandNotFound):
        asyncio.run(command(str(uuid4())))
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("UPDATE runs SET execution_profile='docker-linux' WHERE id=%s",(run.id,))
    with pytest.raises(RunCommandConflict):
        asyncio.run(command(run.id))
    assert event_rows(fixture,run.id) == []


def test_concurrent_steering_accepts_exactly_eight_and_preserves_scoped_history(fixture):
    run,_ = task(fixture,'Python concurrent corrections')
    async def check():
        store = PostgresRunCommandStore(fixture['dsn'])
        results = await asyncio.gather(*(store.steer(fixture['token'],run.id,f'  correction {i} 🧪  ') for i in range(9)),return_exceptions=True)
        accepted = [value for value in results if not isinstance(value,Exception)]
        assert len(accepted) == 8 and sum(isinstance(v,RunCommandConflict) for v in results) == 1
        async with store._transactions.transaction(fixture['token']) as connection:
            projected = await read_steering(connection,{'id':run.id,'channel_id':run.channelId,'bot_id':run.botId})
        assert sorted(projected,key=lambda v:v.id) == sorted(accepted,key=lambda v:v.id)
        assert all(v.instruction == v.instruction.strip() and v.runId == run.id and v.botId == run.botId for v in accepted)
    asyncio.run(check())
    rows = event_rows(fixture,run.id)
    assert len(rows) == 8 and all(payload['actor'] == 'owner' for _,payload in rows)


def test_steering_reads_only_target_scope_and_refuses_corrupt_history(fixture):
    run,chief = task(fixture,'Python correction scope')
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
            "VALUES (%s,%s,%s,%s,'RUN_STEERING_SUBMITTED','{}')",(str(uuid4()),run.id,run.channelId,chief.id))
    store = PostgresRunCommandStore(fixture['dsn'])
    assert asyncio.run(store.steer(fixture['token'],run.id,'valid')).instruction == 'valid'
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
            "VALUES (%s,%s,%s,%s,'RUN_STEERING_SUBMITTED','{}')",(str(uuid4()),run.id,run.channelId,run.botId))
    with pytest.raises(StoreUnavailable):
        asyncio.run(store.steer(fixture['token'],run.id,'must not save'))
    assert len(event_rows(fixture,run.id)) == 3


def test_store_revalidates_steering_unicode_attachment_markers_and_membership(fixture):
    run,_ = task(fixture,'Python correction refusal')
    store = PostgresRunCommandStore(fixture['dsn'])
    for value in (' ', '\ud800', None, 'x'*4001):
        with pytest.raises(InvalidRunCommand):
            asyncio.run(store.steer(fixture['token'],run.id,value))
    for count in (1,9):
        with pytest.raises(SteeringAttachmentRefused):
            asyncio.run(store.steer(fixture['token'],run.id,' '.join(f'[OpenBot attachment: {uuid4()}]' for _ in range(count))))
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(run.channelId,run.botId))
    with pytest.raises(RunCommandConflict):
        asyncio.run(store.steer(fixture['token'],run.id,'revoked'))
    assert event_rows(fixture,run.id) == []
    # Owner stopping a task remains available even after the Bot lost membership.
    assert asyncio.run(store.cancel(fixture['token'],run.id)).run.status == 'cancelled'


@pytest.mark.parametrize('winner',['cancel','completion','steering'])
def test_run_row_orders_cancel_steering_and_terminal_changes(fixture,winner):
    run,_ = task(fixture,'Python command race '+winner)
    async def check():
        store = PostgresRunCommandStore(fixture['dsn'])
        async with await psycopg.AsyncConnection.connect(fixture['dsn']) as first:
            await first.execute('SELECT id FROM runs WHERE id=%s FOR UPDATE',(run.id,))
            loser = asyncio.create_task(store.cancel(fixture['token'],run.id) if winner in ('completion','steering')
                                        else store.steer(fixture['token'],run.id,'too late'))
            try:
                await wait_for_lock(fixture)
                if winner in ('cancel','completion'):
                    await first.execute('UPDATE runs SET status=%s WHERE id=%s',('cancelled' if winner=='cancel' else 'completed',run.id))
                else:
                    await first.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
                        "VALUES (%s,%s,%s,%s,'RUN_STEERING_SUBMITTED',%s)",
                        (str(uuid4()),run.id,run.channelId,run.botId,Jsonb({'instruction':'committed first','actor':'owner'})))
                await first.commit()
                if winner == 'steering':
                    assert (await loser).run.status == 'cancelled'
                else:
                    with pytest.raises(RunCommandConflict):
                        await loser
            finally:
                if not loser.done():
                    loser.cancel()
                await asyncio.gather(loser,return_exceptions=True)
    asyncio.run(check())
    events = event_rows(fixture,run.id)
    assert Counter(row[0] for row in events) == (Counter(['RUN_STEERING_SUBMITTED','RUN_CANCELLED']) if winner=='steering' else Counter())


@pytest.mark.parametrize('method',['cancel','steer'])
def test_command_audit_failure_rolls_back_target_descendants_and_all_events(fixture,method):
    run,chief = task(fixture,'Python command rollback '+method)
    with psycopg.connect(fixture['dsn']) as connection:
        child_id = child(connection,run,chief.id)
        connection.execute("CREATE FUNCTION control_test_reject_command() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN IF NEW.payload ? 'ancestorRunId' OR NEW.type='RUN_STEERING_SUBMITTED' THEN "
            "RAISE EXCEPTION 'private command failure'; END IF; RETURN NEW; END $$")
        connection.execute('CREATE TRIGGER control_test_reject_command BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION control_test_reject_command()')
    try:
        store = PostgresRunCommandStore(fixture['dsn'])
        with pytest.raises(StoreUnavailable):
            asyncio.run(getattr(store,method)(fixture['token'],run.id,*(['must rollback'] if method=='steer' else [])))
        assert state(fixture,run.id) == 'queued' and state(fixture,child_id) == 'running'
        assert event_rows(fixture,run.id) == event_rows(fixture,child_id) == []
    finally:
        with psycopg.connect(fixture['dsn']) as connection:
            connection.execute('DROP TRIGGER control_test_reject_command ON run_events')
            connection.execute('DROP FUNCTION control_test_reject_command()')


@pytest.mark.parametrize('method',['cancel','steer'])
def test_owner_expiry_while_waiting_for_run_lock_rolls_back_commands(fixture,method):
    run,_ = task(fixture,'Python command expiry '+method)
    async def check():
        issued = await authentication(fixture).login(fixture['ownerPassword'],'192.0.2.84')
        digest = hashlib.sha256(issued.token.encode()).hexdigest()
        async with await psycopg.AsyncConnection.connect(fixture['dsn']) as setup:
            await setup.execute("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE token_digest=%s",(digest,))
        async with await psycopg.AsyncConnection.connect(fixture['dsn']) as blocker:
            await blocker.execute('SELECT id FROM runs WHERE id=%s FOR UPDATE',(run.id,))
            store = PostgresRunCommandStore(fixture['dsn'])
            pending = asyncio.create_task(getattr(store,method)(issued.token,run.id,*(['too late'] if method=='steer' else [])))
            try:
                await wait_for_lock(fixture)
                async with await psycopg.AsyncConnection.connect(fixture['dsn'],autocommit=True) as observe:
                    for _ in range(80):
                        cursor = await observe.execute('SELECT expires_at<=clock_timestamp() FROM auth_sessions WHERE token_digest=%s',(digest,))
                        if (await cursor.fetchone())[0]:
                            break
                        await asyncio.sleep(0.01)
                    else:
                        pytest.fail('Fixture session did not expire before releasing Run lock')
                await blocker.commit()
                with pytest.raises(AuthenticationRequired):
                    await pending
            finally:
                if not pending.done():
                    pending.cancel()
                await asyncio.gather(pending,return_exceptions=True)
    asyncio.run(check())
    assert state(fixture,run.id) == 'queued' and event_rows(fixture,run.id) == []


def test_cancel_projection_limit_rolls_back_without_transferring_oversize_text(fixture):
    run,_ = task(fixture,'Python command projection bound')
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("UPDATE runs SET instruction=repeat('x',4194305) WHERE id=%s",(run.id,))
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresRunCommandStore(fixture['dsn']).cancel(fixture['token'],run.id))
        assert state(fixture,run.id) == 'queued' and event_rows(fixture,run.id) == []
    finally:
        with psycopg.connect(fixture['dsn']) as connection:
            connection.execute('UPDATE runs SET instruction=%s WHERE id=%s', (run.instruction,run.id))


def test_http_commands_return_only_committed_state_and_steering(fixture):
    run,_ = task(fixture,'Python command HTTP')
    app = create_app(PostgresReadStore(fixture['dsn']),owner_name=fixture['ownerName'],secure_cookies=False,
        allowed_origins=('http://control.test',),run_commands=PostgresRunCommandStore(fixture['dsn']))
    with TestClient(app,base_url='http://control.test') as client:
        client.headers['Origin'] = 'http://control.test'
        client.cookies.set('openbot_session',fixture['token'])
        response = client.post(f'/api/v1/runs/{run.id}/steer',json={'instruction':'  修正方法 🧪  '})
        assert response.status_code == 202
        steering = response.json()['steering']
        assert steering['instruction'] == '修正方法 🧪' and steering['runId'] == run.id
        response = client.post(f'/api/v1/runs/{run.id}/cancel',json={})
        assert response.status_code == 200 and response.json()['run']['status'] == 'cancelled'
        assert client.post(f'/api/v1/runs/{run.id}/steer',json={'instruction':'late'}).status_code == 409
        with psycopg.connect(fixture['dsn']) as connection:
            assert connection.execute('SELECT payload FROM run_events WHERE id=%s',(steering['id'],)).fetchone() == ({'actor':'owner','instruction':'修正方法 🧪'},)

        path = Path(fixture['runCommandResult'])
        paired = json.loads(path.read_text())
        paired['steering'] = steering
        path.write_text(json.dumps(paired))


@pytest.mark.parametrize('winner',['cancel','steer'])
def test_real_command_writers_serialize_without_losing_an_accepted_instruction(fixture,winner):
    run,_ = task(fixture,'Python actual command race '+winner)
    async def check():
        first = PostgresRunCommandStore(fixture['dsn'])
        second = PostgresRunCommandStore(fixture['dsn'])
        entered, release = asyncio.Event(), asyncio.Event()
        original = first._target
        async def hold_target(connection, identity):
            row = await original(connection,identity)
            entered.set()
            await release.wait()
            return row
        first._target = hold_target
        operations = {'cancel':lambda s:s.cancel(fixture['token'],run.id),
                      'steer':lambda s:s.steer(fixture['token'],run.id,'must remain recorded')}
        early = asyncio.create_task(operations[winner](first))
        late = None
        try:
            async with asyncio.timeout(2):
                await entered.wait()
            late = asyncio.create_task(operations['steer' if winner=='cancel' else 'cancel'](second))
            await wait_for_lock(fixture)
            release.set()
            await early
            if winner == 'cancel':
                with pytest.raises(RunCommandConflict):
                    await late
            else:
                assert (await late).run.status == 'cancelled'
        finally:
            release.set()
            for operation in (early,late):
                if operation is not None and not operation.done():
                    operation.cancel()
            await asyncio.gather(*(p for p in (early,late) if p is not None),return_exceptions=True)
    asyncio.run(check())
    assert state(fixture,run.id) == 'cancelled'
    # PostgreSQL now() is transaction start, not commit order. The actual lock barrier above
    # proves serialization; neither a timestamp nor a random UUID is a durable event cursor.
    events = event_rows(fixture,run.id)
    assert Counter(row[0] for row in events) == Counter(
        ['RUN_CANCELLED'] if winner=='cancel' else ['RUN_STEERING_SUBMITTED','RUN_CANCELLED'])
    if winner == 'steer':
        assert next(payload for kind,payload in events if kind=='RUN_STEERING_SUBMITTED') == {
            'instruction':'must remain recorded','actor':'owner'}


@pytest.mark.parametrize('method',['cancel','steer'])
def test_node_bound_runs_are_never_treated_as_native_owner_commands(fixture,method):
    run,_ = task(fixture,'Python node-bound command '+method)
    with psycopg.connect(fixture['dsn']) as connection:
        node_id = str(uuid4())
        connection.execute("INSERT INTO nodes(id,name,platform) VALUES (%s,'fixture node','linux')",(node_id,))
        connection.execute('UPDATE runs SET node_id=%s WHERE id=%s',(node_id,run.id))
    store = PostgresRunCommandStore(fixture['dsn'])
    with pytest.raises(RunCommandConflict):
        asyncio.run(getattr(store,method)(fixture['token'],run.id,*(['refuse'] if method=='steer' else [])))
    assert state(fixture,run.id) == 'queued' and event_rows(fixture,run.id) == []


def test_cancel_descendant_limit_never_partially_stops_a_tree(fixture):
    run,chief = task(fixture,'Python command descendant bound')
    with psycopg.connect(fixture['dsn']) as connection:
        connection.execute("INSERT INTO runs(id,parent_run_id,root_run_id,delegated_by_bot_id,channel_id,bot_id,"
            "execution_profile,instruction,title,status) SELECT %s||'-child-'||i,%s,%s,%s,%s,%s,"
            "'none','child','child','queued' FROM generate_series(1,1001) AS i",
            (run.id,run.id,run.id,run.botId,run.channelId,chief.id))
    with pytest.raises(StoreUnavailable):
        asyncio.run(PostgresRunCommandStore(fixture['dsn']).cancel(fixture['token'],run.id))
    with psycopg.connect(fixture['dsn']) as connection:
        assert connection.execute("SELECT count(*) FROM runs WHERE channel_id=%s AND status='queued'",(run.channelId,)).fetchone() == (1002,)
        assert connection.execute("SELECT count(*) FROM run_events WHERE channel_id=%s AND type='RUN_CANCELLED'",(run.channelId,)).fetchone() == (0,)
