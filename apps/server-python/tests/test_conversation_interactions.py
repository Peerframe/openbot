"""Real Owner reaction and membership-revocation journeys in a disposable PostgreSQL fixture."""
import asyncio
from uuid import uuid4

import psycopg
import pytest
from pydantic import ValidationError

from openbot_server.authority import AuthenticationRequired
from openbot_server.conversation_interactions import PostgresConversationInteractions, REACTION_EMOJIS, parse_reaction, revoked_run_ids
from openbot_server.control_errors import ControlError
from test_automation_store import seed, synthetic_db


def message(seed):
    identity = str(uuid4())
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES (%s,%s,'human','Evidence')", (identity,seed["channel"]))
    return identity


def run(seed, *, bot=None, status="running", parent=None, root=None):
    identity = str(uuid4())
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status,parent_run_id,root_run_id,delegated_by_bot_id) VALUES (%s,%s,%s,'none','Full instruction','Review',%s,%s,%s,%s)",
                   (identity,seed["channel"],bot or seed["bot"],status,parent,root,seed["bot"] if parent else None))
    return identity


def test_reaction_catalog_is_exact_and_requires_boolean_without_extra_fields():
    for emoji in REACTION_EMOJIS:
        assert parse_reaction({"emoji":emoji,"active":True}).emoji == emoji
    for value in ({"emoji":"❤","active":True},{"emoji":"👍","active":1},{"emoji":"👍","active":True,"actor":"other"}):
        with pytest.raises(ValidationError):
            parse_reaction(value)
    active = [{"id":"leaf","bot_id":"b","parent_run_id":"child","root_run_id":None},
              {"id":"child","bot_id":"b","parent_run_id":"root","root_run_id":None},
              {"id":"root","bot_id":"a","parent_run_id":None,"root_run_id":None},
              {"id":"other","bot_id":"b","parent_run_id":None,"root_run_id":None}]
    assert set(revoked_run_ids(active,"a")) == {"root","child","leaf"}


def test_concurrent_reaction_toggle_is_idempotent_and_channel_scoped(seed):
    identity = message(seed)
    async def check():
        store = PostgresConversationInteractions(seed["dsn"])
        result = await asyncio.gather(*(store.set_reaction(seed["token"],seed["channel"],identity,{"emoji":"👍","active":True}) for _ in range(8)))
        assert all(value == [{"messageId":identity,"emoji":"👍","actor":"owner"}] for value in result)
        assert await store.list_reactions(seed["token"],seed["channel"]) == result[0]
        with pytest.raises(ControlError) as error:
            await store.set_reaction(seed["token"],str(uuid4()),identity,{"emoji":"👍","active":True})
        assert error.value.status == 404
        assert await store.set_reaction(seed["token"],seed["channel"],identity,{"emoji":"👍","active":False}) == []
        assert await store.set_reaction(seed["token"],seed["channel"],identity,{"emoji":"👍","active":False}) == []
    asyncio.run(check())
    with psycopg.connect(seed["dsn"]) as db:
        assert db.execute("SELECT count(*) FROM run_events WHERE channel_id=%s AND type='MESSAGE_REACTION_CHANGED'", (seed["channel"],)).fetchone() == (2,)


def test_reactions_only_include_latest_hundred_messages(seed):
    old = message(seed)
    store = PostgresConversationInteractions(seed["dsn"])
    asyncio.run(store.set_reaction(seed["token"],seed["channel"],old,{"emoji":"👀","active":True}))
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("INSERT INTO messages(id,channel_id,author_type,content,created_at) SELECT md5(%s||i::text),%s,'human','Recent',now()+i*interval '1 second' FROM generate_series(1,100) i", (str(uuid4()),seed["channel"]))
    assert asyncio.run(store.list_reactions(seed["token"],seed["channel"])) == []


def test_remove_member_cancels_descendants_and_expires_only_their_pending_approvals(seed):
    root = run(seed,status="waiting_approval")
    child = run(seed,bot=seed["peer"],parent=root,root=root)
    other = run(seed,bot=seed["peer"])
    done = run(seed,status="completed")
    node = str(uuid4())
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("INSERT INTO nodes(id,name,platform,status,capabilities) VALUES (%s,'Fixture node','linux','offline','[]')", (node,))
        for identity,status in ((root,"pending"),(child,"approved"),(other,"pending")):
            db.execute("INSERT INTO approvals(id,run_id,node_id,action,target,summary,risk,target_fingerprint,status,expires_at) VALUES (%s,%s,%s,'write','target','Review','write',%s,%s,now()+interval '1 hour')",
                       (str(uuid4()),identity,node,"a"*64,status))
    try:
        result = asyncio.run(PostgresConversationInteractions(seed["dsn"]).remove_member(seed["token"],seed["channel"],seed["bot"]))
        assert result["channel"]["botIds"] == [seed["peer"]]
        assert result["channel"]["description"] == "Group description"
        assert {row["id"] for row in result["cancelledRuns"]} == {root,child}
        assert all(row["status"] == "cancelled" and row["instruction"] == "Full instruction" for row in result["cancelledRuns"])
        child_projection = next(row for row in result["cancelledRuns"] if row["id"] == child)
        assert child_projection["parentRunId"] == root == child_projection["rootRunId"]
        again = asyncio.run(PostgresConversationInteractions(seed["dsn"]).remove_member(seed["token"],seed["channel"],seed["bot"]))
        assert again["cancelledRuns"] == []
        with psycopg.connect(seed["dsn"]) as db:
            states = dict(db.execute("SELECT run_id,status FROM approvals WHERE node_id=%s", (node,)).fetchall())
            assert states == {root:"expired",child:"approved",other:"pending"}
            assert db.execute("SELECT status FROM runs WHERE id=%s", (done,)).fetchone() == ("completed",)
            events = db.execute("SELECT type,payload FROM run_events WHERE channel_id=%s", (seed["channel"],)).fetchall()
            assert len(events) == 3
            removed = next(payload for kind,payload in events if kind == "BOT_REMOVED_FROM_CHANNEL")
            assert set(removed["cancelledRunIds"]) == {root,child}
    finally:
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("DELETE FROM approvals WHERE node_id=%s", (node,))
            db.execute("DELETE FROM nodes WHERE id=%s", (node,))


def test_direct_channel_missing_channel_and_unauthenticated_calls_are_refused(seed):
    store = PostgresConversationInteractions(seed["dsn"])
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("UPDATE channels SET direct_bot_id=%s WHERE id=%s", (seed["bot"],seed["channel"]))
    async def check():
        with pytest.raises(ControlError) as error:
            await store.remove_member(seed["token"],seed["channel"],seed["bot"])
        assert (error.value.status,error.value.code) == (409,"direct_channel_membership_immutable")
        with pytest.raises(ControlError) as error:
            await store.remove_member(seed["token"],str(uuid4()),seed["bot"])
        assert error.value.status == 404
        for operation in (store.list_reactions(None,seed["channel"]),store.remove_member(None,seed["channel"],seed["bot"]),
                          store.set_reaction(None,seed["channel"],str(uuid4()),{"emoji":"👍","active":True})):
            with pytest.raises(AuthenticationRequired):
                await operation
    asyncio.run(check())


def test_reaction_and_removal_audit_failure_roll_back_all_mutations(seed):
    identity = message(seed)
    active = run(seed)
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("CREATE FUNCTION interaction_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type IN ('MESSAGE_REACTION_CHANGED','BOT_REMOVED_FROM_CHANNEL') THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$")
        db.execute("CREATE TRIGGER interaction_test_reject BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION interaction_test_reject()")
    try:
        async def check():
            store = PostgresConversationInteractions(seed["dsn"])
            for operation in (store.set_reaction(seed["token"],seed["channel"],identity,{"emoji":"👍","active":True}),
                              store.remove_member(seed["token"],seed["channel"],seed["bot"])):
                with pytest.raises(ControlError) as error:
                    await operation
                assert error.value.status == 503 and "synthetic" not in error.value.code
        asyncio.run(check())
        with psycopg.connect(seed["dsn"]) as db:
            assert db.execute("SELECT status FROM runs WHERE id=%s", (active,)).fetchone() == ("running",)
            assert db.execute("SELECT count(*) FROM channel_bots WHERE channel_id=%s", (seed["channel"],)).fetchone() == (2,)
            assert db.execute("SELECT count(*) FROM message_reactions WHERE channel_id=%s", (seed["channel"],)).fetchone() == (0,)
            assert db.execute("SELECT count(*) FROM run_events WHERE channel_id=%s", (seed["channel"],)).fetchone() == (0,)
    finally:
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("DROP TRIGGER interaction_test_reject ON run_events")
            db.execute("DROP FUNCTION interaction_test_reject()")


def test_active_run_and_projection_bounds_refuse_without_releasing_membership(seed):
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) SELECT md5(%s||i::text),%s,%s,'none','Review','Review','queued' FROM generate_series(1,1001) i", (str(uuid4()),seed["channel"],seed["bot"]))
    with pytest.raises(ControlError) as error:
        asyncio.run(PostgresConversationInteractions(seed["dsn"]).remove_member(seed["token"],seed["channel"],seed["bot"]))
    assert (error.value.status,error.value.code) == (409,"too_many_active_tasks")
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("DELETE FROM runs WHERE channel_id=%s", (seed["channel"],))
    active = run(seed)
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("UPDATE runs SET instruction=repeat('x',4194305) WHERE id=%s", (active,))
    with pytest.raises(ControlError) as error:
        asyncio.run(PostgresConversationInteractions(seed["dsn"]).remove_member(seed["token"],seed["channel"],seed["bot"]))
    assert error.value.status == 503
    with psycopg.connect(seed["dsn"]) as db:
        assert db.execute("SELECT status FROM runs WHERE id=%s", (active,)).fetchone() == ("running",)
        assert db.execute("SELECT count(*) FROM channel_bots WHERE channel_id=%s", (seed["channel"],)).fetchone() == (2,)
