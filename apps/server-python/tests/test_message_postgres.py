"""Latest-message windows use only the owned PostgreSQL fixture and existing TS oracle."""
import asyncio
import hashlib
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore, ReadResult, StoreUnavailable
from openbot_server.message_query import MESSAGE_QUERY
from test_auth_postgres import authentication


def test_real_message_window_empty_channel_and_existence_authority(fixture):
    paths = [path for path in fixture["expected"] if path.endswith("/messages")]
    assert len(paths) == 2
    app = create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"], secure_cookies=False)
    with TestClient(app) as client:
        missing = f"/api/v1/channels/{uuid4()}/messages"
        assert client.get(missing).status_code == 401
        client.cookies.set("openbot_session", fixture["token"])
        assert client.get(missing).status_code == 404
        for path in paths:
            assert client.get(path).json()["messages"] == fixture["expected"][path]["messages"]
        populated = next(fixture["expected"][path]["messages"] for path in paths if fixture["expected"][path]["messages"])
        assert len(populated) == 100
        assert populated[0]["id"] == "fixture-message-5" and populated[-1]["id"] == "fixture-message-104"


def test_equal_timestamps_have_stable_order_and_other_channels_are_excluded(fixture):
    channel_id = str(uuid4())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("INSERT INTO channels(id,name,description) VALUES (%s,'Python tied messages','')", (channel_id,))
        for suffix in ("c", "a", "b"):
            connection.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) "
                               "VALUES (%s,%s,'system',%s,'2026-01-02T00:00:00Z')", (channel_id+suffix,channel_id,suffix))
    store = PostgresReadStore(fixture["dsn"])
    first = asyncio.run(store.read(fixture["token"], "messages", channel_id=channel_id))
    second = asyncio.run(store.read(fixture["token"], "messages", channel_id=channel_id))
    assert first == second
    assert [row["content"] for row in first.rows] == ["a", "b", "c"]
    assert all(row["channel_id"] == channel_id for row in first.rows)


@pytest.mark.parametrize("column", ["content", "author_id"])
def test_oversize_selected_text_is_refused_before_driver_transfer_without_mutation(fixture, column):
    channel_id, message_id = str(uuid4()), str(uuid4())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("INSERT INTO channels(id,name,description) VALUES (%s,%s,'')", (channel_id, "Python oversize " + column))
        connection.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES (%s,%s,'system','test')", (message_id,channel_id))
        # column is a fixed test parameter, never external input.
        connection.execute("UPDATE messages SET " + column + "=repeat('x',4194305) WHERE id=%s", (message_id,))
        rows = connection.execute(MESSAGE_QUERY, (channel_id,channel_id)).fetchall()
        assert len(rows) == 1 and rows[0][2] is True
        assert all(value is None for value in rows[0][3:])
    with pytest.raises(StoreUnavailable, match="projection_limit"):
        asyncio.run(PostgresReadStore(fixture["dsn"]).read(fixture["token"], "messages", channel_id=channel_id))
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT octet_length(" + column + ") FROM messages WHERE id=%s", (message_id,)).fetchone() == (4194305,)


def test_revocation_after_message_query_discards_the_loaded_window(fixture):
    issued = asyncio.run(authentication(fixture).login(fixture["ownerPassword"], "192.0.2.80"))
    digest = hashlib.sha256(issued.token.encode()).hexdigest()
    channel = next(path.split("/")[-2] for path in fixture["expected"] if path.endswith("/messages") and fixture["expected"][path]["messages"])

    class RevokedDuringRead(PostgresReadStore):
        calls = 0

        async def _session(self, connection, value):
            self.calls += 1
            if self.calls == 2:
                with psycopg.connect(fixture["dsn"]) as revoke:
                    revoke.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=%s", (digest,))
            return await super()._session(connection, value)

    result = asyncio.run(RevokedDuringRead(fixture["dsn"]).read(issued.token, "messages", channel_id=channel))
    assert result == ReadResult(None)


@pytest.mark.parametrize('count,limit',[ (0,3),(1,3),(3,3),(4,3),(13,3),(100,100),(101,100)])
def test_c18_real_pages_empty_exact_cross_and_deleted_anchor(fixture,count,limit):
    from datetime import datetime,timedelta,timezone
    from openbot_server.message_pagination import encode_cursor
    channel=str(uuid4())
    moment=datetime(2026,1,1,0,0,0,123001,tzinfo=timezone.utc)
    ids=[channel+f'-{i:03d}' for i in range(count)]
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO channels(id,name,description) VALUES(%s,'C18 fixture','')",(channel,))
        # Reverse insertion, tied timestamps and differences smaller than public millisecond time.
        for i in reversed(range(count)):
            db.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) VALUES(%s,%s,'system',%s,%s)",(ids[i],channel,str(i),moment+timedelta(microseconds=(i//3))))
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False)
    path='/api/v1/channels/'+channel+'/messages'
    with TestClient(app) as api:
        assert api.get(path,params={'limit':limit}).status_code==401
        api.cookies.set('openbot_session',fixture['token'])
        collected=[];before=None;deleted=False
        while True:
            params={'limit':limit}
            if before is not None: params['before']=before
            page=api.get(path,params=params);assert page.status_code==200,page.text
            value=page.json();messages=value['messages'];observed=[m['id'] for m in messages]
            assert observed==sorted(observed) and len(observed)<=limit
            assert all(m['channelId']==channel for m in messages)
            collected=observed+collected
            if not value['hasMore']:
                assert 'nextCursor' not in value
                break
            assert messages and value['nextCursor']
            before=value['nextCursor']
            if not deleted:
                # Returned anchor vanishes after the cursor was issued. Older pages still work.
                with psycopg.connect(fixture['dsn']) as db: db.execute('DELETE FROM messages WHERE id=%s',(observed[0],))
                deleted=True
        assert collected==ids and len(set(collected))==count
        earliest=encode_cursor(channel,dict(id=ids[0] if ids else 'missing',created_at=moment))
        assert api.get(path,params={'before':earliest,'limit':limit}).json()=={'messages':[],'hasMore':False}
        with psycopg.connect(fixture['dsn']) as db: db.execute('UPDATE channels SET deleted_at=now() WHERE id=%s',(channel,))
        assert api.get(path,params={'before':earliest,'limit':limit}).status_code==404


def test_c18_bad_queries_cursors_channel_binding_and_default_cap(fixture):
    from datetime import datetime,timezone
    from openbot_server.message_pagination import encode_cursor
    channel=next(path.split('/')[-2] for path in fixture['expected'] if path.endswith('/messages') and fixture['expected'][path]['messages'])
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False)
    path='/api/v1/channels/'+channel+'/messages'
    with TestClient(app) as api:
        api.cookies.set('openbot_session',fixture['token'])
        first=api.get(path).json();assert len(first['messages'])==100 and first['hasMore'] is True
        other=encode_cursor('other-channel',dict(id='synthetic-id',created_at=datetime(2026,1,1,tzinfo=timezone.utc)))
        for params in [('limit','0'),('limit','101'),('limit','-1'),('limit','1.0'),('limit','01'),('before',''),('before','bad!cursor'),('before','x'*2049),('before',other),('unknown','value')]:
            result=api.get(path,params=[params]);assert result.status_code==422,result.text
        for params in [[('limit','2'),('limit','3')],[('before',first['nextCursor']),('before',first['nextCursor'])]]:
            assert api.get(path,params=params).status_code==422


def test_c18_next_page_rechecks_session_after_read(fixture):
    issued=asyncio.run(authentication(fixture).login(fixture['ownerPassword'],'192.0.2.81'))
    digest=hashlib.sha256(issued.token.encode()).hexdigest()
    channel=next(path.split('/')[-2] for path in fixture['expected'] if path.endswith('/messages') and fixture['expected'][path]['messages'])
    first=asyncio.run(PostgresReadStore(fixture['dsn']).read(issued.token,'messages',channel_id=channel,limit=3))
    class Revoked(PostgresReadStore):
        calls=0
        async def _session(self,connection,value):
            self.calls+=1
            if self.calls==2:
                with psycopg.connect(fixture['dsn']) as db:db.execute('UPDATE auth_sessions SET revoked_at=now() WHERE token_digest=%s',(digest,))
            return await super()._session(connection,value)
    assert asyncio.run(Revoked(fixture['dsn']).read(issued.token,'messages',channel_id=channel,before=first.next_cursor,limit=3))==ReadResult(None)
