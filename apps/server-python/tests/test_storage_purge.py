"""C21 actual PostgreSQL/HTTP, deterministic synthetic files, no model/network providers."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.control_errors import ControlError
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.product_control import OwnerProduct
from test_automation_store import synthetic_db  # noqa: F401
from test_identity_lifecycle import world  # noqa: F401

HEADERS = {'Origin': 'http://testserver'}


@pytest.fixture
def seed(world):
    with psycopg.connect(world['dsn']) as db:
        previous = db.execute('SELECT trash_auto_purge_days,revision,last_auto_purge_at FROM owner_storage_settings').fetchone()
        old_events = [row[0] for row in db.execute("SELECT id FROM run_events WHERE type LIKE 'SETTINGS_%'")]
        db.execute('UPDATE owner_storage_settings SET trash_auto_purge_days=NULL,last_auto_purge_at=NULL')
    yield world
    with psycopg.connect(world['dsn']) as db:
        db.execute('UPDATE owner_storage_settings SET trash_auto_purge_days=%s,revision=%s,last_auto_purge_at=%s', previous)
        db.execute("DELETE FROM run_events WHERE type IN ('SETTINGS_STORAGE_UPDATED','SETTINGS_TRASH_AUTO_PURGE_RUN') AND NOT(id=ANY(%s))", (old_events,))


def setup(seed, tmp_path, monkeypatch):
    (tmp_path / 'attachments').mkdir(mode=0o700)
    service = OwnerProduct(seed['dsn'], object_root=tmp_path)
    async def manual():
        async with service.files.lock(): pass
    monkeypatch.setattr(service.storage, 'start', manual)
    app = create_app(PostgresReadStore(seed['dsn']), owner_name='Owner', secure_cookies=False,
        allowed_origins=('http://testserver',), product=service)
    api = TestClient(app)
    api.cookies.set('openbot_session', seed['token'])
    return service, api, '/api/v1/channels/' + seed['channel'] + '/attachments'


def file(service, seed, name='notes.txt', *, trash=True, age=None, channel=None):
    channel = channel or seed['channel']
    item = service.files.persist(channel, name, b'Deterministic synthetic notes\n')
    if trash: item = service.files.set_deleted(channel, item['id'], True)
    if age is not None:
        item['deletedAt'] = (datetime.now(timezone.utc) - timedelta(days=age)).isoformat()
        service.files._write(item['id'] + '.json', json.dumps(item, separators=(',', ':')).encode())
    return item


def reference(seed, item, *, message=True, task=False):
    marker = f"[OpenBot attachment: {item['id']}]"
    with psycopg.connect(seed['dsn']) as db:
        if message:
            db.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES(%s,%s,'human',%s)",
                (str(uuid4()), item['channelId'], 'PRIVATE_BODY ' + marker + ' ' + marker))
        if task:
            db.execute("INSERT INTO runs(id,channel_id,bot_id,instruction,title,status) VALUES(%s,%s,%s,%s,'PRIVATE_TASK','completed')",
                (str(uuid4()), item['channelId'], seed['bot'], marker))


def events(seed, kind='CHANNEL_ATTACHMENT_PURGED'):
    with psycopg.connect(seed['dsn']) as db:
        return [row[0] for row in db.execute('SELECT payload FROM run_events WHERE type=%s AND channel_id=%s', (kind, seed['channel']))]


def assert_original(service, item):
    assert service.files.read(item['channelId'], item['id'])[1] == b'Deterministic synthetic notes\n'
    assert service.storage.journal.journals() == []


def test_owner_trash_authority_reference_conflict_and_gone_http(seed, tmp_path, monkeypatch):
    service, api, base = setup(seed, tmp_path, monkeypatch)
    active = file(service, seed, trash=False)
    blocked = file(service, seed, 'blocked.txt')
    reference(seed, blocked, task=True)
    doomed = file(service, seed, 'a' * 156 + '.txt')
    service.files._write(doomed['id'] + '.text.json', b'{"text":"Synthetic derived text"}')
    with api:
        api.cookies.clear()
        assert api.get('/api/v1/storage').status_code == 401
        assert api.get('/api/v1/settings/storage').status_code == 401
        assert api.delete(base + '/' + doomed['id'] + '/purge', headers=HEADERS).status_code == 401
        api.cookies.set('openbot_session', seed['token'])
        assert api.delete(base + '/' + doomed['id'] + '/purge').status_code == 403
        assert api.delete(base + '/' + active['id'] + '/purge', headers=HEADERS).json() == {'error': 'attachment_not_in_trash'}
        refused = api.delete(base + '/' + blocked['id'] + '/purge', headers=HEADERS)
        assert refused.status_code == 409 and refused.json() == {'error': 'attachment_referenced', 'referenceCount': {'messages': 1, 'tasks': 1}}
        assert_original(service, blocked)
        removed = api.delete(base + '/' + doomed['id'] + '/purge', headers=HEADERS)
        assert removed.status_code == 200, removed.text
        assert removed.json()['purged'] and removed.json()['freedBytes'] > 0
        assert not any((service.files.root / (doomed['id'] + suffix)).exists() for suffix in ('.bin', '.json', '.text.json'))
        for suffix in ('', '/content'):
            gone = api.get(base + '/' + doomed['id'] + suffix)
            assert gone.status_code == 410 and gone.json() == {'error': 'attachment_purged', 'purged': True}
        assert api.get(base + '/' + str(uuid4())).status_code == 404
        assert api.get('/api/v1/channels/' + seed['direct'] + '/attachments/' + doomed['id']).status_code == 404
        assert api.delete(base + '/' + doomed['id'] + '/purge', headers=HEADERS).json() == removed.json()
        assert len(events(seed)) == 1
        payload = events(seed)[0]
        assert payload['actor'] == 'owner' and payload['fileName'] == doomed['name'] and payload['sizeBytes'] == doomed['sizeBytes']
        audit = api.get('/api/v1/audit?category=channels&limit=100').json()['events']
        assert next(row for row in audit if row['type'] == 'CHANNEL_ATTACHMENT_PURGED')['details']['fileName'] == doomed['name']
        assert 'PRIVATE_BODY' not in json.dumps(audit)


@pytest.mark.parametrize('kind', ['message', 'task'])
def test_reference_committed_after_first_read_refuses_and_restores(seed, tmp_path, monkeypatch, kind):
    service, api, base = setup(seed, tmp_path, monkeypatch)
    item = file(service, seed)
    original = service.storage._counts
    calls = 0
    async def count(db, items):
        nonlocal calls
        result = await original(db, items)
        calls += 1
        if calls == 1: reference(seed, item, message=kind == 'message', task=kind == 'task')
        return result
    monkeypatch.setattr(service.storage, '_counts', count)
    with api:
        response = api.delete(base + '/' + item['id'] + '/purge', headers=HEADERS)
        assert response.status_code == 409, response.text
        assert response.json()['referenceCount'][kind + 's'] == 1
        assert_original(service, item)
        assert events(seed) == []
        with psycopg.connect(seed['dsn']) as db:
            assert db.execute('SELECT count(*) FROM attachment_purges WHERE id=%s', (item['id'],)).fetchone() == (0,)


def test_final_share_lock_blocks_writer_and_revoked_owner_rolls_back(seed, tmp_path, monkeypatch):
    service, api, base = setup(seed, tmp_path, monkeypatch)
    item = file(service, seed)
    original = service.storage._counts
    calls = 0
    async def inspect(db, items):
        nonlocal calls
        result = await original(db, items)
        calls += 1
        if calls == 2:
            with psycopg.connect(seed['dsn'], options='-c lock_timeout=100') as writer:
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    writer.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES(%s,%s,'human',%s)",
                        (str(uuid4()), seed['channel'], f"[OpenBot attachment: {item['id']}]") )
            await db.execute('UPDATE auth_sessions SET revoked_at=now() WHERE token_digest=%s',
                (hashlib.sha256(seed['token'].encode()).hexdigest(),))
        return result
    monkeypatch.setattr(service.storage, '_counts', inspect)
    with api:
        response = api.delete(base + '/' + item['id'] + '/purge', headers=HEADERS)
        assert response.status_code == 401, response.text
        assert_original(service, item)
        assert events(seed) == []


def test_empty_trash_idempotent_receipt_and_new_files_require_new_key(seed, tmp_path, monkeypatch):
    service, api, base = setup(seed, tmp_path, monkeypatch)
    doomed = file(service, seed)
    blocked = file(service, seed, 'blocked.txt')
    reference(seed, blocked, task=True)
    active = file(service, seed, 'active.txt', trash=False)
    foreign = file(service, seed, 'foreign.txt', channel=seed['direct'])
    key = str(uuid4())
    with api:
        assert api.post(base + '/cleanup', headers=HEADERS, json={}).status_code == 422
        first = api.post(base + '/cleanup', headers=HEADERS, json={'requestKey': key})
        assert first.status_code == 200, first.text
        result = first.json()
        assert result['removed'] == 1 and result['freedBytes'] > 0
        assert result['retained'] == [{'id': blocked['id'], 'name': blocked['name'], 'referenceCount': {'messages': 1, 'tasks': 1}}]
        assert result['retainedCount'] == 1 and not result['retainedHasMore']
        later = file(service, seed, 'later.txt')
        for _ in range(2): assert api.post(base + '/cleanup', headers=HEADERS, json={'requestKey': key}).json() == result
        assert len(events(seed)) == 1
        for item in (later, active, foreign, blocked): assert_original(service, item)
        next_result = api.post(base + '/cleanup', headers=HEADERS, json={'requestKey': str(uuid4())}).json()
        assert next_result['removed'] == 1
        assert len(events(seed)) == 2
        assert api.get(base + '/' + doomed['id']).status_code == 410


def test_clear_retained_list_and_usage_top_channels_have_real_bounds(seed, tmp_path, monkeypatch):
    service, api, base = setup(seed, tmp_path, monkeypatch)
    items = [file(service, seed, f'{index}.txt') for index in range(101)]
    for item in items: reference(seed, item)
    with psycopg.connect(seed['dsn']) as db:
        for index in range(21):
            identity = str(uuid4()); seed['channels'].append(identity)
            db.execute('INSERT INTO channels(id,name) VALUES(%s,%s)', (identity, f'Storage {index} {identity}'))
            file(service, seed, channel=identity, trash=False)
    with api:
        result = api.post(base + '/cleanup', headers=HEADERS, json={'requestKey': str(uuid4())})
        assert result.status_code == 200, result.text
        assert result.json()['removed'] == 0 and result.json()['retainedCount'] == 101
        assert len(result.json()['retained']) == 100 and result.json()['retainedHasMore']
        assert 'PRIVATE_BODY' not in result.text
        usage = api.get('/api/v1/storage')
        assert usage.status_code == 200, usage.text
        assert len(usage.json()['topChannels']) == 20 and usage.json()['topChannelsLimit'] == 20
        assert usage.json()['trash']['referencedFileCount'] == 101
        assert events(seed) == []
        for item in items: assert_original(service, item)


def test_whole_channel_cleanup_still_removes_referenced_originals(seed, tmp_path, monkeypatch):
    service, api, base = setup(seed, tmp_path, monkeypatch)
    item = file(service, seed)
    reference(seed, item, task=True)
    with api:
        response = api.delete('/api/v1/channels/' + seed['channel'], headers=HEADERS)
        assert response.status_code == 200 and response.json()['attachmentsRemoved'], response.text
        assert not list(service.files.root.glob(item['id'] + '.*'))
        assert api.get(base + '/' + item['id']).status_code == 404


def test_journal_restore_finalize_and_lost_commit_are_authoritative(seed, tmp_path, monkeypatch):
    service, api, base = setup(seed, tmp_path, monkeypatch)
    restored = file(service, seed)
    service.storage.journal.stage([restored])
    with api:
        # Startup and every subsequent lock recover a rolled-back/crashed operation.
        assert_original(service, restored)
        doomed = file(service, seed, 'committed.txt')
        original = service.storage.transactions.transaction
        @asynccontextmanager
        async def lost_commit(token):
            async with original(token) as db: yield db
            raise StoreUnavailable('synthetic_lost_commit_reply')
        monkeypatch.setattr(service.storage.transactions, 'transaction', lost_commit)
        assert api.delete(base + '/' + doomed['id'] + '/purge', headers=HEADERS).status_code == 503
        assert not (service.files.root / (doomed['id'] + '.bin')).exists()
        assert len(events(seed)) == 1
        monkeypatch.setattr(service.storage.transactions, 'transaction', original)
        assert api.get(base + '/' + doomed['id']).status_code == 410
        assert api.delete(base + '/' + doomed['id'] + '/purge', headers=HEADERS).json()['purged']
        assert len(events(seed)) == 1


def test_unavailable_receipt_lookup_never_blindly_restores(seed, tmp_path, monkeypatch):
    service, _, _ = setup(seed, tmp_path, monkeypatch)
    item = file(service, seed)
    service.storage.journal.stage([item])
    original = service.storage.internal.transaction
    @asynccontextmanager
    async def unavailable():
        raise StoreUnavailable('synthetic_unavailable')
        yield
    monkeypatch.setattr(service.storage.internal, 'transaction', unavailable)
    async def attempt():
        with pytest.raises(StoreUnavailable):
            async with service.files.lock(): pass
    asyncio.run(attempt())
    assert not (service.files.root / (item['id'] + '.bin')).exists()
    assert len(service.storage.journal.journals()) == 1
    monkeypatch.setattr(service.storage.internal, 'transaction', original)
    async def recover():
        async with service.files.lock(): pass
    asyncio.run(recover())
    assert_original(service, item)


def enable(seed):
    with psycopg.connect(seed['dsn']) as db:
        db.execute('UPDATE owner_storage_settings SET trash_auto_purge_days=30,last_auto_purge_at=NULL')


def test_default_off_settings_age_refs_daily_claim_and_audit(seed, tmp_path, monkeypatch):
    service, api, _ = setup(seed, tmp_path, monkeypatch)
    old = file(service, seed, age=31)
    young = file(service, seed, 'young.txt', age=29)
    blocked = file(service, seed, 'blocked.txt', age=31)
    active = file(service, seed, 'active.txt', trash=False)
    owner = service.files.owner_persist('owner.txt', b'Owner native task namespace')
    service.files.owner_set_deleted(owner['id'], True)
    reference(seed, blocked, task=True)
    assert asyncio.run(service.storage.run_due()) is None
    with api:
        settings = api.get('/api/v1/settings/storage').json()
        assert settings['trashAutoPurgeDays'] is None
        for days in (7, True, '30'):
            assert api.put('/api/v1/settings/storage', headers=HEADERS,
                json={'expectedRevision': settings['revision'], 'trashAutoPurgeDays': days}).status_code == 422
        saved = api.put('/api/v1/settings/storage', headers=HEADERS,
            json={'expectedRevision': settings['revision'], 'trashAutoPurgeDays': 30}).json()
        assert saved['revision'] == settings['revision'] + 1 and saved['trashAutoPurgeDays'] == 30
        assert api.put('/api/v1/settings/storage', headers=HEADERS,
            json={'expectedRevision': settings['revision'], 'trashAutoPurgeDays': None}).status_code == 409
        result = api.portal.call(service.storage.run_due)
        assert result['outcome'] == 'completed' and result['removed'] == 1 and result['retainedCount'] == 1
        assert api.portal.call(service.storage.run_due) is None
        for item in (young, blocked, active): assert_original(service, item)
        assert service.files.owner_read(owner['id'])[1] == b'Owner native task namespace'
        assert not (service.files.root / (old['id'] + '.bin')).exists()
        assert events(seed)[0]['actor'] == 'server'
        assert events(seed)[0]['reason'] == 'trash_auto_purge'
        with psycopg.connect(seed['dsn']) as db:
            audits = [row[0] for row in db.execute("SELECT payload FROM run_events WHERE type='SETTINGS_TRASH_AUTO_PURGE_RUN'")]
        assert len(audits) == 2 and {row['outcome'] for row in audits} == {'started', 'completed'}
        assert len({row['operationId'] for row in audits}) == 1
        assert next(row for row in audits if row['outcome'] == 'completed')['removed'] == 1


def test_auto_reference_failure_preserves_entire_batch(seed, tmp_path, monkeypatch):
    service, _, _ = setup(seed, tmp_path, monkeypatch)
    items = [file(service, seed, name, age=31) for name in ('first.txt', 'second.txt')]
    enable(seed)
    original = service.storage._counts
    calls = 0
    async def unknown(db, values):
        nonlocal calls
        calls += 1
        if calls == 2: raise ControlError(503, 'synthetic_reference_unavailable')
        return await original(db, values)
    monkeypatch.setattr(service.storage, '_counts', unknown)
    result = asyncio.run(service.storage.run_due())
    assert result == {'outcome': 'failed', 'removed': 0, 'freedBytes': 0}
    for item in items: assert_original(service, item)
    assert events(seed) == []
    with psycopg.connect(seed['dsn']) as db:
        assert db.execute("SELECT count(*) FROM run_events WHERE type='SETTINGS_TRASH_AUTO_PURGE_RUN' AND payload->>'outcome'='failed'").fetchone() == (1,)


def test_real_lifecycle_scheduler_and_unknown_commit_keep_completion(seed, tmp_path, monkeypatch):
    service, _, _ = setup(seed, tmp_path, monkeypatch)
    item = file(service, seed, age=31)
    enable(seed)
    original = service.storage.internal.transaction
    calls = 0
    @asynccontextmanager
    async def lost_reply():
        nonlocal calls
        calls += 1
        current = calls
        async with original() as db: yield db
        if current == 2: raise StoreUnavailable('synthetic_maintenance_commit_reply')
    monkeypatch.setattr(service.storage.internal, 'transaction', lost_reply)
    result = asyncio.run(service.storage.run_due())
    assert result['outcome'] == 'completed' and result['removed'] == 1
    assert not (service.files.root / (item['id'] + '.bin')).exists()
    monkeypatch.setattr(service.storage.internal, 'transaction', original)
    # Exercise the actual lifecycle loop, with an event instead of timing assertions.
    later = file(service, seed, 'scheduled.txt', age=31)
    enable(seed)
    original_due = service.storage.run_due
    async def lifecycle():
        done = asyncio.Event()
        async def due():
            result = await original_due()
            done.set()
            return result
        monkeypatch.setattr(service.storage, 'run_due', due)
        from openbot_server.storage_service import StorageService
        await StorageService.start(service.storage)
        try:
            async with asyncio.timeout(5): await done.wait()
        finally: await service.storage.close()
        assert service.storage._task is None
    asyncio.run(lifecycle())
    assert not (service.files.root / (later['id'] + '.bin')).exists()


def test_usage_measures_categories_and_unknown_remote_storage(seed, tmp_path, monkeypatch):
    service, api, _ = setup(seed, tmp_path, monkeypatch)
    active = file(service, seed, trash=False)
    trash = file(service, seed, 'trash.txt')
    reference(seed, trash)
    owner = service.files.owner_persist('owner.txt', b'Owner bytes')
    (tmp_path / 'runs').mkdir(mode=0o700)
    (tmp_path / 'runs' / 'synthetic-result.txt').write_bytes(b'Retained run output')
    cas = tmp_path / 'work-cas'; cas.mkdir(mode=0o700)
    (cas / ('a' * 64)).write_bytes(b'Work output')
    (cas / 'housekeeping').write_bytes(b'Other')
    service.storage.artifact_root = cas
    def size(item):
        return sum((service.files.root / (item['id'] + suffix)).stat().st_size for suffix in ('.json', '.bin'))
    with api:
        usage = api.get('/api/v1/storage')
        assert usage.status_code == 200, usage.text
        result = usage.json(); categories = result['categories']
        assert categories['channelFiles'] == {'sizeBytes': size(active), 'fileCount': 1}
        assert categories['trash'] == {'sizeBytes': size(trash), 'fileCount': 1}
        assert categories['ownerTaskFiles'] == {'sizeBytes': size(owner), 'fileCount': 1}
        assert categories['taskOutputs'] == {'sizeBytes': len(b'Retained run outputWork output'), 'fileCount': 2}
        assert categories['workingComputerBrowserData'] is None and categories['retainedRunOutputs'] is None
        assert categories['database']['sizeBytes'] > 0
        assert result['totalBytes'] == sum(value['sizeBytes'] for value in categories.values() if value is not None)
        assert result['trash']['referencedFileCount'] == 1
        service.storage.artifact_root = None
        unknown = api.get('/api/v1/storage').json()['categories']
        assert unknown['taskOutputs'] is None and unknown['retainedRunOutputs']['sizeBytes'] == len(b'Retained run output')
        (tmp_path / 'unsafe-link').symlink_to('/etc')
        refused = api.get('/api/v1/storage')
        assert refused.status_code == 503 and '/etc' not in refused.text


@pytest.mark.parametrize('table,column', [('messages', 'content'), ('runs', 'instruction')])
def test_late_sql_writer_waiting_on_purge_cannot_reference_gone_file(seed, tmp_path, monkeypatch, table, column):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    service, api, base = setup(seed, tmp_path, monkeypatch)
    item = file(service, seed)
    original = service.storage._counts
    calls = 0
    ready = Event()
    executor = ThreadPoolExecutor(max_workers=1)
    future = None
    def writer():
        with psycopg.connect(seed['dsn'], options='-c statement_timeout=5000', application_name='c21-late-reference') as db:
            ready.set()
            try:
                if table == 'messages':
                    db.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES(%s,%s,'human',%s)",
                        (str(uuid4()), seed['channel'], f"[OpenBot attachment: {item['id']}]") )
                else:
                    db.execute("INSERT INTO runs(id,channel_id,bot_id,instruction,title,status) VALUES(%s,%s,%s,%s,'late','completed')",
                        (str(uuid4()), seed['channel'], seed['bot'], f"[OpenBot attachment: {item['id']}]") )
            except psycopg.errors.CheckViolation as error:
                assert error.diag.constraint_name == 'attachment_purged_reference'
                return 'refused'
        return 'committed'
    async def counts(db, items):
        nonlocal calls, future
        result = await original(db, items)
        calls += 1
        if calls == 2:
            future = executor.submit(writer)
            assert await asyncio.to_thread(ready.wait, 2)
            # Prove the real writer is waiting on a lock before permitting the purge commit.
            async with asyncio.timeout(2):
                while True:
                    with psycopg.connect(seed['dsn']) as observer:
                        waiting = observer.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='c21-late-reference' AND wait_event_type='Lock'").fetchone()[0]
                    if waiting: break
                    await asyncio.sleep(0.01)
        return result
    monkeypatch.setattr(service.storage, '_counts', counts)
    try:
        with api:
            response = api.delete(base + '/' + item['id'] + '/purge', headers=HEADERS)
            assert response.status_code == 200, response.text
            assert future.result(timeout=5) == 'refused'
            assert api.get(base + '/' + item['id']).status_code == 410
        with psycopg.connect(seed['dsn']) as db:
            identity = str(uuid4())
            if table == 'messages':
                db.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES(%s,%s,'human','safe')", (identity, seed['channel']))
            else:
                db.execute("INSERT INTO runs(id,channel_id,bot_id,instruction,title,status) VALUES(%s,%s,%s,'safe','late','completed')", (identity, seed['channel'], seed['bot']))
            with pytest.raises(psycopg.errors.CheckViolation):
                db.execute(f'UPDATE {table} SET {column}=%s WHERE id=%s',
                    (f"[OPENBOT ATTACHMENT: {item['id'].upper()}]", identity))
    finally: executor.shutdown(wait=True)
