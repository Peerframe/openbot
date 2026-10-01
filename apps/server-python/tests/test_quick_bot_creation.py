"""Quick creation uses real identity transactions and the owned PostgreSQL fixture."""
import asyncio
from collections import Counter
from unittest.mock import AsyncMock
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.control_errors import ControlError
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.identity_inputs import parse_bot_create, parse_quick_bot_create
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from test_app import Store, TOKEN

APPEARANCE = dict(head='round', body='classic', mobility='feet', accessory='none', accent='green')
COMMAND = parse_quick_bot_create(dict(appearance=APPEARANCE))


@pytest.fixture
def quick_world(fixture):
    with psycopg.connect(fixture['dsn']) as db:
        before = {row[0] for row in db.execute("SELECT id FROM bots WHERE name LIKE '新建 Bot%'")}
        preferences = db.execute("SELECT default_model FROM owner_preferences WHERE owner_id='owner'").fetchone()[0]
        db.execute("UPDATE owner_preferences SET default_model=NULL WHERE owner_id='owner'")
    try:
        yield fixture
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            ids = [row[0] for row in db.execute("SELECT id FROM bots WHERE name LIKE '新建 Bot%'") if row[0] not in before]
            channels = [row[0] for row in db.execute('SELECT id FROM channels WHERE direct_bot_id=ANY(%s)', (ids,))]
            db.execute('DELETE FROM run_events WHERE bot_id=ANY(%s) OR channel_id=ANY(%s)', (ids, channels))
            db.execute('DELETE FROM employee_evolution_events WHERE bot_id=ANY(%s)', (ids,))
            db.execute('DELETE FROM channel_bots WHERE channel_id=ANY(%s)', (channels,))
            db.execute('DELETE FROM channels WHERE id=ANY(%s)', (channels,))
            db.execute('DELETE FROM bots WHERE id=ANY(%s)', (ids,))
            db.execute("UPDATE owner_preferences SET default_model=%s WHERE owner_id='owner'", (None if preferences is None else Jsonb(preferences),))


def client_for(reads, writer):
    return TestClient(create_app(reads, owner_name='Owner', secure_cookies=False,
        allowed_origins=('http://testserver',), identity=writer))


def test_http_guards_reject_authority_and_default_overrides_before_writer():
    reads, writer = Store(), AsyncMock()
    with client_for(reads, writer) as api:
        api.headers['Origin'] = 'http://testserver'
        assert api.post('/api/v1/bots/quick', content=b'invalid').status_code == 401
        api.cookies.set('openbot_session', TOKEN)
        del api.headers['Origin']
        assert api.post('/api/v1/bots/quick', json=dict(appearance=APPEARANCE)).status_code == 403
        api.headers['Origin'] = 'http://testserver'
        for body in ({}, {'appearance': None}, {'appearance': {**APPEARANCE, 'accent': 'unknown'}},
                     {'appearance': {**APPEARANCE, 'grant': 'admin'}}, {'appearance': APPEARANCE, 'name': 'override'},
                     {'appearance': APPEARANCE, 'model': {'connectionId': 'untrusted'}},
                     {'appearance': APPEARANCE, 'computerProfile': 'docker-linux'}):
            assert api.post('/api/v1/bots/quick', json=body).status_code == 422
        writer.quick_create_bot.assert_not_called()
        schema = api.get('/openapi.json').json()
        assert schema['paths']['/api/v1/bots/quick']['post']['security'] == [{'OwnerSession': []}]


def test_real_http_envelope_defaults_and_exact_atomic_audits(quick_world):
    world = quick_world
    store = PostgresIdentityStore(world['dsn'])
    with client_for(PostgresReadStore(world['dsn']), store) as api:
        api.cookies.set('openbot_session', world['token'])
        api.headers['Origin'] = 'http://testserver'
        response = api.post('/api/v1/bots/quick', json=dict(appearance=APPEARANCE))
        assert response.status_code == 201, response.text
        result = response.json()
        bot, channel = result['bot'], result['channel']
        assert set(result) == {'bot', 'channel'}
        assert bot['name'] == '新建 Bot' and bot['role'] == '通用助手'
        assert bot['computerProfile'] == 'none' and bot['status'] == 'idle' and 'model' not in bot
        assert bot['appearance'] == APPEARANCE
        assert channel['directBotId'] == bot['id'] and channel['botIds'] == [bot['id']]
        assert response.headers['cache-control'] == 'no-store'
        assert api.post(f"/api/v1/bots/{bot['id']}/conversation").status_code == 405  # identity-only composition
    with psycopg.connect(world['dsn']) as db:
        events = db.execute('SELECT type FROM run_events WHERE bot_id=%s OR channel_id=%s', (bot['id'], channel['id'])).fetchall()
        assert Counter(row[0] for row in events) == {'BOT_CREATED': 1, 'CHANNEL_CREATED': 1, 'BOT_JOINED_CHANNEL': 1}
        assert db.execute('SELECT count(*) FROM employee_evolution_events WHERE bot_id=%s', (bot['id'],)).fetchone() == (1,)
    from openbot_server.conversations import PostgresConversationStore
    assert asyncio.run(PostgresConversationStore(world['dsn']).direct(world['token'], bot['id'])).id == channel['id']


def test_parallel_creators_across_independent_stores_allocate_distinct_names(quick_world):
    world = quick_world
    async def run():
        stores = [PostgresIdentityStore(world['dsn']) for _ in range(3)]
        return await asyncio.gather(*(stores[i % 3].quick_create_bot(world['token'], COMMAND) for i in range(9)))
    results = asyncio.run(run())
    assert {result['bot'].name for result in results} == {'新建 Bot', *(f'新建 Bot {n}' for n in range(2, 10))}
    assert len({result['channel'].id for result in results}) == 9
    for result in results:
        assert result['channel'].botIds == [result['bot'].id]


def test_deleted_name_is_reused_and_active_holes_use_smallest_suffix(quick_world):
    world = quick_world
    async def run():
        store = PostgresIdentityStore(world['dsn'])
        first = await store.create_bot(world['token'], parse_bot_create(dict(name='新建 Bot', role='Fixture')))
        await store.create_bot(world['token'], parse_bot_create(dict(name='新建 Bot 3', role='Fixture')))
        assert (await store.quick_create_bot(world['token'], COMMAND))['bot'].name == '新建 Bot 2'
        with psycopg.connect(world['dsn']) as db:
            db.execute('UPDATE bots SET deleted_at=clock_timestamp() WHERE id=%s', (first.id,))
        assert (await store.quick_create_bot(world['token'], COMMAND))['bot'].name == '新建 Bot'
    asyncio.run(run())


def test_ordinary_creation_race_retries_without_partial_quick_audit(quick_world):
    world = quick_world
    class RacingStore(PostgresIdentityStore):
        collided = False
        async def _insert_bot(self, connection, value, configuration, **kwargs):
            if kwargs.get('skip_name_conflict') and not self.collided:
                self.collided = True
                await PostgresIdentityStore(world['dsn']).create_bot(world['token'], value)
            return await super()._insert_bot(connection, value, configuration, **kwargs)
    result = asyncio.run(RacingStore(world['dsn']).quick_create_bot(world['token'], COMMAND))
    assert result['bot'].name == '新建 Bot 2'
    with psycopg.connect(world['dsn']) as db:
        assert db.execute("SELECT count(*) FROM run_events WHERE type='BOT_CREATED' AND payload->>'name'='新建 Bot'").fetchone() == (1,)
        assert db.execute("SELECT count(*) FROM channels WHERE name='新建 Bot' AND direct_bot_id IS NOT NULL").fetchone() == (0,)


@pytest.mark.parametrize('event', ['BOT_CREATED', 'CHANNEL_CREATED', 'BOT_JOINED_CHANNEL'])
def test_failure_at_each_audit_rolls_back_all_identity_rows(quick_world, event):
    world = quick_world
    with psycopg.connect(world['dsn']) as db:
        db.execute("CREATE FUNCTION c12_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            "IF NEW.type=TG_ARGV[0] THEN RAISE EXCEPTION 'private fixture'; END IF; RETURN NEW; END $$")
        from psycopg import sql
        db.execute(sql.SQL('CREATE TRIGGER c12_reject_audit BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c12_reject_audit({})').format(sql.Literal(event)))
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresIdentityStore(world['dsn']).quick_create_bot(world['token'], COMMAND))
        with psycopg.connect(world['dsn']) as db:
            assert db.execute("SELECT count(*) FROM bots WHERE name LIKE '新建 Bot%'").fetchone() == (0,)
            assert db.execute("SELECT count(*) FROM channels WHERE name LIKE '新建 Bot%'").fetchone() == (0,)
            assert db.execute("SELECT count(*) FROM employee_evolution_events WHERE summary LIKE '新建 Bot%'").fetchone() == (0,)
    finally:
        with psycopg.connect(world['dsn']) as db:
            db.execute('DROP TRIGGER c12_reject_audit ON run_events')
            db.execute('DROP FUNCTION c12_reject_audit()')
    assert asyncio.run(PostgresIdentityStore(world['dsn']).quick_create_bot(world['token'], COMMAND))['bot'].name == '新建 Bot'


def test_no_session_cannot_allocate_identity(quick_world):
    with pytest.raises(AuthenticationRequired):
        asyncio.run(PostgresIdentityStore(quick_world['dsn']).quick_create_bot(None, COMMAND))


def test_default_model_is_copied_without_computer_and_disabled_default_refuses_creation(quick_world):
    world = quick_world
    connections = ModelConnectionsService(world['dsn'], ModelCredentialCipher(bytes(range(32))))
    connection_id = None
    async def run():
        nonlocal connection_id
        connection = await connections.create(world['token'], dict(name='C12 fixture '+uuid4().hex, presetId='kimi',
            baseUrl='https://api.moonshot.cn/v1', apiKey='synthetic-fixture-key'))
        connection_id = connection['id']
        selection = dict(connectionId=connection_id, modelId='fixture-default')
        with psycopg.connect(world['dsn']) as db:
            db.execute("UPDATE owner_preferences SET default_model=%s WHERE owner_id='owner'", (Jsonb(selection),))
        store = PostgresIdentityStore(world['dsn'], model_connections=connections)
        result = await store.quick_create_bot(world['token'], COMMAND)
        assert result['bot'].model == selection and result['bot'].computerProfile == 'none'
        await connections.update(world['token'], connection_id, dict(expectedRevision=1, enabled=False))
        with pytest.raises(ControlError, match='model_connection_disabled'):
            await store.quick_create_bot(world['token'], COMMAND)
        with psycopg.connect(world['dsn']) as db:
            assert db.execute("SELECT count(*) FROM bots WHERE name LIKE '新建 Bot%'").fetchone() == (1,)
    try:
        asyncio.run(run())
    finally:
        if connection_id:
            with psycopg.connect(world['dsn']) as db:
                db.execute("UPDATE owner_preferences SET default_model=NULL WHERE owner_id='owner'")
                db.execute('DELETE FROM model_connections WHERE id=%s', (connection_id,))
                db.execute("DELETE FROM run_events WHERE payload->>'id'=%s", (connection_id,))
